/**
 * Call-site test for the write gate.
 *
 * writeGate.test.ts proves assertWriteAllowed() and filterTools() behave. It
 * does not prove the server calls them: delete `assertWriteAllowed(name)` from
 * the CallTool handler in index.ts and that file stays green. This file loads
 * the real entrypoint (index.ts, top-level startup included) and talks to it
 * through a real MCP client over an in-memory transport, so every request goes
 * through the same handlers a stdio client reaches.
 *
 * Containment: credentials are a fake token (no env or cached-file read), the
 * Meta SDK factory is faked (the SDK is never loaded), and global fetch is a
 * recorder. Every Graph call in src/ goes through fetch in lib/graph.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { TOOLS } from './toolDefinitions.js';
import { WRITE_DISABLED_MESSAGE, WRITE_TOOLS } from './writeGate.js';
import { ENABLE_TOOL } from './lib/create-status.js';

const h = vi.hoisted(() => ({
  clientTransport: undefined as unknown as Transport,
  sdkCalls: [] as string[],
}));

vi.mock('./credentials.js', () => ({
  resolveCredentials: () => ({
    access_token: 'FAKE_TEST_TOKEN_not_a_real_credential',
    source: 'env',
  }),
}));

vi.mock('./lib/meta-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/meta-client.js')>();
  return {
    ...actual,
    createDefaultMetaSdk: async () => ({
      init: () => {
        h.sdkCalls.push('init');
      },
      createAdAccount: () => {
        h.sdkCalls.push('createAdAccount');
        throw new Error('fake SDK: no network');
      },
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', async () => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  return {
    StdioServerTransport: class {
      constructor() {
        const [client, server] = InMemoryTransport.createLinkedPair();
        h.clientTransport = client;
        return server;
      }
    },
  };
});

interface RecordedFetch {
  url: string;
  method: string;
  body: URLSearchParams;
}

const fetchCalls: RecordedFetch[] = [];
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  fetchCalls.push({
    url: String(input),
    method: init?.method ?? 'GET',
    body: new URLSearchParams(init?.body ? String(init.body) : ''),
  });
  return new Response(
    JSON.stringify({
      id: '990000000000001',
      success: true,
      data: [],
      images: { bytes: { hash: 'fakehash', url: 'https://example.com/fake.png' } },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
});

const ACCOUNT = 'act_100000000000001';
const CAMPAIGN = '120000000000010';
const ADSET = '120000000000020';
const AD = '120000000000030';
const CREATIVE = '120000000000040';
const PAGE = '100000000000099';
const FORM = '100000000000088';
const AUDIENCE = '120000000000050';
// 1x1 transparent PNG.
const PIXEL_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/**
 * Arguments that get each write tool past its own validation to the Graph API
 * (dry_run off). The positive control proves they do.
 */
const WRITE_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  meta_ads_update_ad_url_tags: { ad_id: AD, url_tags: 'utm_source=meta', dry_run: false },
  meta_ads_rename_ad: { ad_id: AD, new_name: 'Gate Test Rename', allow_naming_violations: true },
  meta_ads_swap_ad_lead_form: { ad_id: AD, new_form_id: FORM },
  meta_ads_rebind_ad_creative: { ad_id: AD, creative_id: CREATIVE },
  meta_ads_edit_creative_text: { ad_id: AD, messages: ['Gate test body'] },
  meta_ads_create_campaign: { account_id: ACCOUNT, name: 'Gate Test Campaign', objective: 'OUTCOME_LEADS' },
  meta_ads_create_adset: {
    account_id: ACCOUNT,
    campaign_id: CAMPAIGN,
    name: 'Gate Test Ad Set',
    optimization_goal: 'LEAD_GENERATION',
    billing_event: 'IMPRESSIONS',
    daily_budget: 1000,
    targeting: { geo_locations: { countries: ['US'] } },
  },
  meta_ads_create_ad_creative: {
    account_id: ACCOUNT,
    name: 'Gate Test Creative',
    page_id: PAGE,
    image_hash: '0123456789abcdef0123456789abcdef',
    link: 'https://example.com/',
    message: 'Gate test body',
  },
  meta_ads_create_ad: { account_id: ACCOUNT, name: 'Gate Test Ad', adset_id: ADSET, creative_id: CREATIVE },
  meta_ads_upload_image: { account_id: ACCOUNT, image_bytes: PIXEL_PNG_B64 },
  meta_ads_create_leadgen_form: {
    page_id: PAGE,
    name: 'Gate Test Form',
    privacy_policy: { url: 'https://example.com/privacy' },
    questions: [{ type: 'EMAIL' }],
    thank_you_page: {
      title: 'Thanks',
      body: 'Thanks',
      button_text: 'Visit',
      button_type: 'VIEW_WEBSITE',
      website_url: 'https://example.com/',
    },
  },
  meta_ads_create_custom_audience: { account_id: ACCOUNT, name: 'Gate Test Audience' },
  meta_ads_upload_users_to_audience: { audience_id: AUDIENCE, users: [{ email: 'person@example.com' }] },
  meta_ads_create_lookalike_audience: {
    account_id: ACCOUNT,
    name: 'Gate Test Lookalike',
    origin_audience_id: AUDIENCE,
    country: 'US',
  },
  meta_ads_update_object_status: { object_id: CAMPAIGN, status: 'PAUSED' },
  meta_ads_update_budget: { object_id: ADSET, daily_budget: 5000 },
  meta_ads_delete_object: { object_id: AD },
};

function textOf(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

let client: Client;
let sigpipeListenersBeforeImport = 0;

beforeAll(async () => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('META_ADS_MCP_WRITE', undefined);
  sigpipeListenersBeforeImport = process.listenerCount('SIGPIPE');
  await import('./index.js');
  client = new Client({ name: 'call-site-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(h.clientTransport);
});

afterAll(async () => {
  await client?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  fetchCalls.length = 0;
  vi.stubEnv('META_ADS_MCP_WRITE', undefined);
});

afterEach(() => {
  vi.stubEnv('META_ADS_MCP_WRITE', undefined);
});

describe('index.ts CallTool handler: write gate at the call site', () => {
  const writeNames = [...WRITE_TOOLS].sort();

  it('has call arguments for every write tool', () => {
    // A tool added to WRITE_TOOLS without args here would drop out of the loops below.
    expect(Object.keys(WRITE_TOOL_ARGS).sort()).toEqual(writeNames);
  });

  it('startup made no network or SDK data calls', () => {
    expect(fetchCalls).toEqual([]);
    expect(h.sdkCalls).not.toContain('createAdAccount');
  });

  describe('writes disabled (META_ADS_MCP_WRITE unset)', () => {
    for (const name of writeNames) {
      it(`refuses ${name} before any Graph request`, async () => {
        // An unregistered name is also refused ("Unknown tool"); make sure the
        // refusal below can only come from the gate.
        expect(TOOLS.map((t) => t.name)).toContain(name);

        const result = await client.callTool({ name, arguments: WRITE_TOOL_ARGS[name] });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(WRITE_DISABLED_MESSAGE);
        expect(fetchCalls).toEqual([]);
      });
    }

    it('hides every write tool from tools/list', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const name of writeNames) expect(names).not.toContain(name);
      expect(names).toContain('meta_ads_insights_incrementality');
    });
  });

  describe('positive control: writes enabled (META_ADS_MCP_WRITE=true)', () => {
    for (const name of writeNames) {
      it(`${name} reaches the Graph API, so zero requests above means the gate stopped it`, async () => {
        vi.stubEnv('META_ADS_MCP_WRITE', 'true');

        const result = await client.callTool({ name, arguments: WRITE_TOOL_ARGS[name] });

        expect(textOf(result)).not.toContain(WRITE_DISABLED_MESSAGE);
        expect(fetchCalls.length).toBeGreaterThan(0);
        for (const call of fetchCalls) expect(call.url.startsWith('https://graph.facebook.com/')).toBe(true);
      });
    }

    it('lists every write tool', async () => {
      vi.stubEnv('META_ADS_MCP_WRITE', 'true');
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      for (const name of writeNames) expect(names).toContain(name);
    });
  });
});

/**
 * Create tools that take a status. Each must create PAUSED and refuse any
 * other status before touching the Graph API.
 */
const CREATE_TOOLS_WITH_STATUS = [
  'meta_ads_create_ad',
  'meta_ads_create_adset',
  'meta_ads_create_campaign',
];

describe('create tools are PAUSED only (writes enabled)', () => {
  beforeEach(() => {
    vi.stubEnv('META_ADS_MCP_WRITE', 'true');
  });

  it('covers every create tool that takes a status', () => {
    const withStatus = TOOLS.filter(
      (t) =>
        t.name.includes('_create_') &&
        'status' in ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
    ).map((t) => t.name);
    expect(withStatus.sort()).toEqual(CREATE_TOOLS_WITH_STATUS);
  });

  for (const name of CREATE_TOOLS_WITH_STATUS) {
    for (const status of ['ACTIVE', 'active', 'ARCHIVED', 'DELETED', '']) {
      it(`${name} refuses status=${JSON.stringify(status)} before any Graph request`, async () => {
        const result = await client.callTool({
          name,
          arguments: { ...WRITE_TOOL_ARGS[name], status },
        });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain(`${name} creates objects PAUSED only`);
        expect(textOf(result)).toContain(`then enable it separately with ${ENABLE_TOOL}`);
        expect(fetchCalls).toEqual([]);
      });
    }

    for (const status of [undefined, 'PAUSED', 'paused']) {
      it(`${name} with status=${JSON.stringify(status)} creates PAUSED`, async () => {
        const args = { ...WRITE_TOOL_ARGS[name] };
        if (status !== undefined) args.status = status;

        const result = await client.callTool({ name, arguments: args });

        expect(result.isError ?? false).toBe(false);
        const posts = fetchCalls.filter((c) => c.method === 'POST');
        expect(posts).toHaveLength(1);
        expect(posts[0]?.body.get('status')).toBe('PAUSED');
      });
    }
  }

  it('leaves the update tool free to enable an object', async () => {
    const result = await client.callTool({
      name: 'meta_ads_update_object_status',
      arguments: { object_id: CAMPAIGN, status: 'ACTIVE' },
    });

    expect(result.isError ?? false).toBe(false);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.body.get('status')).toBe('ACTIVE');
  });
});

describe('meta_ads_rebind_ad_creative dry_run at the call site (writes enabled)', () => {
  const OLD_CREATIVE = '120000000000041';

  it('returns the refusal the real call would throw, as a result rather than an error, and writes nothing', async () => {
    vi.stubEnv('META_ADS_MCP_WRITE', 'true');
    // The ad sits on a creative with a per-placement image rule; the new creative has none.
    const restore = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      fetchCalls.push({ url: u.toString(), method: init?.method ?? 'GET', body: new URLSearchParams(init?.body ? String(init.body) : '') });
      const id = u.pathname.split('/').pop();
      const body =
        id === AD
          ? { id: AD, name: 'Call-site ad', creative: { id: OLD_CREATIVE } }
          : id === OLD_CREATIVE
            ? { id, asset_feed_spec: { asset_customization_rules: [{ customization_spec: { publisher_platforms: ['facebook'] } }] } }
            : { id };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const dry = await client.callTool({
        name: 'meta_ads_rebind_ad_creative',
        arguments: { ad_id: AD, creative_id: CREATIVE, dry_run: true },
      });
      const real = await client.callTool({
        name: 'meta_ads_rebind_ad_creative',
        arguments: { ad_id: AD, creative_id: CREATIVE },
      });

      expect(dry.isError ?? false).toBe(false);
      const out = JSON.parse(textOf(dry));
      expect(Object.keys(out).sort()).toEqual([
        'ad_id',
        'ad_name',
        'changed',
        'customization_rules_preserved',
        'new_creative_id',
        'previous_creative_id',
        'would_refuse',
      ]);
      expect(out).toMatchObject({ ad_id: AD, previous_creative_id: OLD_CREATIVE, new_creative_id: CREATIVE, changed: false });
      expect(out.would_refuse).toMatch(/^Refusing to rebind ad /);
      expect(real.isError).toBe(true);
      expect(textOf(real)).toContain(out.would_refuse);
      expect(fetchCalls.filter((c) => c.method === 'POST')).toEqual([]);
    } finally {
      fetchMock.mockImplementation(restore);
    }
  });
});

/**
 * meta_ads_update_ad_url_tags and meta_ads_swap_ad_lead_form build a new
 * creative from the ad's current one. The ad below sits on a creative with a
 * per-placement image rule that the new creative would not carry, so the real
 * call refuses. The refusal must come before the create (no POST at all, so no
 * unattached creative), and the dry run must return it as a result.
 */
describe('create-then-rebind tools refuse before the create, and dry_run reports it, at the call site (writes enabled)', () => {
  const OLD_CREATIVE = '120000000000043';
  const PLACEMENT_RULE = { customization_spec: { publisher_platforms: ['facebook'] }, image_label: { name: 'fb' } };

  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string[]]> = [
    [
      'meta_ads_update_ad_url_tags',
      { ad_id: AD, url_tags: 'utm_source=new' },
      { url_tags: 'utm_source=old', object_story_id: `${PAGE}_1` },
      [
        'ad_id',
        'ad_name',
        'changed',
        'learning_after',
        'learning_before',
        'new_creative_id',
        'new_url_tags',
        'previous_creative_id',
        'previous_url_tags',
        'significant_edit_triggered',
        'would_refuse',
      ],
    ],
    [
      'meta_ads_swap_ad_lead_form',
      { ad_id: AD, new_form_id: FORM },
      {
        object_story_spec: {
          page_id: PAGE,
          link_data: {
            link: 'https://example.com/',
            message: 'Body',
            call_to_action: { type: 'SIGN_UP', value: { lead_gen_form_id: '100000000000077' } },
          },
        },
      },
      ['ad_id', 'ad_name', 'changed', 'mode', 'new_creative_id', 'new_form_id', 'previous_creative_id', 'previous_form_id', 'would_refuse'],
    ],
  ];

  it.each(cases)('%s: the real call refuses with no POST, and the dry run returns that refusal', async (name, args, creative, keys) => {
    vi.stubEnv('META_ADS_MCP_WRITE', 'true');
    const restore = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      fetchCalls.push({ url: u.toString(), method: init?.method ?? 'GET', body: new URLSearchParams(init?.body ? String(init.body) : '') });
      const id = u.pathname.split('/').pop();
      const body =
        id === AD
          ? {
              id: AD,
              name: 'Call-site ad',
              account_id: ACCOUNT.replace(/^act_/, ''),
              campaign_id: CAMPAIGN,
              creative: { id: OLD_CREATIVE, ...creative },
            }
          : id === OLD_CREATIVE
            ? { id, asset_feed_spec: { asset_customization_rules: [PLACEMENT_RULE] } }
            : { id };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const dry = await client.callTool({ name, arguments: { ...args, dry_run: true } });
      const real = await client.callTool({ name, arguments: args });

      expect(dry.isError ?? false).toBe(false);
      const out = JSON.parse(textOf(dry));
      expect(Object.keys(out).sort()).toEqual(keys);
      expect(out).toMatchObject({ ad_id: AD, previous_creative_id: OLD_CREATIVE, new_creative_id: '', changed: true });
      expect(out.would_refuse).toMatch(/^Refusing to rebind ad .*Nothing was created or changed/s);
      expect(real.isError).toBe(true);
      expect(textOf(real)).toContain(out.would_refuse);
      expect(fetchCalls.filter((c) => c.method === 'POST')).toEqual([]);
    } finally {
      fetchMock.mockImplementation(restore);
    }
  });

  it('meta_ads_edit_creative_text: the real call refuses with no POST, and the dry run returns that refusal', async () => {
    vi.stubEnv('META_ADS_MCP_WRITE', 'true');
    // A legacy link_data creative: the rebuild has nowhere to put the placement rule.
    const restore = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      fetchCalls.push({ url: u.toString(), method: init?.method ?? 'GET', body: new URLSearchParams(init?.body ? String(init.body) : '') });
      const id = u.pathname.split('/').pop();
      const body =
        id === AD
          ? {
              id: AD,
              name: 'Call-site ad',
              account_id: ACCOUNT.replace(/^act_/, ''),
              creative: {
                id: OLD_CREATIVE,
                object_story_spec: { page_id: PAGE, link_data: { link: 'https://example.com/', message: 'Body', name: 'Headline' } },
              },
            }
          : id === OLD_CREATIVE
            ? { id, asset_feed_spec: { asset_customization_rules: [PLACEMENT_RULE] } }
            : { id };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const args = { ad_id: AD, headlines: ['New headline'] };
      const dry = await client.callTool({ name: 'meta_ads_edit_creative_text', arguments: { ...args, dry_run: true } });
      const real = await client.callTool({ name: 'meta_ads_edit_creative_text', arguments: args });

      expect(dry.isError ?? false).toBe(false);
      const out = JSON.parse(textOf(dry));
      expect(Object.keys(out).sort()).toEqual([
        'ad_id',
        'ad_name',
        'changed_fields',
        'customization_rules_preserved',
        'mode',
        'new_creative_id',
        'previous_creative_id',
        'would_refuse',
      ]);
      expect(out).toMatchObject({ ad_id: AD, previous_creative_id: OLD_CREATIVE, new_creative_id: '', changed_fields: ['headlines'] });
      expect(out.would_refuse).toMatch(/^Refusing to rebind ad .*Nothing was created or changed/s);
      expect(real.isError).toBe(true);
      expect(textOf(real)).toContain(out.would_refuse);
      expect(fetchCalls.filter((c) => c.method === 'POST')).toEqual([]);
    } finally {
      fetchMock.mockImplementation(restore);
    }
  });
});

describe('meta_ads_edit_creative_text dry_run at the call site (writes enabled)', () => {
  const OLD_CREATIVE = '120000000000042';

  it('returns the label-orphaning refusal the real call would throw, as a result rather than an error, and writes nothing', async () => {
    vi.stubEnv('META_ADS_MCP_WRITE', 'true');
    // A two-body asset-feed ad whose placement rule references a body label; the edit drops to one body.
    const restore = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      fetchCalls.push({ url: u.toString(), method: init?.method ?? 'GET', body: new URLSearchParams(init?.body ? String(init.body) : '') });
      const id = u.pathname.split('/').pop();
      const body =
        id === AD
          ? {
              id: AD,
              name: 'Call-site ad',
              account_id: ACCOUNT.replace(/^act_/, ''),
              creative: {
                id: OLD_CREATIVE,
                object_story_spec: { page_id: PAGE },
                asset_feed_spec: {
                  bodies: [{ text: 'Body A' }, { text: 'Body B' }],
                  asset_customization_rules: [
                    { customization_spec: { publisher_platforms: ['facebook'] }, body_label: { name: 'b1' } },
                  ],
                },
              },
            }
          : { id };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    try {
      const dry = await client.callTool({
        name: 'meta_ads_edit_creative_text',
        arguments: { ad_id: AD, messages: ['Only one'], dry_run: true },
      });
      const real = await client.callTool({
        name: 'meta_ads_edit_creative_text',
        arguments: { ad_id: AD, messages: ['Only one'] },
      });

      expect(dry.isError ?? false).toBe(false);
      const out = JSON.parse(textOf(dry));
      expect(Object.keys(out).sort()).toEqual([
        'ad_id',
        'ad_name',
        'changed_fields',
        'customization_rules_preserved',
        'mode',
        'new_creative_id',
        'previous_creative_id',
        'would_refuse',
      ]);
      expect(out).toMatchObject({ ad_id: AD, previous_creative_id: OLD_CREATIVE, new_creative_id: '', changed_fields: ['messages'] });
      expect(out.would_refuse).toMatch(/^Refusing to edit messages on ad /);
      expect(real.isError).toBe(true);
      expect(textOf(real)).toContain(out.would_refuse);
      expect(fetchCalls.filter((c) => c.method === 'POST')).toEqual([]);
    } finally {
      fetchMock.mockImplementation(restore);
    }
  });
});

describe('index.ts process handlers', () => {
  // Writing to a pipe the client has closed raises SIGPIPE. The sibling
  // servers register a no-op handler for it, and the shared harness's
  // graceful-shutdown suite requires one. This checks the real entrypoint
  // registers it when it starts, and that the handler does not throw.
  it('registers a SIGPIPE listener at startup', () => {
    const added = process.listeners('SIGPIPE').slice(sigpipeListenersBeforeImport);
    expect(added.length).toBeGreaterThan(0);
    for (const listener of added) expect(() => (listener as () => void)()).not.toThrow();
  });
});
