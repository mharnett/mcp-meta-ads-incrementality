import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createLeadgenForm,
  createCustomAudience,
  uploadUsersToAudience,
  createLookalikeAudience,
} from './audiences-and-forms.js';

/* ------------------------------------------------------------------------- */
/* Fetch mocking                                                              */
/* ------------------------------------------------------------------------- */

interface CapturedCall {
  url: string;
  method: string;
  body: URLSearchParams;
}

function setupFetchMock(responses: Array<unknown | { _status: number; _body: unknown }>): {
  calls: CapturedCall[];
  fetchMock: ReturnType<typeof vi.fn>;
} {
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
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOKEN = 'TEST_TOKEN_xyz';
const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

/* ========================================================================= */
/* createLeadgenForm                                                          */
/* ========================================================================= */

describe('createLeadgenForm', () => {
  const minInput = {
    page_id: '111111',
    name: 'Test Form',
    privacy_policy: { url: 'https://example.com/privacy' },
    questions: [{ type: 'EMAIL' }, { type: 'FIRST_NAME' }],
    thank_you_page: {
      title: 'Thanks',
      body: 'Downloading',
      button_text: 'Go',
      button_type: 'VIEW_WEBSITE' as const,
      website_url: 'https://example.com/dl',
    },
  };

  it('returns the form_id from the response', async () => {
    setupFetchMock([{ id: '999000' }]);
    const r = await createLeadgenForm(minInput, TOKEN);
    expect(r.form_id).toBe('999000');
    expect(r.page_id).toBe('111111');
    expect(r.name).toBe('Test Form');
  });

  it('POSTs to /{page_id}/leadgen_forms', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(calls[0]?.url).toMatch(/\/111111\/leadgen_forms$/);
    expect(calls[0]?.method).toBe('POST');
  });

  it('includes the access token in the form body', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(calls[0]?.body.get('access_token')).toBe(TOKEN);
  });

  it('defaults locale to en_US', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(calls[0]?.body.get('locale')).toBe('en_US');
  });

  it('defaults form_type to MORE_VOLUME', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(calls[0]?.body.get('form_type')).toBe('MORE_VOLUME');
  });

  it('passes form_type=HIGHER_INTENT when specified', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm({ ...minInput, form_type: 'HIGHER_INTENT' }, TOKEN);
    expect(calls[0]?.body.get('form_type')).toBe('HIGHER_INTENT');
  });

  it('JSON-serializes privacy_policy', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(JSON.parse(calls[0]!.body.get('privacy_policy')!)).toEqual({ url: 'https://example.com/privacy' });
  });

  it('JSON-serializes questions', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(JSON.parse(calls[0]!.body.get('questions')!)).toEqual([{ type: 'EMAIL' }, { type: 'FIRST_NAME' }]);
  });

  it('JSON-serializes thank_you_page', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(JSON.parse(calls[0]!.body.get('thank_you_page')!)).toMatchObject({ title: 'Thanks', button_type: 'VIEW_WEBSITE' });
  });

  it('omits context_card when not provided', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(calls[0]?.body.has('context_card')).toBe(false);
  });

  it('JSON-serializes context_card when provided', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(
      { ...minInput, context_card: { style: 'PARAGRAPH_STYLE', title: 'Hi', content: ['p1', 'p2'] } },
      TOKEN,
    );
    expect(JSON.parse(calls[0]!.body.get('context_card')!)).toEqual({
      style: 'PARAGRAPH_STYLE',
      title: 'Hi',
      content: ['p1', 'p2'],
    });
  });

  it('omits follow_up_action_url when not provided', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm(minInput, TOKEN);
    expect(calls[0]?.body.has('follow_up_action_url')).toBe(false);
  });

  it('includes follow_up_action_url when provided', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLeadgenForm({ ...minInput, follow_up_action_url: 'https://example.com/next' }, TOKEN);
    expect(calls[0]?.body.get('follow_up_action_url')).toBe('https://example.com/next');
  });

  it('throws on Graph error response', async () => {
    setupFetchMock([{ _status: 400, _body: { error: { code: 100, message: 'bad request', fbtrace_id: 'abc' } } }]);
    await expect(createLeadgenForm(minInput, TOKEN)).rejects.toThrow(/bad request/);
  });
});

/* ========================================================================= */
/* createCustomAudience                                                       */
/* ========================================================================= */

describe('createCustomAudience', () => {
  const baseInput = { account_id: 'act_123', name: 'Customers 2026' };

  it('returns the audience_id from the response', async () => {
    setupFetchMock([{ id: '6123456789' }]);
    const r = await createCustomAudience(baseInput, TOKEN);
    expect(r.audience_id).toBe('6123456789');
    expect(r.name).toBe('Customers 2026');
  });

  it('POSTs to /{account_id}/customaudiences', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCustomAudience(baseInput, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_123\/customaudiences$/);
    expect(calls[0]?.method).toBe('POST');
  });

  it('adds act_ prefix to account_id if missing', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCustomAudience({ ...baseInput, account_id: '999' }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_999\/customaudiences$/);
  });

  it('leaves act_ prefix alone when present', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCustomAudience({ ...baseInput, account_id: 'act_555' }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_555\/customaudiences$/);
  });

  it('sets subtype=CUSTOM', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCustomAudience(baseInput, TOKEN);
    expect(calls[0]?.body.get('subtype')).toBe('CUSTOM');
  });

  it('defaults customer_file_source to USER_PROVIDED_ONLY', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCustomAudience(baseInput, TOKEN);
    expect(calls[0]?.body.get('customer_file_source')).toBe('USER_PROVIDED_ONLY');
  });

  it('honors explicit customer_file_source', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCustomAudience({ ...baseInput, customer_file_source: 'PARTNER_PROVIDED_ONLY' }, TOKEN);
    expect(calls[0]?.body.get('customer_file_source')).toBe('PARTNER_PROVIDED_ONLY');
  });

  it('omits description when not provided', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCustomAudience(baseInput, TOKEN);
    expect(calls[0]?.body.has('description')).toBe(false);
  });

  it('includes description when provided', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createCustomAudience({ ...baseInput, description: 'SF export May 2026' }, TOKEN);
    expect(calls[0]?.body.get('description')).toBe('SF export May 2026');
  });

  it('throws on Graph error', async () => {
    setupFetchMock([{ _status: 400, _body: { error: { code: 100, message: 'nope' } } }]);
    await expect(createCustomAudience(baseInput, TOKEN)).rejects.toThrow(/nope/);
  });
});

/* ========================================================================= */
/* uploadUsersToAudience                                                      */
/* ========================================================================= */

describe('uploadUsersToAudience', () => {
  it('throws on empty users array', async () => {
    setupFetchMock([]);
    await expect(
      uploadUsersToAudience({ audience_id: '1', users: [] }, TOKEN),
    ).rejects.toThrow(/empty/i);
  });

  it('POSTs to /{audience_id}/users', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience({ audience_id: '777', users: [{ email: 'a@b.com' }] }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/777\/users$/);
  });

  it('infers EMAIL schema when first record has email', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience({ audience_id: '1', users: [{ email: 'a@b.com' }] }, TOKEN);
    const payload = JSON.parse(calls[0]!.body.get('payload')!);
    expect(payload.schema).toEqual(['EMAIL']);
  });

  it('infers PHONE schema when no email but phone present', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience({ audience_id: '1', users: [{ phone: '+1-555-867-5309' }] }, TOKEN);
    const payload = JSON.parse(calls[0]!.body.get('payload')!);
    expect(payload.schema).toEqual(['PHONE']);
  });

  it('throws when first record has neither email nor phone and no explicit schema', async () => {
    setupFetchMock([]);
    await expect(
      uploadUsersToAudience({ audience_id: '1', users: [{ first_name: 'jane' }] }, TOKEN),
    ).rejects.toThrow(/infer/i);
  });

  it('uses explicit schema when provided', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience(
      { audience_id: '1', users: [{ email: 'a@b.com', phone: '5551234' }], schema: ['EMAIL', 'PHONE'] },
      TOKEN,
    );
    const payload = JSON.parse(calls[0]!.body.get('payload')!);
    expect(payload.schema).toEqual(['EMAIL', 'PHONE']);
  });

  it('SHA-256 hashes email after lowercasing and trimming', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience({ audience_id: '1', users: [{ email: '  Foo@Bar.COM ' }] }, TOKEN);
    const payload = JSON.parse(calls[0]!.body.get('payload')!);
    expect(payload.data[0][0]).toBe(sha256hex('foo@bar.com'));
  });

  it('SHA-256 hashes phone after stripping non-digits', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience({ audience_id: '1', users: [{ phone: '+1 (555) 867-5309' }] }, TOKEN);
    const payload = JSON.parse(calls[0]!.body.get('payload')!);
    expect(payload.data[0][0]).toBe(sha256hex('15558675309'));
  });

  it('SHA-256 hashes ZIP after taking part before the dash', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience(
      { audience_id: '1', users: [{ email: 'a@b.com', zip: '94117-1234' }], schema: ['EMAIL', 'ZIP'] },
      TOKEN,
    );
    const payload = JSON.parse(calls[0]!.body.get('payload')!);
    expect(payload.data[0][1]).toBe(sha256hex('94117'));
  });

  it('SHA-256 hashes name fields after lowercase + alphanumeric-only normalization', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience(
      {
        audience_id: '1',
        users: [{ email: 'x@y.com', first_name: "O'Brien", last_name: 'Smith-Jones' }],
        schema: ['EMAIL', 'FN', 'LN'],
      },
      TOKEN,
    );
    const payload = JSON.parse(calls[0]!.body.get('payload')!);
    expect(payload.data[0][1]).toBe(sha256hex('obrien'));
    expect(payload.data[0][2]).toBe(sha256hex('smithjones'));
  });

  it('emits empty string for missing fields (not undefined)', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience(
      { audience_id: '1', users: [{ email: 'a@b.com' }], schema: ['EMAIL', 'PHONE'] },
      TOKEN,
    );
    const payload = JSON.parse(calls[0]!.body.get('payload')!);
    expect(payload.data[0][1]).toBe('');
  });

  it('batches at default 1000 records', async () => {
    const users = Array.from({ length: 2500 }, (_, i) => ({ email: `u${i}@x.com` }));
    const { calls } = setupFetchMock([
      { num_received: 1000 },
      { num_received: 1000 },
      { num_received: 500 },
    ]);
    const r = await uploadUsersToAudience({ audience_id: '1', users }, TOKEN);
    expect(calls.length).toBe(3);
    expect(r.batches).toBe(3);
    expect(r.records_sent).toBe(2500);
  });

  it('respects custom batch_size', async () => {
    const users = Array.from({ length: 250 }, (_, i) => ({ email: `u${i}@x.com` }));
    const { calls } = setupFetchMock([{ num_received: 100 }, { num_received: 100 }, { num_received: 50 }]);
    await uploadUsersToAudience({ audience_id: '1', users, batch_size: 100 }, TOKEN);
    expect(calls.length).toBe(3);
  });

  it('clamps batch_size to max 10000', async () => {
    const users = Array.from({ length: 15000 }, (_, i) => ({ email: `u${i}@x.com` }));
    const { calls } = setupFetchMock([{ num_received: 10000 }, { num_received: 5000 }]);
    await uploadUsersToAudience({ audience_id: '1', users, batch_size: 99999 }, TOKEN);
    expect(calls.length).toBe(2);
  });

  it('aggregates num_received and num_invalid_entries across batches', async () => {
    const users = Array.from({ length: 1500 }, (_, i) => ({ email: `u${i}@x.com` }));
    setupFetchMock([
      { num_received: 990, num_invalid_entries: 10 },
      { num_received: 495, num_invalid_entries: 5 },
    ]);
    const r = await uploadUsersToAudience({ audience_id: '1', users }, TOKEN);
    expect(r.num_received).toBe(1485);
    expect(r.num_invalid_entries).toBe(15);
  });

  it('collects up to 5 invalid_entry_samples across batches', async () => {
    const users = Array.from({ length: 2000 }, (_, i) => ({ email: `u${i}@x.com` }));
    setupFetchMock([
      { num_received: 990, invalid_entry_samples: ['a', 'b', 'c'] },
      { num_received: 990, invalid_entry_samples: ['d', 'e', 'f', 'g'] },
    ]);
    const r = await uploadUsersToAudience({ audience_id: '1', users }, TOKEN);
    expect(r.invalid_entry_samples).toHaveLength(5);
  });

  it('passes session_id (default 0)', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience({ audience_id: '1', users: [{ email: 'a@b.com' }] }, TOKEN);
    expect(calls[0]?.body.get('session_id')).toBe('0');
  });

  it('passes explicit session_id', async () => {
    const { calls } = setupFetchMock([{ num_received: 1 }]);
    await uploadUsersToAudience({ audience_id: '1', users: [{ email: 'a@b.com' }], session_id: 42 }, TOKEN);
    expect(calls[0]?.body.get('session_id')).toBe('42');
  });
});

/* ========================================================================= */
/* createLookalikeAudience                                                    */
/* ========================================================================= */

describe('createLookalikeAudience', () => {
  const baseInput = {
    account_id: 'act_123',
    name: 'LAL 1% US',
    origin_audience_id: '6999',
    country: 'US',
  };

  it('returns the audience_id from the response', async () => {
    setupFetchMock([{ id: '6111222' }]);
    const r = await createLookalikeAudience(baseInput, TOKEN);
    expect(r.audience_id).toBe('6111222');
    expect(r.ratio).toBe(0.01);
  });

  it('POSTs to /{account_id}/customaudiences', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLookalikeAudience(baseInput, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_123\/customaudiences$/);
  });

  it('normalizes account_id (adds act_ prefix)', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLookalikeAudience({ ...baseInput, account_id: '777' }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/act_777\/customaudiences$/);
  });

  it('sets subtype=LOOKALIKE', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLookalikeAudience(baseInput, TOKEN);
    expect(calls[0]?.body.get('subtype')).toBe('LOOKALIKE');
  });

  it('includes origin_audience_id', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLookalikeAudience(baseInput, TOKEN);
    expect(calls[0]?.body.get('origin_audience_id')).toBe('6999');
  });

  it('defaults ratio to 0.01', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLookalikeAudience(baseInput, TOKEN);
    const spec = JSON.parse(calls[0]!.body.get('lookalike_spec')!);
    expect(spec.ratio).toBe(0.01);
  });

  it('builds lookalike_spec with type=similarity, ratio, country', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLookalikeAudience({ ...baseInput, ratio: 0.05 }, TOKEN);
    const spec = JSON.parse(calls[0]!.body.get('lookalike_spec')!);
    expect(spec).toEqual({ type: 'similarity', ratio: 0.05, country: 'US' });
  });

  it('throws when ratio < 0.01', async () => {
    setupFetchMock([]);
    await expect(createLookalikeAudience({ ...baseInput, ratio: 0.005 }, TOKEN)).rejects.toThrow(/range/);
  });

  it('throws when ratio > 0.20', async () => {
    setupFetchMock([]);
    await expect(createLookalikeAudience({ ...baseInput, ratio: 0.25 }, TOKEN)).rejects.toThrow(/range/);
  });

  it('includes description when provided', async () => {
    const { calls } = setupFetchMock([{ id: '1' }]);
    await createLookalikeAudience({ ...baseInput, description: 'seeded from Pardot 365d' }, TOKEN);
    expect(calls[0]?.body.get('description')).toBe('seeded from Pardot 365d');
  });
});
