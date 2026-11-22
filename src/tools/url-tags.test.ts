import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  editCreativeText,
  getAdUrlTags,
  listAdsInCampaign,
  rebindAdCreative,
  renameAd,
  swapAdLeadForm,
  updateAdUrlTags,
} from './url-tags.js';

/**
 * Regression test for the 2026-05-14 placement-rule incident (commit 38b49f1).
 *
 * Production bug class: meta_ads_create_ad_creative + meta_ads_rebind_ad_creative
 * was used to swap a creative on a live ad. The OLD creative had 4
 * asset_customization_rules (per-placement image rules set in Ads Manager UI).
 * The NEW creative — built programmatically — carried none. The rebind POST
 * succeeded silently, and every custom placement-by-image collapsed to the
 * default image. No error, no warning, just degraded delivery for the duration.
 *
 * The safety check in rebindAdCreative refuses the rebind when old rules > 0
 * and new rules === 0, unless force=true. This test pins that defense.
 */

interface CapturedCall {
  url: string;
  method: string;
}

function setupFetchMock(handler: (url: string) => unknown) {
  const calls: CapturedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const body = handler(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

const TOKEN = 'TT';
const AD_ID = 'ad_100000000000000001';
const OLD_CREATIVE_ID = 'cr_old_with_rules';
const NEW_CREATIVE_ID = 'cr_new_no_rules';

describe('rebindAdCreative — asset_customization_rules safety check', () => {
  it('refuses rebind when old creative has rules and new creative has none', async () => {
    const { calls } = setupFetchMock((url) => {
      if (url.includes(`/${AD_ID}?`) || url.endsWith(`/${AD_ID}`)) {
        return { id: AD_ID, name: 'Example ad — headline test', creative: { id: OLD_CREATIVE_ID } };
      }
      if (url.includes(`/${OLD_CREATIVE_ID}`)) {
        return {
          asset_feed_spec: {
            asset_customization_rules: [
              { customization_spec: { publisher_platforms: ['facebook'] }, image_label: { name: 'a' } },
              { customization_spec: { publisher_platforms: ['instagram'] }, image_label: { name: 'b' } },
              { customization_spec: { positions: ['feed'] }, image_label: { name: 'c' } },
              { customization_spec: { positions: ['story'] }, image_label: { name: 'd' } },
            ],
          },
        };
      }
      if (url.includes(`/${NEW_CREATIVE_ID}`)) {
        return { asset_feed_spec: { asset_customization_rules: [] } };
      }
      return {};
    });

    await expect(
      rebindAdCreative(AD_ID, NEW_CREATIVE_ID, TOKEN, /* dryRun */ false, /* force */ false),
    ).rejects.toThrow(
      /Refusing to rebind ad ad_100000000000000001: previous creative cr_old_with_rules has 4 asset_customization_rules.*new creative cr_new_no_rules has none/s,
    );

    // Critical: the rebind POST must NOT have fired. Only the three GETs
    // (ad read + two creative reads) should be on the wire. If a POST slipped
    // through, the production data corruption already happened.
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Routed Graph mock for the rest of the file                                */
/* ------------------------------------------------------------------------- */
/*
 * Containment: url-tags.ts reaches Meta only through lib/graph.ts, which only
 * calls global fetch. Every test below replaces fetch with a recorder, and the
 * beforeEach default throws, so a test that forgets its mock fails instead of
 * reaching graph.facebook.com. All ids and tokens are fakes.
 */

interface GraphCall {
  method: string;
  path: string;
  query: Record<string, string>;
  form: Record<string, string>;
}

class GraphFail {
  constructor(public message: string, public code = 100) {}
}

type Reply = unknown | GraphFail;

function graphMock(handler: (c: GraphCall) => Reply) {
  const calls: GraphCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const u = new URL(String(input));
      const call: GraphCall = {
        method: init?.method ?? 'GET',
        path: u.pathname.replace(/^\/v\d+\.0\//, ''),
        query: Object.fromEntries(u.searchParams),
        form: init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {},
      };
      calls.push(call);
      const out = handler(call);
      if (out instanceof GraphFail) {
        return new Response(JSON.stringify({ error: { message: out.message, code: out.code } }), { status: 400 });
      }
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }),
  );
  return calls;
}

const posts = (calls: GraphCall[]) => calls.filter((c) => c.method === 'POST');
const json = (s: string | undefined) => JSON.parse(s ?? 'null');

/** The fields rebindAdCreative's placement-rule check reads on each creative. */
const RULE_READ = 'asset_feed_spec{asset_customization_rules}';
const ruleReads = (calls: GraphCall[]) =>
  calls.filter((c) => c.method === 'GET' && c.query.fields === RULE_READ).map((c) => c.path).sort();
/** A rule read's reply: the rules, or the GraphFail a failed read returns. */
const ruleReply = (id: string, r: unknown[] | GraphFail) =>
  r instanceof GraphFail ? r : { id, asset_feed_spec: { asset_customization_rules: r } };

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('unexpected network call: no Graph mock installed');
    }),
  );
});

/* ------------------------------------------------------------------------- */
/* listAdsInCampaign                                                         */
/* ------------------------------------------------------------------------- */

describe('listAdsInCampaign', () => {
  it('follows cursors only while paging.next is present, then stops', async () => {
    const calls = graphMock((c) => {
      if (c.query.after === undefined) {
        return {
          data: [{ id: 'ad_1', name: 'One', status: 'ACTIVE', campaign_id: 'c_1', creative: { id: 'cr_1' } }],
          paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/next' },
        };
      }
      // Meta still returns cursors on the last page; only `next` is absent.
      return {
        data: [{ id: 'ad_2', name: 'Two', status: 'PAUSED', campaign_id: 'c_1' }],
        paging: { cursors: { after: 'CUR2' } },
      };
    });

    const ads = await listAdsInCampaign('c_1', TOKEN);

    expect(calls.map((c) => [c.path, c.query.after])).toEqual([
      ['c_1/ads', undefined],
      ['c_1/ads', 'CUR1'],
    ]);
    expect(ads.map((a) => [a.id, a.creative_id])).toEqual([
      ['ad_1', 'cr_1'],
      ['ad_2', ''],
    ]);
  });
});

/* ------------------------------------------------------------------------- */
/* getAdUrlTags / updateAdUrlTags                                            */
/* ------------------------------------------------------------------------- */

interface UrlTagsWorld {
  creativeId: string;
  urlTags: string | undefined;
  objectStoryId?: string;
  effectiveObjectStoryId?: string;
  accountId?: string;
  learningTs?: number;
  learningTsAfterRebind?: number;
  failLearning?: boolean;
  /** The current creative's placement rules as the rule check reads them; a GraphFail is a failed read. Default: none. */
  oldRules?: unknown[] | GraphFail;
  /** What that read returns once the new creative exists, if different. */
  oldRulesAfterCreate?: unknown[] | GraphFail;
  /** The rebind POST fails with this Graph error. */
  rebindError?: GraphFail;
}

function urlTagsMock(world: UrlTagsWorld) {
  let created = false;
  let rebound = false;
  const calls = graphMock((c) => {
    if (c.method === 'GET' && c.query.fields === RULE_READ) {
      if (c.path === world.creativeId) {
        const rules = created && world.oldRulesAfterCreate !== undefined ? world.oldRulesAfterCreate : world.oldRules;
        return ruleReply(c.path, rules ?? []);
      }
      // The new creative is built from the Page post and url_tags alone, so it has no asset_feed_spec.
      if (c.path === 'cr_new') return { id: 'cr_new' };
    }
    if (c.method === 'GET' && c.path === 'ad_1') {
      return {
        id: 'ad_1',
        name: 'Spring promo',
        account_id: world.accountId,
        campaign_id: 'c_1',
        adset_id: 'as_1',
        campaign: { id: 'c_1', name: 'Test campaign' },
        creative: rebound
          ? { id: 'cr_new', url_tags: 'utm_source=new', object_story_id: world.objectStoryId }
          : {
              id: world.creativeId,
              url_tags: world.urlTags,
              object_story_id: world.objectStoryId,
              effective_object_story_id: world.effectiveObjectStoryId,
              object_story_spec: { link_data: { link: 'https://example.test/landing' } },
            },
      };
    }
    if (c.method === 'GET' && c.path === 'as_1') {
      if (world.failLearning) return new GraphFail('learning_stage_info not available');
      const ts = rebound && world.learningTsAfterRebind !== undefined ? world.learningTsAfterRebind : world.learningTs;
      return { learning_stage_info: { status: 'SUCCESS', last_significant_edit_ts: ts } };
    }
    if (c.method === 'POST' && c.path.endsWith('/adcreatives')) {
      created = true;
      return { id: 'cr_new' };
    }
    if (c.method === 'POST' && c.path === 'ad_1') {
      if (world.rebindError) return world.rebindError;
      rebound = true;
      return { success: true };
    }
    return new GraphFail(`unrouted ${c.method} ${c.path}`);
  });
  return calls;
}

describe('getAdUrlTags', () => {
  it('falls back to the video CTA link and to effective_object_story_id', async () => {
    graphMock((c) => {
      if (c.path === 'ad_9') {
        return {
          id: 'ad_9',
          name: 'Video ad',
          account_id: '111',
          campaign_id: 'c_1',
          creative: {
            id: 'cr_9',
            effective_object_story_id: 'page_1_post_9',
            object_story_spec: { video_data: { call_to_action: { value: { link: 'https://example.test/video' } } } },
          },
        };
      }
      return new GraphFail('unrouted');
    });

    const info = await getAdUrlTags('ad_9', TOKEN);

    expect(info.link).toBe('https://example.test/video');
    expect(info.object_story_id).toBe('page_1_post_9');
    expect(info.url_tags).toBeNull();
    expect(info.learning_stage_info).toBeNull();
  });

  it('skips the ad set read when the ad has no adset_id', async () => {
    const calls = graphMock(() => ({ id: 'ad_9', name: 'n', campaign_id: 'c_1', creative: { id: 'cr_9' } }));

    await getAdUrlTags('ad_9', TOKEN);

    expect(calls.map((c) => c.path)).toEqual(['ad_9']);
  });
});

describe('updateAdUrlTags', () => {
  const base: UrlTagsWorld = {
    creativeId: 'cr_old',
    urlTags: 'utm_source=old',
    objectStoryId: 'page_1_post_1',
    accountId: '111',
    learningTs: 1_000,
  };

  it('dry run reports the change and sends no POST', async () => {
    const calls = urlTagsMock(base);

    const r = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, true);

    expect(posts(calls)).toEqual([]);
    expect(r).toMatchObject({
      previous_url_tags: 'utm_source=old',
      new_url_tags: 'utm_source=new',
      previous_creative_id: 'cr_old',
      new_creative_id: '',
      changed: true,
      learning_after: null,
      significant_edit_triggered: null,
      would_refuse: null,
    });
    // The dry run ran the placement-rule check on the current creative.
    expect(ruleReads(calls)).toEqual(['cr_old']);
  });

  /**
   * The placement-rule check runs before the create, so a refused call leaves
   * no unattached creative behind, and a dry run can report the refusal. Each
   * world runs the real call and the dry run against the same fake Graph: the
   * dry run's would_refuse must be the exact message the real call throws.
   */
  const urlTagsRefusals: Array<[string, Partial<UrlTagsWorld>, RegExp]> = [
    [
      'the current creative has placement rules the new creative would not carry',
      { oldRules: RULES },
      /^Refusing to rebind ad ad_1: current creative cr_old has 2 asset_customization_rules.*the new creative this call would create carries none/s,
    ],
    [
      'the current creative’s placement rules cannot be read',
      { oldRules: new GraphFail('Application does not have permission for this action', 10) },
      /^Refusing to rebind ad ad_1: could not read the placement rules.*does not have permission/s,
    ],
  ];

  it.each(urlTagsRefusals)('%s: the real call refuses before creating anything', async (_label, w, refusal) => {
    const calls = urlTagsMock({ ...base, ...w });

    const err = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toMatch(refusal);
    expect(err?.message).toMatch(/Nothing was created or changed/);
    expect(err?.message).not.toMatch(/created by this call/);
    // No create POST, so no creative is left unattached; no rebind POST either.
    expect(posts(calls)).toEqual([]);
    expect(ruleReads(calls)).toEqual(['cr_old']);
  });

  it.each(urlTagsRefusals)('%s: the dry run returns that refusal as would_refuse and sends no POST', async (_label, w) => {
    urlTagsMock({ ...base, ...w });
    const real = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(real?.message).toMatch(/^Refusing to rebind ad ad_1: /);

    const calls = urlTagsMock({ ...base, ...w });
    const r = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, true);

    expect(r).toMatchObject({ changed: true, new_creative_id: '', would_refuse: real!.message });
    expect(posts(calls)).toEqual([]);
  });

  it('dry run when the url_tags already match: nothing to check, nothing to refuse', async () => {
    const calls = urlTagsMock({ ...base, oldRules: RULES });

    const r = await updateAdUrlTags('ad_1', 'utm_source=old', TOKEN, true);

    expect(r).toMatchObject({ changed: false, would_refuse: null });
    expect(ruleReads(calls)).toEqual([]);
    expect(posts(calls)).toEqual([]);
  });

  it('sends no POST when the url_tags already match', async () => {
    const calls = urlTagsMock(base);

    const r = await updateAdUrlTags('ad_1', 'utm_source=old', TOKEN, false);

    expect(posts(calls)).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r.new_creative_id).toBe('cr_old');
    expect(r).not.toHaveProperty('would_refuse'); // real runs never carry it
  });

  it('refuses before any POST when the creative has no Page-post reference', async () => {
    const calls = urlTagsMock({ ...base, objectStoryId: undefined });

    await expect(updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false)).rejects.toThrow(/has no object_story_id/);
    expect(posts(calls)).toEqual([]);
  });

  it('refuses before any POST when the ad read has no account_id', async () => {
    const calls = urlTagsMock({ ...base, accountId: undefined });

    await expect(updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false)).rejects.toThrow(/did not return account_id/);
    expect(posts(calls)).toEqual([]);
  });

  it('creates a creative on the same Page post with the new tags, then rebinds the ad to it', async () => {
    const calls = urlTagsMock(base);

    const r = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false);

    const [create, rebind, ...rest] = posts(calls);
    expect(rest).toEqual([]);
    expect(create?.path).toBe('act_111/adcreatives');
    expect(create?.form.object_story_id).toBe('page_1_post_1');
    expect(create?.form.url_tags).toBe('utm_source=new');
    expect(rebind?.path).toBe('ad_1');
    expect(json(rebind?.form.creative)).toEqual({ creative_id: 'cr_new' });
    expect(r).toMatchObject({
      previous_creative_id: 'cr_old',
      new_creative_id: 'cr_new',
      previous_url_tags: 'utm_source=old',
      new_url_tags: 'utm_source=new',
      changed: true,
      significant_edit_triggered: false,
    });
    expect(r).not.toHaveProperty('would_refuse'); // real runs never carry it
    // The current creative's rules were checked before the create, and the
    // rebind then ran the full check on both creatives before the ad moved.
    expect(ruleReads(calls)).toEqual(['cr_new', 'cr_old', 'cr_old']);
    const firstRuleRead = calls.findIndex((c) => c.query.fields === RULE_READ);
    expect(calls[firstRuleRead]?.path).toBe('cr_old');
    expect(firstRuleRead).toBeLessThan(calls.indexOf(create!));
    const lastRuleRead = Math.max(...calls.flatMap((c, i) => (c.query.fields === RULE_READ ? [i] : [])));
    expect(calls.indexOf(rebind!)).toBeGreaterThan(lastRuleRead);
  });

  it('if the rules read fails after the create, the rebind still refuses and names the creative left behind', async () => {
    // The pre-create check passed; the rebind's own check then could not read
    // the rules. That race is the one way a refusal can still follow a create.
    const calls = urlTagsMock({ ...base, oldRulesAfterCreate: new GraphFail('Service temporarily unavailable', 2) });

    const err = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toMatch(/^Refusing to rebind ad ad_1: could not read the placement rules.*temporarily unavailable/s);
    // This tool has no force option, so the refusal names the creative it left behind and the tool that can attach it.
    expect(err?.message).toMatch(/creative cr_new, created by this call, is not attached to ad ad_1/);
    expect(err?.message).toMatch(/meta_ads_rebind_ad_creative with ad_id=ad_1, creative_id=cr_new and force=true/);
    expect(posts(calls).map((c) => c.path)).toEqual(['act_111/adcreatives']);
  });

  it('a Graph error on the rebind POST passes through as is, without the refusal note', async () => {
    urlTagsMock({ ...base, rebindError: new GraphFail('Ad is under review', 2) });

    const err = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toMatch(/^Meta Graph POST ad_1 failed: Ad is under review/);
    expect(err?.message).not.toMatch(/created by this call/);
  });

  it('uses effective_object_story_id when object_story_id is absent', async () => {
    const calls = urlTagsMock({ ...base, objectStoryId: undefined, effectiveObjectStoryId: 'page_1_post_7' });

    await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false);

    expect(posts(calls)[0]?.form.object_story_id).toBe('page_1_post_7');
  });

  it('flags a significant edit when last_significant_edit_ts advances after the rebind', async () => {
    urlTagsMock({ ...base, learningTsAfterRebind: 2_000 });

    const r = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false);

    expect(r.significant_edit_triggered).toBe(true);
  });

  it('reports significant_edit_triggered as unknown when learning info cannot be read', async () => {
    urlTagsMock({ ...base, failLearning: true });

    const r = await updateAdUrlTags('ad_1', 'utm_source=new', TOKEN, false);

    expect(r.significant_edit_triggered).toBeNull();
    expect(r.learning_before).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */
/* swapAdLeadForm                                                            */
/* ------------------------------------------------------------------------- */

const RULES = [
  { customization_spec: { publisher_platforms: ['facebook'] }, image_label: { name: 'fb' } },
  { customization_spec: { publisher_platforms: ['instagram'] }, image_label: { name: 'ig' } },
];

function assetFeedCreative() {
  return {
    id: 'cr_old',
    name: 'Old creative',
    url_tags: 'utm_source=meta',
    object_story_spec: { page_id: 'page_1', instagram_actor_id: 'ig_1' },
    asset_feed_spec: {
      images: [{ hash: 'h1' }, { hash: 'h2' }],
      bodies: [{ text: 'Body A' }, { text: 'Body B' }],
      titles: [{ text: 'Title A' }],
      descriptions: [{ text: 'Desc A' }],
      link_urls: [{ website_url: 'https://example.test/' }],
      call_to_action_types: ['LEARN_MORE'],
      call_to_actions: [{ type: 'LEARN_MORE', value: { lead_gen_form_id: 'form_old' } }],
      ad_formats: ['AUTOMATIC_FORMAT'],
      asset_customization_rules: RULES,
    },
  };
}

function legacyCreative(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cr_old',
    object_story_spec: {
      page_id: 'page_1',
      link_data: {
        link: 'https://example.test/',
        message: 'Primary text',
        name: 'Headline',
        description: 'Description',
        image_hash: 'h1',
        call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: 'form_old' } },
        ...overrides,
      },
    },
  };
}

/**
 * The rule check's reads: by default the current creative's rules are the ones
 * on `creative`, and the new creative's are whatever the create POST carried.
 * `oldRules` / `newRules` override them (a GraphFail is a failed read).
 */
function swapMock(
  creative: unknown,
  accountId = '111',
  reads: { oldRules?: unknown[] | GraphFail; newRules?: unknown[] } = {},
) {
  let createdSpec: { asset_customization_rules?: unknown[] } | null = null;
  return graphMock((c) => {
    if (c.method === 'GET' && c.query.fields === RULE_READ) {
      const stored = (creative as { asset_feed_spec?: { asset_customization_rules?: unknown[] } }).asset_feed_spec;
      if (c.path === 'cr_old') return ruleReply(c.path, reads.oldRules ?? stored?.asset_customization_rules ?? []);
      if (c.path === 'cr_new') return ruleReply(c.path, reads.newRules ?? createdSpec?.asset_customization_rules ?? []);
    }
    if (c.method === 'GET' && c.path === 'ad_1') return { id: 'ad_1', name: 'Lead ad', account_id: accountId, creative };
    if (c.method === 'POST' && c.path.endsWith('/adcreatives')) {
      createdSpec = json(c.form.asset_feed_spec);
      return { id: 'cr_new' };
    }
    if (c.method === 'POST' && c.path === 'ad_1') return { success: true };
    return new GraphFail(`unrouted ${c.method} ${c.path}`);
  });
}

/**
 * A creative whose images are customized by placement but whose asset_feed_spec
 * has no bodies, so the swap rebuilds it as a legacy link_data creative, which
 * carries no asset_customization_rules.
 */
function bodilessRulesCreative() {
  return {
    ...legacyCreative(),
    asset_feed_spec: { images: [{ hash: 'h1' }, { hash: 'h2' }], asset_customization_rules: RULES },
  };
}

describe('swapAdLeadForm', () => {
  it('dry run reports the swap and sends no POST', async () => {
    const calls = swapMock(assetFeedCreative());

    const r = await swapAdLeadForm('ad_1', 'form_new', TOKEN, true);

    expect(posts(calls)).toEqual([]);
    expect(r).toMatchObject({
      previous_form_id: 'form_old',
      new_form_id: 'form_new',
      mode: 'asset_feed_spec',
      changed: true,
      new_creative_id: '',
      // The rebuilt creative carries the ad's placement rules, so the check passes.
      would_refuse: null,
    });
    expect(ruleReads(calls)).toEqual(['cr_old']);
  });

  it('sends no POST when the ad already uses the form', async () => {
    const calls = swapMock(assetFeedCreative());

    const r = await swapAdLeadForm('ad_1', 'form_old', TOKEN, false);

    expect(posts(calls)).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r).not.toHaveProperty('would_refuse'); // real runs never carry it
  });

  /**
   * As for url_tags: the placement-rule check runs before the create, and the
   * dry run reports the exact refusal the real call throws.
   */
  const swapRefusals: Array<[string, () => GraphCall[], RegExp]> = [
    [
      'the creative it would build carries none of the ad’s placement rules',
      () => swapMock(bodilessRulesCreative()),
      /^Refusing to rebind ad ad_1: current creative cr_old has 2 asset_customization_rules.*the new creative this call would create carries none/s,
    ],
    [
      'the current creative’s placement rules cannot be read',
      () => swapMock(legacyCreative(), '111', { oldRules: new GraphFail('User request limit reached', 17) }),
      /^Refusing to rebind ad ad_1: could not read the placement rules.*User request limit reached/s,
    ],
  ];

  it.each(swapRefusals)('%s: the real call refuses before creating anything', async (_label, setup, refusal) => {
    const calls = setup();

    const err = await swapAdLeadForm('ad_1', 'form_new', TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toMatch(refusal);
    expect(err?.message).toMatch(/Nothing was created or changed/);
    expect(err?.message).not.toMatch(/created by this call/);
    expect(posts(calls)).toEqual([]);
    expect(ruleReads(calls)).toEqual(['cr_old']);
  });

  it.each(swapRefusals)('%s: the dry run returns that refusal as would_refuse and sends no POST', async (_label, setup) => {
    setup();
    const real = await swapAdLeadForm('ad_1', 'form_new', TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(real?.message).toMatch(/^Refusing to rebind ad ad_1: /);

    const calls = setup();
    const r = await swapAdLeadForm('ad_1', 'form_new', TOKEN, true);

    expect(r).toMatchObject({ changed: true, new_creative_id: '', would_refuse: real!.message });
    expect(posts(calls)).toEqual([]);
  });

  it('dry run of a legacy creative with no placement rules reports no refusal', async () => {
    const calls = swapMock(legacyCreative());

    const r = await swapAdLeadForm('ad_1', 'form_new', TOKEN, true);

    expect(r).toMatchObject({ mode: 'object_story_spec', changed: true, would_refuse: null });
    expect(ruleReads(calls)).toEqual(['cr_old']);
    expect(posts(calls)).toEqual([]);
  });

  it('dry run when the ad already uses the form: nothing to check, nothing to refuse', async () => {
    const calls = swapMock(bodilessRulesCreative());

    const r = await swapAdLeadForm('ad_1', 'form_old', TOKEN, true);

    expect(r).toMatchObject({ changed: false, would_refuse: null });
    expect(ruleReads(calls)).toEqual([]);
    expect(posts(calls)).toEqual([]);
  });

  it('asset-feed creative: carries every asset, the placement rules and url_tags into the new creative', async () => {
    const calls = swapMock(assetFeedCreative(), 'act_111');

    const r = await swapAdLeadForm('ad_1', 'form_new', TOKEN, false);

    const [create, rebind, ...rest] = posts(calls);
    expect(rest).toEqual([]);
    expect(create?.path).toBe('act_111/adcreatives'); // no act_act_ doubling
    expect(create?.form.url_tags).toBe('utm_source=meta');
    expect(json(create?.form.object_story_spec)).toEqual({ page_id: 'page_1', instagram_actor_id: 'ig_1' });
    const afs = json(create?.form.asset_feed_spec);
    const old = assetFeedCreative().asset_feed_spec;
    expect(afs.images).toEqual(old.images);
    expect(afs.bodies).toEqual(old.bodies);
    expect(afs.titles).toEqual(old.titles);
    expect(afs.descriptions).toEqual(old.descriptions);
    expect(afs.link_urls).toEqual(old.link_urls);
    expect(afs.ad_formats).toEqual(old.ad_formats);
    expect(afs.asset_customization_rules).toEqual(RULES);
    expect(afs.call_to_action_types).toEqual(['LEARN_MORE']);
    expect(afs.call_to_actions).toEqual([{ type: 'LEARN_MORE', value: { lead_gen_form_id: 'form_new' } }]);
    expect(rebind?.path).toBe('ad_1');
    expect(json(rebind?.form.creative)).toEqual({ creative_id: 'cr_new' });
    expect(r).toMatchObject({ previous_creative_id: 'cr_old', new_creative_id: 'cr_new', changed: true });
    expect(r).not.toHaveProperty('would_refuse'); // real runs never carry it
    // The current creative's rules were checked before the create, and the
    // rebind then ran the full check on both creatives before the rebind POST.
    expect(ruleReads(calls)).toEqual(['cr_new', 'cr_old', 'cr_old']);
    const firstRuleRead = calls.findIndex((c) => c.query.fields === RULE_READ);
    expect(calls[firstRuleRead]?.path).toBe('cr_old');
    expect(firstRuleRead).toBeLessThan(calls.indexOf(create!));
    const lastRuleRead = Math.max(...calls.flatMap((c, i) => (c.query.fields === RULE_READ ? [i] : [])));
    expect(calls.indexOf(rebind!)).toBeGreaterThan(lastRuleRead);
  });

  // The pre-create check can't see this one: Meta returns the new creative
  // without the rules it was sent, so the refusal comes after the create.
  it('asset-feed: refuses to rebind when the new creative comes back without the placement rules', async () => {
    const calls = swapMock(assetFeedCreative(), '111', { newRules: [] });

    const err = await swapAdLeadForm('ad_1', 'form_new', TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toMatch(
      /^Refusing to rebind ad ad_1: previous creative cr_old has 2 asset_customization_rules.*new creative cr_new has none/s,
    );
    expect(err?.message).toMatch(/creative cr_new, created by this call, is not attached to ad ad_1/);
    expect(posts(calls).map((c) => c.path)).toEqual(['act_111/adcreatives']);
  });

  it('legacy creative: rebuilds link_data with the new form and adds the act_ prefix', async () => {
    const calls = swapMock(legacyCreative());

    const r = await swapAdLeadForm('ad_1', 'form_new', TOKEN, false);

    const create = posts(calls)[0];
    expect(create?.path).toBe('act_111/adcreatives');
    expect(json(create?.form.object_story_spec)).toEqual({
      page_id: 'page_1',
      link_data: {
        link: 'https://example.test/',
        message: 'Primary text',
        name: 'Headline',
        description: 'Description',
        image_hash: 'h1',
        call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: 'form_new' } },
      },
    });
    expect(r.mode).toBe('object_story_spec');
    // No placement rules on a legacy creative, so the rule check lets the rebind through.
    expect(posts(calls).map((c) => c.path)).toEqual(['act_111/adcreatives', 'ad_1']);
  });

  it('uses the CTA type override instead of the existing type', async () => {
    const calls = swapMock(legacyCreative());

    await swapAdLeadForm('ad_1', 'form_new', TOKEN, false, 'APPLY_NOW');

    expect(json(posts(calls)[0]?.form.object_story_spec).link_data.call_to_action.type).toBe('APPLY_NOW');
  });

  it('refuses before any POST when a legacy creative lacks the primary text', async () => {
    const calls = swapMock(legacyCreative({ message: undefined }));

    await expect(swapAdLeadForm('ad_1', 'form_new', TOKEN, false)).rejects.toThrow(/missing page_id\/link\/message/);
    expect(posts(calls)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* rebindAdCreative                                                          */
/* ------------------------------------------------------------------------- */

function rebindMock(oldRules: unknown[] | GraphFail, newRules: unknown[] | GraphFail) {
  return graphMock((c) => {
    if (c.method === 'GET' && c.path === 'ad_1') return { id: 'ad_1', name: 'Ad', creative: { id: 'cr_old' } };
    if (c.method === 'GET' && c.path === 'cr_old') {
      return oldRules instanceof GraphFail ? oldRules : { asset_feed_spec: { asset_customization_rules: oldRules } };
    }
    if (c.method === 'GET' && c.path === 'cr_new') {
      return newRules instanceof GraphFail ? newRules : { asset_feed_spec: { asset_customization_rules: newRules } };
    }
    if (c.method === 'POST' && c.path === 'ad_1') return { success: true };
    return new GraphFail(`unrouted ${c.method} ${c.path}`);
  });
}

describe('rebindAdCreative', () => {
  it('dry run runs the rule check, reports the refusal and sends no POST', async () => {
    const calls = rebindMock(RULES, []);

    const r = await rebindAdCreative('ad_1', 'cr_new', TOKEN, true);

    expect(calls.map((c) => `${c.method} ${c.path}`).sort()).toEqual(['GET ad_1', 'GET cr_new', 'GET cr_old']);
    expect(r.changed).toBe(false);
    expect(r.would_refuse).toMatch(/^Refusing to rebind ad ad_1: previous creative cr_old has 2 asset_customization_rules/);
  });

  it('sends no POST when the ad is already on that creative', async () => {
    const calls = rebindMock(RULES, []);

    const r = await rebindAdCreative('ad_1', 'cr_old', TOKEN, false);

    expect(posts(calls)).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it('rebinds and reports the rules preserved when the new creative carries them', async () => {
    const calls = rebindMock(RULES, RULES);

    const r = await rebindAdCreative('ad_1', 'cr_new', TOKEN, false);

    expect(posts(calls).map((c) => json(c.form.creative))).toEqual([{ creative_id: 'cr_new' }]);
    expect(r).toMatchObject({ changed: true, customization_rules_preserved: true });
  });

  it('reports a partial rule drop as not preserved', async () => {
    rebindMock(RULES, [RULES[0]]);

    const r = await rebindAdCreative('ad_1', 'cr_new', TOKEN, false);

    expect(r.customization_rules_preserved).toBe(false);
  });

  it('refuses when the new creative’s rules cannot be read and the old creative has rules', async () => {
    const calls = rebindMock(RULES, new GraphFail('permission denied'));

    await expect(rebindAdCreative('ad_1', 'cr_new', TOKEN, false)).rejects.toThrow(/Refusing to rebind/);
    expect(posts(calls)).toEqual([]);
  });

  it('force=true skips the rule check and rebinds', async () => {
    const calls = rebindMock(RULES, []);

    const r = await rebindAdCreative('ad_1', 'cr_new', TOKEN, false, true);

    expect(calls.filter((c) => c.method === 'GET').map((c) => c.path)).toEqual(['ad_1']);
    expect(posts(calls)).toHaveLength(1);
    expect(r).toMatchObject({ changed: true, customization_rules_preserved: null });
  });
});

/* ------------------------------------------------------------------------- */
/* editCreativeText                                                          */
/* ------------------------------------------------------------------------- */

interface EditWorld {
  creative: Record<string, unknown>;
  ctas?: unknown[] | GraphFail;
  newCreativeRules?: unknown[];
}

function editMock(world: EditWorld) {
  let rebound = false;
  return graphMock((c) => {
    if (c.method === 'GET' && c.path === 'ad_1') {
      const fields = c.query.fields ?? '';
      if (fields === 'creative{asset_feed_spec{call_to_actions}}') {
        if (world.ctas instanceof GraphFail) return world.ctas;
        return { creative: { asset_feed_spec: { call_to_actions: world.ctas ?? [] } } };
      }
      if (fields === 'id,name,creative{id}') {
        return { id: 'ad_1', name: 'Ad', creative: { id: rebound ? 'cr_new' : 'cr_old' } };
      }
      return { id: 'ad_1', name: 'Ad', account_id: '111', creative: world.creative };
    }
    if (c.method === 'GET' && c.path === 'cr_old') {
      const afs = world.creative.asset_feed_spec as { asset_customization_rules?: unknown[] } | undefined;
      return { asset_feed_spec: { asset_customization_rules: afs?.asset_customization_rules ?? [] } };
    }
    if (c.method === 'GET' && c.path === 'cr_new') {
      return { asset_feed_spec: { asset_customization_rules: world.newCreativeRules ?? [] } };
    }
    if (c.method === 'POST' && c.path === 'act_111/adcreatives') return { id: 'cr_new' };
    if (c.method === 'POST' && c.path === 'ad_1') {
      rebound = true;
      return { success: true };
    }
    return new GraphFail(`unrouted ${c.method} ${c.path}`);
  });
}

function dcoCreative(rules: unknown[] = RULES) {
  return {
    id: 'cr_old',
    name: 'DCO creative',
    url_tags: 'utm_source=meta',
    instagram_user_id: 'ig_user_1',
    object_story_spec: { page_id: 'page_1' },
    asset_feed_spec: {
      // Meta returns one entry per (asset, adlabel) pair.
      images: [
        { hash: 'h1', adlabels: [{ name: 'fb' }] },
        { hash: 'h1', adlabels: [{ name: 'ig' }] },
        { hash: 'h2', adlabels: [{ name: 'fb' }] },
      ],
      videos: [{ video_id: 'v1', thumbnail_url: 'https://example.test/t.jpg' }],
      bodies: [{ text: 'Body A' }, { text: 'Body B' }],
      titles: [{ text: 'Title A', adlabels: [{ name: 't1' }] }, { text: 'Title B' }],
      descriptions: [{ text: 'Desc A' }],
      link_urls: [{ website_url: 'https://example.test/' }],
      call_to_action_types: ['LEARN_MORE'],
      ad_formats: ['AUTOMATIC_FORMAT'],
      optimization_type: 'PLACEMENT',
      asset_customization_rules: rules,
    },
  };
}

describe('editCreativeText', () => {
  it('refuses an empty edit before touching the API', async () => {
    const calls = editMock({ creative: dcoCreative() });

    await expect(editCreativeText('ad_1', {}, TOKEN, false)).rejects.toThrow(/provide at least one/);
    expect(calls).toEqual([]);
  });

  it('asset-feed: swaps only the edited text, keeps adlabels by index, and keeps images, videos and rules', async () => {
    const calls = editMock({
      creative: dcoCreative(),
      ctas: [{ type: 'LEARN_MORE', value: { link: 'https://example.test/' } }],
      newCreativeRules: RULES,
    });

    const r = await editCreativeText('ad_1', { headlines: ['New A', 'New B'] }, TOKEN, false);

    const create = posts(calls).find((c) => c.path === 'act_111/adcreatives');
    expect(create?.form.url_tags).toBe('utm_source=meta');
    expect(create?.form.instagram_user_id).toBe('ig_user_1');
    const afs = json(create?.form.asset_feed_spec);
    expect(afs.titles).toEqual([{ text: 'New A', adlabels: [{ name: 't1' }] }, { text: 'New B' }]);
    expect(afs.bodies).toEqual(dcoCreative().asset_feed_spec.bodies);
    expect(afs.descriptions).toEqual(dcoCreative().asset_feed_spec.descriptions);
    // Duplicate (asset, label) rows merge into one asset per hash (subcode 1815629).
    expect(afs.images).toEqual([
      { hash: 'h1', adlabels: [{ name: 'fb' }, { name: 'ig' }] },
      { hash: 'h2', adlabels: [{ name: 'fb' }] },
    ]);
    expect(afs.videos).toHaveLength(1);
    expect(afs.videos[0]).toMatchObject({ video_id: 'v1', thumbnail_url: 'https://example.test/t.jpg' });
    expect(afs.asset_customization_rules).toEqual(RULES);
    expect(afs.call_to_actions).toEqual([{ type: 'LEARN_MORE', value: { link: 'https://example.test/' } }]);
    expect(afs.optimization_type).toBe('PLACEMENT');
    expect(r).toMatchObject({ mode: 'asset_feed_spec', changed_fields: ['headlines'], new_creative_id: 'cr_new', customization_rules_preserved: 2 });
    // The rebind goes through rebindAdCreative's rule check (both creatives'
    // rules are read, so no force), then one POST.
    const ruleReads = calls.filter((c) => c.method === 'GET' && c.query.fields === 'asset_feed_spec{asset_customization_rules}');
    expect(ruleReads.map((c) => c.path).sort()).toEqual(['cr_new', 'cr_old']);
    const rebinds = posts(calls).filter((c) => c.path === 'ad_1');
    expect(rebinds.map((c) => json(c.form.creative))).toEqual([{ creative_id: 'cr_new' }]);
    expect(r).not.toHaveProperty('would_refuse'); // real runs never carry it
  });

  it('asset-feed: a refused rebind names the creative it created and how to attach it', async () => {
    // Meta returns the new creative without the rules the edit carried.
    const calls = editMock({ creative: dcoCreative(), newCreativeRules: [] });

    const err = await editCreativeText('ad_1', { headlines: ['New A', 'New B'] }, TOKEN, false).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(err?.message).toMatch(/^Refusing to rebind ad ad_1: previous creative cr_old has 2 asset_customization_rules/);
    expect(err?.message).toMatch(/creative cr_new, created by this call, is not attached to ad ad_1/);
    expect(err?.message).toMatch(/meta_ads_rebind_ad_creative with ad_id=ad_1, creative_id=cr_new and force=true/);
    expect(posts(calls).map((c) => c.path)).toEqual(['act_111/adcreatives']);
  });

  it('asset-feed: carries on without call_to_actions when Meta denies that read', async () => {
    const calls = editMock({ creative: dcoCreative(), ctas: new GraphFail('permission denied'), newCreativeRules: RULES });

    await editCreativeText('ad_1', { messages: ['New body A', 'New body B'] }, TOKEN, false);

    const afs = json(posts(calls)[0]?.form.asset_feed_spec);
    expect(afs.call_to_actions).toBeUndefined();
    expect(afs.call_to_action_types).toEqual(['LEARN_MORE']);
  });

  it('asset-feed: refuses a count change that would orphan body_label rules, before any POST', async () => {
    const labelRules = [{ customization_spec: { publisher_platforms: ['facebook'] }, body_label: { name: 'b1' } }];
    const calls = editMock({ creative: dcoCreative(labelRules) });

    await expect(editCreativeText('ad_1', { messages: ['Only one'] }, TOKEN, false)).rejects.toThrow(
      /Refusing to edit messages.*body_label/s,
    );
    expect(posts(calls)).toEqual([]);
  });

  it('asset-feed: force=true allows that count change', async () => {
    const labelRules = [{ customization_spec: { publisher_platforms: ['facebook'] }, body_label: { name: 'b1' } }];
    const calls = editMock({ creative: dcoCreative(labelRules), newCreativeRules: labelRules });

    await editCreativeText('ad_1', { messages: ['Only one'] }, TOKEN, false, true);

    expect(json(posts(calls)[0]?.form.asset_feed_spec).bodies).toEqual([{ text: 'Only one' }]);
  });

  it('dry run lists the changed fields, reports no refusal and sends no POST', async () => {
    const calls = editMock({ creative: dcoCreative() });

    const r = await editCreativeText('ad_1', { headlines: ['A', 'B'] }, TOKEN, true);

    expect(posts(calls)).toEqual([]);
    expect(r).toMatchObject({ changed_fields: ['headlines'], new_creative_id: '', would_refuse: null });
  });

  /**
   * Like meta_ads_rebind_ad_creative's dry run (incrementality#25), a dry run
   * that the real run would refuse returns a result carrying the refusal
   * instead of throwing it. One case per label the rules can reference.
   */
  const labelRefusals: Array<[string, Record<string, unknown>, Record<string, string[]>, RegExp]> = [
    ['messages / body_label', { body_label: { name: 'b1' } }, { messages: ['Only one'] }, /^Refusing to edit messages on ad ad_1: .*body_label/s],
    ['headlines / title_label', { title_label: { name: 't1' } }, { headlines: ['A', 'B', 'C'] }, /^Refusing to edit headlines on ad ad_1: .*title_label/s],
    ['descriptions / description_label', { description_label: { name: 'd1' } }, { descriptions: ['A', 'B'] }, /^Refusing to edit descriptions on ad ad_1: .*description_label/s],
  ];

  it.each(labelRefusals)(
    'dry run returns the %s refusal as would_refuse, the exact message the real run throws, and sends no POST',
    async (_label, labelRef, edits, refusal) => {
      const labelRules = [{ customization_spec: { publisher_platforms: ['facebook'] }, ...labelRef }];
      editMock({ creative: dcoCreative(labelRules) });
      const real = await editCreativeText('ad_1', edits, TOKEN, false).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(real?.message).toMatch(refusal);

      const calls = editMock({ creative: dcoCreative(labelRules) });
      const r = await editCreativeText('ad_1', edits, TOKEN, true);

      expect(r).toEqual({
        ad_id: 'ad_1',
        ad_name: 'Ad',
        previous_creative_id: 'cr_old',
        new_creative_id: '',
        mode: 'asset_feed_spec',
        changed_fields: Object.keys(edits),
        customization_rules_preserved: 1,
        would_refuse: real!.message,
      });
      expect(posts(calls)).toEqual([]);
    },
  );

  it('dry run with force=true reports no refusal, like the real run', async () => {
    const labelRules = [{ customization_spec: { publisher_platforms: ['facebook'] }, body_label: { name: 'b1' } }];
    const calls = editMock({ creative: dcoCreative(labelRules) });

    const r = await editCreativeText('ad_1', { messages: ['Only one'] }, TOKEN, true, true);

    expect(r).toMatchObject({ changed_fields: ['messages'], new_creative_id: '', would_refuse: null });
    expect(posts(calls)).toEqual([]);
  });

  it('dry run of an edit that changes nothing reports no refusal', async () => {
    editMock({ creative: legacyCreative() });

    const r = await editCreativeText('ad_1', { headlines: [] }, TOKEN, true);

    expect(r).toMatchObject({ changed_fields: [], new_creative_id: 'cr_old', would_refuse: null });
  });

  it('legacy: replaces the headline and keeps link, message, image and CTA', async () => {
    const calls = editMock({ creative: legacyCreative() });

    const r = await editCreativeText('ad_1', { headlines: ['New headline'] }, TOKEN, false);

    const create = posts(calls).find((c) => c.path === 'act_111/adcreatives');
    expect(json(create?.form.object_story_spec)).toEqual({
      page_id: 'page_1',
      link_data: { ...legacyCreative().object_story_spec.link_data, name: 'New headline' },
    });
    expect(r).toMatchObject({ mode: 'object_story_spec', changed_fields: ['headlines'], new_creative_id: 'cr_new' });
  });

  it('legacy: refuses more than one headline before any POST', async () => {
    const calls = editMock({ creative: legacyCreative() });

    await expect(editCreativeText('ad_1', { headlines: ['A', 'B'] }, TOKEN, false)).rejects.toThrow(/single-variant/);
    expect(posts(calls)).toEqual([]);
  });

  it('legacy: sends no POST when every edit array is empty', async () => {
    const calls = editMock({ creative: legacyCreative() });

    const r = await editCreativeText('ad_1', { headlines: [], messages: [] }, TOKEN, false);

    expect(posts(calls)).toEqual([]);
    expect(r).toMatchObject({ changed_fields: [], new_creative_id: 'cr_old' });
    expect(r).not.toHaveProperty('would_refuse');
  });
});

/* ------------------------------------------------------------------------- */
/* renameAd                                                                  */
/* ------------------------------------------------------------------------- */

describe('renameAd', () => {
  function renameMock() {
    let name = 'Old name';
    return graphMock((c) => {
      if (c.method === 'GET' && c.path === 'ad_1') return { id: 'ad_1', name };
      if (c.method === 'POST' && c.path === 'ad_1') {
        name = c.form.name ?? name;
        return { success: true };
      }
      return new GraphFail(`unrouted ${c.method} ${c.path}`);
    });
  }

  it('dry run reports the rename and sends no POST', async () => {
    const calls = renameMock();

    const r = await renameAd('ad_1', 'New name', TOKEN, true);

    expect(posts(calls)).toEqual([]);
    expect(r).toEqual({ ad_id: 'ad_1', previous_name: 'Old name', new_name: 'New name', changed: true });
  });

  it('sends no POST when the name already matches', async () => {
    const calls = renameMock();

    const r = await renameAd('ad_1', 'Old name', TOKEN, false);

    expect(posts(calls)).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it('posts the new name and reports what the read-back shows', async () => {
    const calls = renameMock();

    const r = await renameAd('ad_1', 'New name', TOKEN, false);

    expect(posts(calls).map((c) => c.form.name)).toEqual(['New name']);
    expect(r).toEqual({ ad_id: 'ad_1', previous_name: 'Old name', new_name: 'New name', changed: true });
  });
});
