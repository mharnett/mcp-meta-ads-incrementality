import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MetaInsightsClient,
  type MetaSdkLike,
  type GetInsightsParams,
  type SdkAdAccount,
  type SdkCursor,
  normalizeAccountId,
} from './meta-client.js';
import type { MetaInsightsRow } from './insights.js';

/* ------------------------------------------------------------------------- */
/* Test doubles                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Build a fake Cursor that mimics facebook-nodejs-business-sdk's behavior:
 * the cursor is an Array populated with the current page's items, and `next()`
 * mutates that same array to contain the next page. We wrap each row as
 * `{ _data: row }` to exercise the production unwrap path.
 */
function makeCursor(pages: MetaInsightsRow[][]): SdkCursor {
  const items: Array<{ _data: MetaInsightsRow }> = [];
  let pageIndex = 0;

  function loadPage(idx: number): void {
    items.length = 0;
    if (idx < pages.length) {
      for (const row of pages[idx]!) items.push({ _data: row });
    }
  }

  // Prime page 0
  loadPage(0);

  const cursor = items as unknown as SdkCursor & {
    hasNext(): boolean;
    next(): Promise<unknown>;
  };
  Object.defineProperty(cursor, 'hasNext', {
    value: () => pageIndex < pages.length - 1,
  });
  Object.defineProperty(cursor, 'next', {
    value: async () => {
      pageIndex++;
      loadPage(pageIndex);
    },
  });
  return cursor;
}

interface FakeSdk extends MetaSdkLike {
  initCalls: string[];
  createdAccounts: string[];
  lastGetInsightsCall:
    | { fields: string[]; params: Record<string, unknown> }
    | null;
  nextCursorPages: MetaInsightsRow[][];
  getInsightsError: Error | null;
}

function createFakeSdk(initial: Partial<FakeSdk> = {}): FakeSdk {
  const state: FakeSdk = {
    initCalls: [],
    createdAccounts: [],
    lastGetInsightsCall: null,
    nextCursorPages: [],
    getInsightsError: null,
    init(token: string) {
      state.initCalls.push(token);
    },
    createAdAccount(accountId: string): SdkAdAccount {
      state.createdAccounts.push(accountId);
      return {
        async getInsights(fields: string[], params: Record<string, unknown>) {
          state.lastGetInsightsCall = { fields, params };
          if (state.getInsightsError) throw state.getInsightsError;
          return makeCursor(state.nextCursorPages);
        },
      };
    },
    ...initial,
  };
  return state;
}

const BASIC_PARAMS: GetInsightsParams = {
  accountId: 'act_123',
  dateRange: { since: '2026-03-01', until: '2026-03-31' },
  attributionWindows: ['incrementality'],
  level: 'campaign',
};

/* ------------------------------------------------------------------------- */
/* normalizeAccountId — pure helper                                          */
/* ------------------------------------------------------------------------- */

describe('normalizeAccountId', () => {
  it('passes through an already-prefixed account id', () => {
    expect(normalizeAccountId('act_123456')).toBe('act_123456');
  });

  it('adds the act_ prefix to a bare numeric id', () => {
    expect(normalizeAccountId('123456')).toBe('act_123456');
  });

  it('adds the act_ prefix to a numeric id passed as a number', () => {
    expect(normalizeAccountId(123456 as unknown as string)).toBe('act_123456');
  });

  it('throws on an empty string', () => {
    expect(() => normalizeAccountId('')).toThrow();
  });

  it('throws on null', () => {
    expect(() => normalizeAccountId(null as unknown as string)).toThrow();
  });

  it('throws on a non-numeric string with no act_ prefix', () => {
    expect(() => normalizeAccountId('abc')).toThrow();
  });
});

/* ------------------------------------------------------------------------- */
/* MetaInsightsClient                                                         */
/* ------------------------------------------------------------------------- */

describe('MetaInsightsClient', () => {
  let sdk: FakeSdk;

  beforeEach(() => {
    sdk = createFakeSdk();
  });

  describe('construction', () => {
    it('calls sdk.init with the access token on construction', () => {
      new MetaInsightsClient(sdk, 'token-abc');
      expect(sdk.initCalls).toEqual(['token-abc']);
    });

    it('throws if accessToken is empty', () => {
      expect(() => new MetaInsightsClient(sdk, '')).toThrow();
    });

    it('throws if accessToken is undefined', () => {
      expect(() => new MetaInsightsClient(sdk, undefined as unknown as string)).toThrow();
    });
  });

  describe('getInsights — request shape', () => {
    it('creates an AdAccount with the normalized act_-prefixed id', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({ ...BASIC_PARAMS, accountId: '987654' });
      expect(sdk.createdAccounts).toEqual(['act_987654']);
    });

    it('passes through an already-prefixed id without double-prefixing', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({ ...BASIC_PARAMS, accountId: 'act_111' });
      expect(sdk.createdAccounts).toEqual(['act_111']);
    });

    it('requests the standard insights fields by default', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights(BASIC_PARAMS);
      const fields = sdk.lastGetInsightsCall!.fields;
      expect(fields).toContain('spend');
      expect(fields).toContain('actions');
      expect(fields).toContain('action_values');
      expect(fields).toContain('date_start');
      expect(fields).toContain('date_stop');
    });

    it('includes campaign_id and campaign_name when level=campaign', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({ ...BASIC_PARAMS, level: 'campaign' });
      const fields = sdk.lastGetInsightsCall!.fields;
      expect(fields).toContain('campaign_id');
      expect(fields).toContain('campaign_name');
    });

    it('includes adset_id and adset_name when level=adset', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({ ...BASIC_PARAMS, level: 'adset' });
      const fields = sdk.lastGetInsightsCall!.fields;
      expect(fields).toContain('adset_id');
      expect(fields).toContain('adset_name');
    });

    it('includes ad_id and ad_name when level=ad', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({ ...BASIC_PARAMS, level: 'ad' });
      const fields = sdk.lastGetInsightsCall!.fields;
      expect(fields).toContain('ad_id');
      expect(fields).toContain('ad_name');
    });

    it('passes time_range with since/until from dateRange', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights(BASIC_PARAMS);
      expect(sdk.lastGetInsightsCall!.params.time_range).toEqual({
        since: '2026-03-01',
        until: '2026-03-31',
      });
    });

    it('passes the attribution windows verbatim as action_attribution_windows', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({
        ...BASIC_PARAMS,
        attributionWindows: ['incrementality', '7d_click', '1d_view', 'dda'],
      });
      expect(sdk.lastGetInsightsCall!.params.action_attribution_windows).toEqual([
        'incrementality',
        '7d_click',
        '1d_view',
        'dda',
      ]);
    });

    it('always sets use_unified_attribution_setting=true (post-June-2025 unification)', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights(BASIC_PARAMS);
      expect(sdk.lastGetInsightsCall!.params.use_unified_attribution_setting).toBe(true);
    });

    it('passes the level on the params', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({ ...BASIC_PARAMS, level: 'adset' });
      expect(sdk.lastGetInsightsCall!.params.level).toBe('adset');
    });

    it('passes breakdowns when provided', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({
        ...BASIC_PARAMS,
        breakdowns: ['publisher_platform', 'platform_position'],
      });
      expect(sdk.lastGetInsightsCall!.params.breakdowns).toEqual([
        'publisher_platform',
        'platform_position',
      ]);
    });

    it('does not include breakdowns key when not provided', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights(BASIC_PARAMS);
      expect(sdk.lastGetInsightsCall!.params).not.toHaveProperty('breakdowns');
    });

    it('filters by campaign_id when provided', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({ ...BASIC_PARAMS, campaignId: '12345' });
      const filtering = sdk.lastGetInsightsCall!.params.filtering as Array<{
        field: string;
        operator: string;
        value: string;
      }>;
      expect(filtering).toContainEqual({
        field: 'campaign.id',
        operator: 'EQUAL',
        value: '12345',
      });
    });

    it('filters by adset_id when provided', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      await client.getInsights({ ...BASIC_PARAMS, adsetId: '67890' });
      const filtering = sdk.lastGetInsightsCall!.params.filtering as Array<{
        field: string;
        operator: string;
        value: string;
      }>;
      expect(filtering).toContainEqual({
        field: 'adset.id',
        operator: 'EQUAL',
        value: '67890',
      });
    });
  });

  describe('getInsights — response handling', () => {
    it('returns an empty array when the cursor yields no pages', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [];
      const result = await client.getInsights(BASIC_PARAMS);
      expect(result).toEqual([]);
    });

    it('returns an empty array when the cursor yields one empty page', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [[]];
      const result = await client.getInsights(BASIC_PARAMS);
      expect(result).toEqual([]);
    });

    it('unwraps SDK row objects to their _data payload', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      const row: MetaInsightsRow = {
        spend: '100',
        date_start: '2026-03-01',
        date_stop: '2026-03-31',
        actions: [{ action_type: 'purchase', value: '5' }],
      };
      sdk.nextCursorPages = [[row]];
      const result = await client.getInsights(BASIC_PARAMS);
      expect(result).toEqual([row]);
    });

    it('exhausts a multi-page cursor in order', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.nextCursorPages = [
        [{ campaign_id: '1' }, { campaign_id: '2' }],
        [{ campaign_id: '3' }],
        [{ campaign_id: '4' }, { campaign_id: '5' }],
      ];
      const result = await client.getInsights(BASIC_PARAMS);
      expect(result.map((r) => r.campaign_id)).toEqual(['1', '2', '3', '4', '5']);
    });
  });

  describe('getInsights — error handling', () => {
    it('propagates errors from the SDK with the original message', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      sdk.getInsightsError = new Error('Invalid OAuth access token');
      await expect(client.getInsights(BASIC_PARAMS)).rejects.toThrow(
        /Invalid OAuth access token/,
      );
    });

    it('does not swallow non-Error throws', async () => {
      const client = new MetaInsightsClient(sdk, 'token');
      const fakeSdk: MetaSdkLike = {
        init: vi.fn(),
        createAdAccount: () => ({
          async getInsights() {
            throw 'string error';
          },
        }),
      };
      const fakeClient = new MetaInsightsClient(fakeSdk, 'token');
      await expect(fakeClient.getInsights(BASIC_PARAMS)).rejects.toBeTruthy();
    });
  });
});
