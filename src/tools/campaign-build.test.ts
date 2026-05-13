import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createCampaign,
  createAdSet,
  createAdCreative,
  createAd,
  uploadImage,
} from './campaign-build.js';

/* ------------------------------------------------------------------------- */
/* Fetch mocking                                                              */
/* ------------------------------------------------------------------------- */

interface CapturedCall {
  url: string;
  method: string;
  body: URLSearchParams;
}

function setupFetchMock(responses: Array<unknown | { _status: number; _body: unknown }>) {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? new URLSearchParams(String(init.body)) : new URLSearchParams();
    calls.push({ url, method: init?.method ?? 'GET', body });
    const next = responses[i++] ?? {};
    if (next && typeof next === 'object' && '_status' in next) {
      const r = next as { _status: number; _body: unknown };
      return new Response(JSON.stringify(r._body), {
        status: r._status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(next), {
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

/* ========================================================================= */
/* createCampaign                                                             */
/* ========================================================================= */

describe('createCampaign', () => {
  const base = { account_id: 'act_123', name: 'C1', objective: 'OUTCOME_LEADS' };

  it('returns campaign_id from response', async () => {
    setupFetchMock([{ id: 'cmp_999' }]);
    const r = await createCampaign(base, TOKEN);
    expect(r.campaign_id).toBe('cmp_999');
    expect(r.name).toBe('C1');
  });

  it('POSTs to /{account_id}/campaigns', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign(base, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_123\/campaigns$/);
    expect(calls[0]?.method).toBe('POST');
  });

  it('normalizes account_id (adds act_ prefix)', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign({ ...base, account_id: '999' }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_999\/campaigns$/);
  });

  it('defaults status to PAUSED', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign(base, TOKEN);
    expect(calls[0]?.body.get('status')).toBe('PAUSED');
  });

  it('honors explicit status=ACTIVE', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign({ ...base, status: 'ACTIVE' }, TOKEN);
    expect(calls[0]?.body.get('status')).toBe('ACTIVE');
  });

  it('defaults special_ad_categories to []', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign(base, TOKEN);
    expect(calls[0]?.body.get('special_ad_categories')).toBe('[]');
  });

  it('serializes special_ad_categories as JSON', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign({ ...base, special_ad_categories: ['HOUSING', 'EMPLOYMENT'] }, TOKEN);
    expect(JSON.parse(calls[0]!.body.get('special_ad_categories')!)).toEqual(['HOUSING', 'EMPLOYMENT']);
  });

  it('defaults buying_type to AUCTION', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign(base, TOKEN);
    expect(calls[0]?.body.get('buying_type')).toBe('AUCTION');
  });

  it('sends objective', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign(base, TOKEN);
    expect(calls[0]?.body.get('objective')).toBe('OUTCOME_LEADS');
  });

  it('omits daily_budget when not provided (ABO)', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign(base, TOKEN);
    expect(calls[0]?.body.has('daily_budget')).toBe(false);
  });

  it('passes daily_budget when provided (CBO)', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCampaign({ ...base, daily_budget: 10000 }, TOKEN);
    expect(calls[0]?.body.get('daily_budget')).toBe('10000');
  });

  it('throws on Graph error', async () => {
    setupFetchMock([{ _status: 400, _body: { error: { code: 100, message: 'oops' } } }]);
    await expect(createCampaign(base, TOKEN)).rejects.toThrow(/oops/);
  });
});

/* ========================================================================= */
/* createAdSet                                                                */
/* ========================================================================= */

describe('createAdSet', () => {
  const baseNoBudget = {
    account_id: 'act_123',
    campaign_id: 'cmp_1',
    name: 'AS1',
    optimization_goal: 'LEAD_GENERATION',
    billing_event: 'IMPRESSIONS' as const,
    targeting: { geo_locations: { countries: ['US'] }, age_min: 25, age_max: 55 },
  };
  const base = { ...baseNoBudget, daily_budget: 7500 };

  it('returns adset_id from response', async () => {
    setupFetchMock([{ id: 'as_999' }]);
    const r = await createAdSet(base, TOKEN);
    expect(r.adset_id).toBe('as_999');
  });

  it('POSTs to /{account_id}/adsets', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet(base, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_123\/adsets$/);
  });

  it('normalizes account_id', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet({ ...base, account_id: '999' }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_999\/adsets$/);
  });

  it('defaults status to PAUSED', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet(base, TOKEN);
    expect(calls[0]?.body.get('status')).toBe('PAUSED');
  });

  it('JSON-serializes targeting', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet(base, TOKEN);
    expect(JSON.parse(calls[0]!.body.get('targeting')!)).toEqual(base.targeting);
  });

  it('defaults bid_strategy to LOWEST_COST_WITHOUT_CAP', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet(base, TOKEN);
    expect(calls[0]?.body.get('bid_strategy')).toBe('LOWEST_COST_WITHOUT_CAP');
  });

  it('throws when daily_budget and lifetime_budget are both set', async () => {
    setupFetchMock([]);
    await expect(
      createAdSet({ ...base, lifetime_budget: 100000 }, TOKEN),
    ).rejects.toThrow(/both/i);
  });

  it('requires at least one of daily_budget or lifetime_budget when not inherited from CBO', async () => {
    setupFetchMock([]);
    await expect(createAdSet(baseNoBudget, TOKEN)).rejects.toThrow(/budget/i);
  });

  it('accepts daily_budget only', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet({ ...base, daily_budget: 7500 }, TOKEN);
    expect(calls[0]?.body.get('daily_budget')).toBe('7500');
    expect(calls[0]?.body.has('lifetime_budget')).toBe(false);
  });

  it('accepts lifetime_budget only', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet(
      { ...baseNoBudget, lifetime_budget: 100000, end_time: '2026-12-31T23:59:00-0600' },
      TOKEN,
    );
    expect(calls[0]?.body.get('lifetime_budget')).toBe('100000');
  });

  it('JSON-serializes promoted_object when present', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet(
      { ...base, daily_budget: 7500, promoted_object: { page_id: '111' } },
      TOKEN,
    );
    expect(JSON.parse(calls[0]!.body.get('promoted_object')!)).toEqual({ page_id: '111' });
  });

  it('JSON-serializes attribution_spec when present', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet(
      {
        ...base,
        daily_budget: 7500,
        attribution_spec: [
          { event_type: 'CLICK_THROUGH', window_days: 7 },
          { event_type: 'VIEW_THROUGH', window_days: 1 },
        ],
      },
      TOKEN,
    );
    expect(JSON.parse(calls[0]!.body.get('attribution_spec')!)).toEqual([
      { event_type: 'CLICK_THROUGH', window_days: 7 },
      { event_type: 'VIEW_THROUGH', window_days: 1 },
    ]);
  });

  it('passes is_incremental_attribution_enabled when true', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet({ ...base, daily_budget: 7500, is_incremental_attribution_enabled: true }, TOKEN);
    expect(calls[0]?.body.get('is_incremental_attribution_enabled')).toBe('true');
  });

  it('passes destination_type for ON_AD lead gen', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet({ ...base, daily_budget: 7500, destination_type: 'ON_AD' }, TOKEN);
    expect(calls[0]?.body.get('destination_type')).toBe('ON_AD');
  });

  it('passes start_time and end_time', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdSet(
      { ...base, daily_budget: 7500, start_time: '2026-06-01T00:00:00-0500', end_time: '2026-06-30T23:59:00-0500' },
      TOKEN,
    );
    expect(calls[0]?.body.get('start_time')).toBe('2026-06-01T00:00:00-0500');
    expect(calls[0]?.body.get('end_time')).toBe('2026-06-30T23:59:00-0500');
  });
});

/* ========================================================================= */
/* createAdCreative                                                            */
/* ========================================================================= */

describe('createAdCreative', () => {
  const base = {
    account_id: 'act_123',
    name: 'CR1',
    page_id: '111',
    image_hash: 'hash_abc',
    link: 'https://example.com/lp',
    message: 'Primary text here',
  };

  it('returns creative_id from response', async () => {
    setupFetchMock([{ id: 'cr_999' }]);
    const r = await createAdCreative(base, TOKEN);
    expect(r.creative_id).toBe('cr_999');
  });

  it('POSTs to /{account_id}/adcreatives', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdCreative(base, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_123\/adcreatives$/);
  });

  it('normalizes account_id', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdCreative({ ...base, account_id: '777' }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_777\/adcreatives$/);
  });

  it('builds object_story_spec with page_id and link_data', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdCreative(base, TOKEN);
    const spec = JSON.parse(calls[0]!.body.get('object_story_spec')!);
    expect(spec.page_id).toBe('111');
    expect(spec.link_data.link).toBe('https://example.com/lp');
    expect(spec.link_data.message).toBe('Primary text here');
    expect(spec.link_data.image_hash).toBe('hash_abc');
  });

  it('includes headline and description when provided', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdCreative({ ...base, headline: 'Big headline', description: 'Sub desc' }, TOKEN);
    const spec = JSON.parse(calls[0]!.body.get('object_story_spec')!);
    expect(spec.link_data.name).toBe('Big headline');
    expect(spec.link_data.description).toBe('Sub desc');
  });

  it('builds call_to_action with lead_gen_form_id shortcut', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdCreative({ ...base, lead_gen_form_id: 'form_xyz' }, TOKEN);
    const spec = JSON.parse(calls[0]!.body.get('object_story_spec')!);
    expect(spec.link_data.call_to_action).toEqual({
      type: 'SIGN_UP',
      value: { lead_gen_form_id: 'form_xyz' },
    });
  });

  it('allows explicit call_to_action override', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdCreative(
      { ...base, call_to_action: { type: 'DOWNLOAD', value: { link: 'https://example.com/file.pdf' } } },
      TOKEN,
    );
    const spec = JSON.parse(calls[0]!.body.get('object_story_spec')!);
    expect(spec.link_data.call_to_action.type).toBe('DOWNLOAD');
  });

  it('includes url_tags at top-level (not inside object_story_spec)', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAdCreative(
      { ...base, url_tags: 'utm_source=facebook&utm_campaign=foo' },
      TOKEN,
    );
    expect(calls[0]?.body.get('url_tags')).toBe('utm_source=facebook&utm_campaign=foo');
  });

  it('throws on Graph error', async () => {
    setupFetchMock([{ _status: 400, _body: { error: { code: 100, message: 'bad image' } } }]);
    await expect(createAdCreative(base, TOKEN)).rejects.toThrow(/bad image/);
  });
});

/* ========================================================================= */
/* createAd                                                                   */
/* ========================================================================= */

describe('createAd', () => {
  const base = {
    account_id: 'act_123',
    name: 'AD1',
    adset_id: 'as_1',
    creative_id: 'cr_1',
  };

  it('returns ad_id from response', async () => {
    setupFetchMock([{ id: 'ad_999' }]);
    const r = await createAd(base, TOKEN);
    expect(r.ad_id).toBe('ad_999');
  });

  it('POSTs to /{account_id}/ads', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAd(base, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_123\/ads$/);
  });

  it('passes name and adset_id', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAd(base, TOKEN);
    expect(calls[0]?.body.get('name')).toBe('AD1');
    expect(calls[0]?.body.get('adset_id')).toBe('as_1');
  });

  it('JSON-serializes creative ref', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAd(base, TOKEN);
    expect(JSON.parse(calls[0]!.body.get('creative')!)).toEqual({ creative_id: 'cr_1' });
  });

  it('defaults status to PAUSED', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createAd(base, TOKEN);
    expect(calls[0]?.body.get('status')).toBe('PAUSED');
  });
});

/* ========================================================================= */
/* uploadImage                                                                */
/* ========================================================================= */

describe('uploadImage', () => {
  it('returns image_hash and url from response', async () => {
    setupFetchMock([
      { images: { bytes: { hash: 'abc123', url: 'https://scontent.fb/img.jpg' } } },
    ]);
    const r = await uploadImage(
      { account_id: 'act_123', image_bytes: Buffer.from('fakejpegbytes').toString('base64') },
      TOKEN,
    );
    expect(r.image_hash).toBe('abc123');
    expect(r.url).toBe('https://scontent.fb/img.jpg');
  });

  it('POSTs to /{account_id}/adimages', async () => {
    const { calls } = setupFetchMock([{ images: { bytes: { hash: 'h', url: 'u' } } }]);
    await uploadImage(
      { account_id: 'act_123', image_bytes: Buffer.from('x').toString('base64') },
      TOKEN,
    );
    expect(calls[0]?.url).toMatch(/\/act_123\/adimages$/);
  });

  it('normalizes account_id', async () => {
    const { calls } = setupFetchMock([{ images: { bytes: { hash: 'h', url: 'u' } } }]);
    await uploadImage(
      { account_id: '777', image_bytes: Buffer.from('x').toString('base64') },
      TOKEN,
    );
    expect(calls[0]?.url).toMatch(/\/act_777\/adimages$/);
  });

  it('passes image bytes in the bytes form field', async () => {
    const { calls } = setupFetchMock([{ images: { bytes: { hash: 'h', url: 'u' } } }]);
    const b64 = Buffer.from('jpegpayload').toString('base64');
    await uploadImage({ account_id: 'act_123', image_bytes: b64 }, TOKEN);
    expect(calls[0]?.body.get('bytes')).toBe(b64);
  });

  it('throws on Graph error', async () => {
    setupFetchMock([{ _status: 400, _body: { error: { code: 100, message: 'image too big' } } }]);
    await expect(
      uploadImage({ account_id: 'act_123', image_bytes: 'AAAA' }, TOKEN),
    ).rejects.toThrow(/too big/);
  });

  it('throws when neither image_bytes nor image_path provided', async () => {
    setupFetchMock([]);
    await expect(uploadImage({ account_id: 'act_123' } as never, TOKEN)).rejects.toThrow(/image/i);
  });
});
