import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rebindAdCreative } from './url-tags.js';

/**
 * rebindAdCreative must fail closed when it cannot read the current creative's
 * placement rules (asset_customization_rules).
 *
 * The incident (2026-05-14): headline edits went through create-then-rebind on
 * a live ad whose images were customized by placement. The new creative carried
 * only the base image, the rebind POST succeeded, and every per-placement image
 * rule was gone. Nothing errored. The rule check added after that (commit
 * 38b49f1) compares old and new rules, but it read a FAILED read as "no rules"
 * (the fetch swallowed the error and returned []), so a permission error, a
 * rate limit or a network blip on the old creative let the same drop through.
 *
 * A successful read that finds no rules is different and must still rebind:
 * Dynamic Creative Optimization (DCO) and plain single-image creatives often
 * return no asset_feed_spec, or one without asset_customization_rules.
 *
 * Containment: url-tags.ts reaches Meta only through lib/graph.ts, which only
 * calls global fetch. Every test replaces fetch with a routed fake, and the
 * beforeEach default throws, so a test without a route fails instead of
 * reaching graph.facebook.com. All ids and tokens are fakes.
 */

interface Call {
  method: string;
  path: string;
  fields?: string;
  form: Record<string, string>;
}

/** What a route returns: a Graph body (200), a Graph error, raw HTTP, or a thrown network error. */
type Reply =
  | { body: unknown }
  | { graphError: { message: string; code: number }; status?: number }
  | { raw: string; status: number }
  | { networkError: string };

function fakeGraph(route: (c: Call) => Reply) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const u = new URL(String(input));
      const call: Call = {
        method: init?.method ?? 'GET',
        path: u.pathname.replace(/^\/v\d+\.0\//, ''),
        fields: u.searchParams.get('fields') ?? undefined,
        form: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {},
      };
      calls.push(call);
      const r = route(call);
      if ('networkError' in r) throw new TypeError(r.networkError);
      if ('raw' in r) return new Response(r.raw, { status: r.status, headers: { 'content-type': 'text/html' } });
      if ('graphError' in r) {
        return new Response(JSON.stringify({ error: r.graphError }), { status: r.status ?? 400 });
      }
      return new Response(JSON.stringify(r.body), { status: 200 });
    }),
  );
  return calls;
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === 'POST');

const TOKEN = 'fake-token';
const AD = 'ad_1';
const OLD = 'cr_old';
const NEW = 'cr_new';

// Four per-placement image rules, the shape the incident ad carried.
const PLACEMENT_RULES = [
  { customization_spec: { publisher_platforms: ['facebook'], facebook_positions: ['feed'] }, image_label: { name: 'fb_feed' } },
  { customization_spec: { publisher_platforms: ['facebook'], facebook_positions: ['story'] }, image_label: { name: 'fb_story' } },
  { customization_spec: { publisher_platforms: ['instagram'], instagram_positions: ['stream'] }, image_label: { name: 'ig_feed' } },
  { customization_spec: { publisher_platforms: ['instagram'], instagram_positions: ['story', 'reels'] }, image_label: { name: 'ig_story' } },
];

const RULES_FIELDS = 'asset_feed_spec{asset_customization_rules}';

/**
 * A live ad on OLD, being rebound to NEW. `oldRead` and `newRead` are what the
 * two rule reads return; the ad read and the rebind POST always succeed.
 */
function world(oldRead: Reply, newRead: Reply, adBody: unknown = { id: AD, name: 'Feed ad', creative: { id: OLD } }) {
  return fakeGraph((c) => {
    if (c.method === 'GET' && c.path === AD) return { body: adBody };
    if (c.method === 'GET' && c.path === OLD && c.fields === RULES_FIELDS) return oldRead;
    if (c.method === 'GET' && c.path === NEW && c.fields === RULES_FIELDS) return newRead;
    if (c.method === 'POST' && c.path === AD) return { body: { success: true } };
    return { graphError: { message: `unrouted ${c.method} ${c.path} fields=${c.fields}`, code: 100 } };
  });
}

const rules = (r: unknown[]): Reply => ({ body: { id: 'x', asset_feed_spec: { asset_customization_rules: r } } });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('unexpected network call: no fake Graph installed');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('rebindAdCreative fails closed when the current creative’s placement rules cannot be read', () => {
  // The ways a real read fails: Graph errors (permission, rate limit,
  // transient), an error body on HTTP 200, a non-JSON gateway page, and a
  // dropped connection.
  const failedReads: Array<[string, Reply, RegExp]> = [
    ['permission denied (code 10)', { graphError: { message: 'Application does not have permission for this action', code: 10 } }, /does not have permission/],
    ['rate limited (code 17)', { graphError: { message: 'User request limit reached', code: 17 } }, /User request limit reached/],
    ['transient Graph error (code 2)', { graphError: { message: 'Service temporarily unavailable', code: 2 }, status: 500 }, /temporarily unavailable/],
    ['error body on HTTP 200', { graphError: { message: 'An unknown error occurred', code: 1 }, status: 200 }, /unknown error/],
    ['non-JSON 502 gateway page', { raw: '<html>502 Bad Gateway</html>', status: 502 }, /not valid JSON|Unexpected token/],
    ['network error', { networkError: 'fetch failed' }, /fetch failed/],
  ];

  it.each(failedReads)('%s on the old creative: refuses and sends no POST', async (_label, oldRead, cause) => {
    // The incident's new creative: base image only, no placement rules.
    const calls = world(oldRead, rules([]));

    const err = await rebindAdCreative(AD, NEW, TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/^Refusing to rebind ad ad_1: could not read the placement rules \(asset_customization_rules\) on its current creative cr_old/);
    expect(err!.message).toMatch(cause); // the underlying read error is passed through
    expect(err!.message).toMatch(/Nothing was changed/);
    expect(err!.message).toMatch(/force=true/); // says what to do
    expect(posts(calls)).toEqual([]);
  });

  it('the incident case: old read fails, new creative has none, the rebind does not go ahead', async () => {
    const calls = world({ graphError: { message: 'Please reduce the amount of data you are asking for', code: 1 } }, rules([]));

    await expect(rebindAdCreative(AD, NEW, TOKEN, false)).rejects.toThrow(/could not read the placement rules/);
    expect(posts(calls)).toEqual([]);
  });

  it('refuses when the ad read returns no current creative, without reading any rules', async () => {
    const calls = world(rules(PLACEMENT_RULES), rules([]), { id: AD, name: 'Feed ad' });

    await expect(rebindAdCreative(AD, NEW, TOKEN, false)).rejects.toThrow(
      /^Refusing to rebind ad ad_1: the ad read returned no current creative.*force=true/s,
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${AD}`]);
  });

  it('refuses with the real reason when the old creative has rules and the new creative’s read fails', async () => {
    const calls = world(rules(PLACEMENT_RULES), { graphError: { message: 'Unsupported get request', code: 100 } });

    const err = await rebindAdCreative(AD, NEW, TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err!.message).toMatch(/^Refusing to rebind ad ad_1: current creative cr_old has 4 asset_customization_rules/);
    expect(err!.message).toMatch(/could not read the rules on new creative cr_new/);
    expect(err!.message).toMatch(/Unsupported get request/);
    expect(err!.message).not.toMatch(/has none/); // a failed read is not "none"
    expect(posts(calls)).toEqual([]);
  });

  it('force=true still overrides, after the read failure has been checked by hand', async () => {
    const calls = world({ graphError: { message: 'permission denied', code: 10 } }, rules([]));

    const r = await rebindAdCreative(AD, NEW, TOKEN, false, true);

    expect(posts(calls).map((c) => JSON.parse(c.form.creative))).toEqual([{ creative_id: NEW }]);
    expect(r.changed).toBe(true);
  });
});

describe('rebindAdCreative still rebinds when the read succeeds and finds no rules', () => {
  // DCO and single-image creatives: a successful read with nothing to drop.
  const emptyReads: Array<[string, Reply]> = [
    ['no asset_feed_spec at all', { body: { id: OLD } }],
    ['asset_feed_spec without asset_customization_rules', { body: { id: OLD, asset_feed_spec: {} } }],
    ['an empty asset_customization_rules array', rules([])],
  ];

  it.each(emptyReads)('%s: rebinds once and reports nothing to preserve', async (_label, oldRead) => {
    const calls = world(oldRead, rules([]));

    const r = await rebindAdCreative(AD, NEW, TOKEN, false);

    expect(posts(calls).map((c) => ({ path: c.path, creative: JSON.parse(c.form.creative) }))).toEqual([
      { path: AD, creative: { creative_id: NEW } },
    ]);
    expect(r).toEqual({
      ad_id: AD,
      ad_name: 'Feed ad',
      previous_creative_id: OLD,
      new_creative_id: NEW,
      changed: true,
      customization_rules_preserved: null,
    });
  });

  it('old creative has no rules and the new creative’s read fails: nothing can be dropped, so it rebinds', async () => {
    const calls = world({ body: { id: OLD } }, { graphError: { message: 'permission denied', code: 10 } });

    const r = await rebindAdCreative(AD, NEW, TOKEN, false);

    expect(posts(calls)).toHaveLength(1);
    expect(r).toMatchObject({ changed: true, customization_rules_preserved: null });
  });

  it('old and new both carry the rules: rebinds and reports them preserved', async () => {
    const calls = world(rules(PLACEMENT_RULES), rules(PLACEMENT_RULES));

    const r = await rebindAdCreative(AD, NEW, TOKEN, false);

    expect(posts(calls)).toHaveLength(1);
    expect(r).toMatchObject({ changed: true, customization_rules_preserved: true });
  });
});
