import type { AttributionWindow } from './attribution.js';
import type { MetaInsightsRow } from './insights.js';

/* ------------------------------------------------------------------------- */
/* SDK shape — minimal interface this module needs from facebook-nodejs-business-sdk */
/* ------------------------------------------------------------------------- */

/**
 * The minimal subset of `facebook-nodejs-business-sdk`'s surface that this MCP
 * actually depends on. Defining it as an interface lets us inject a fake in
 * unit tests without having to mock the SDK module wholesale.
 *
 * The real SDK adapter is created by `createDefaultMetaSdk()` in this same module.
 */
export interface MetaSdkLike {
  init(accessToken: string): void;
  createAdAccount(accountId: string): SdkAdAccount;
}

export interface SdkAdAccount {
  getInsights(fields: string[], params: Record<string, unknown>): Promise<SdkCursor>;
}

/**
 * Matches `Cursor` from facebook-nodejs-business-sdk: an Array-like that holds
 * the current page's items and exposes `hasNext()` / `next()` for pagination.
 *
 * Items in the cursor are SDK-wrapped objects whose raw payload sits on `_data`;
 * we unwrap during iteration so callers always see plain `MetaInsightsRow`.
 * Plain object literals (no `_data`) are also accepted and used directly, which
 * keeps unit-test fakes simple.
 */
export interface SdkCursor extends ReadonlyArray<SdkCursorItem> {
  hasNext(): boolean;
  next(): Promise<unknown>;
}

export type SdkCursorItem = { _data?: MetaInsightsRow } & Partial<MetaInsightsRow>;

/* ------------------------------------------------------------------------- */
/* Domain types                                                              */
/* ------------------------------------------------------------------------- */

export type InsightsLevel = 'account' | 'campaign' | 'adset' | 'ad';

export interface DateRange {
  /** Inclusive start date in YYYY-MM-DD form. */
  since: string;
  /** Inclusive end date in YYYY-MM-DD form. */
  until: string;
}

export interface GetInsightsParams {
  /** Meta ad account id. May be passed with or without the `act_` prefix. */
  accountId: string;
  dateRange: DateRange;
  attributionWindows: readonly AttributionWindow[];
  level: InsightsLevel;
  /** Optional Meta-supported breakdowns (e.g. `publisher_platform`, `age`). */
  breakdowns?: readonly string[];
  /** Restrict to a single campaign by id. */
  campaignId?: string;
  /** Restrict to a single ad set by id. */
  adsetId?: string;
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Normalize a Meta ad account id into the `act_<numeric>` form Meta requires.
 * Accepts strings or numbers, with or without the `act_` prefix.
 */
export function normalizeAccountId(input: string | number | null | undefined): string {
  if (input == null) {
    throw new Error('accountId is required');
  }
  const s = typeof input === 'number' ? String(input) : input;
  if (s === '') {
    throw new Error('accountId is required');
  }
  if (s.startsWith('act_')) {
    const rest = s.slice(4);
    if (!/^\d+$/.test(rest)) {
      throw new Error(`accountId must be numeric after the act_ prefix, got "${s}"`);
    }
    return s;
  }
  if (!/^\d+$/.test(s)) {
    throw new Error(`accountId must be numeric or act_-prefixed, got "${s}"`);
  }
  return `act_${s}`;
}

function fieldsForLevel(level: InsightsLevel): string[] {
  const base = ['date_start', 'date_stop', 'spend', 'actions', 'action_values'];
  switch (level) {
    case 'account':
      return base;
    case 'campaign':
      return [...base, 'campaign_id', 'campaign_name'];
    case 'adset':
      return [...base, 'campaign_id', 'campaign_name', 'adset_id', 'adset_name'];
    case 'ad':
      return [
        ...base,
        'campaign_id',
        'campaign_name',
        'adset_id',
        'adset_name',
        'ad_id',
        'ad_name',
      ];
  }
}

/* ------------------------------------------------------------------------- */
/* MetaInsightsClient                                                         */
/* ------------------------------------------------------------------------- */

export class MetaInsightsClient {
  constructor(
    private readonly sdk: MetaSdkLike,
    accessToken: string,
  ) {
    if (!accessToken) {
      throw new Error('accessToken is required');
    }
    sdk.init(accessToken);
  }

  async getInsights(input: GetInsightsParams): Promise<MetaInsightsRow[]> {
    const accountId = normalizeAccountId(input.accountId);
    const account = this.sdk.createAdAccount(accountId);

    const fields = fieldsForLevel(input.level);

    const params: Record<string, unknown> = {
      level: input.level,
      time_range: { since: input.dateRange.since, until: input.dateRange.until },
      action_attribution_windows: [...input.attributionWindows],
      use_unified_attribution_setting: true,
    };

    if (input.breakdowns && input.breakdowns.length > 0) {
      params.breakdowns = [...input.breakdowns];
    }

    const filtering: Array<{ field: string; operator: string; value: string }> = [];
    if (input.campaignId) {
      filtering.push({ field: 'campaign.id', operator: 'EQUAL', value: input.campaignId });
    }
    if (input.adsetId) {
      filtering.push({ field: 'adset.id', operator: 'EQUAL', value: input.adsetId });
    }
    if (filtering.length > 0) {
      params.filtering = filtering;
    }

    const cursor = await account.getInsights(fields, params);

    const rows: MetaInsightsRow[] = [];
    let page: SdkCursor | null = cursor;
    while (page !== null) {
      for (const item of page) {
        rows.push(item._data ?? (item as MetaInsightsRow));
      }
      if (page.hasNext()) {
        await page.next();
        // Cursor mutates in place — same reference, new page contents.
      } else {
        page = null;
      }
    }
    return rows;
  }
}

/* ------------------------------------------------------------------------- */
/* Default SDK adapter — wraps facebook-nodejs-business-sdk                   */
/* ------------------------------------------------------------------------- */

/**
 * Create the production `MetaSdkLike` adapter that delegates to the real
 * `facebook-nodejs-business-sdk`. Imported lazily so unit tests that inject
 * fakes never have to load the SDK.
 */
export async function createDefaultMetaSdk(): Promise<MetaSdkLike> {
  const sdkModule = await import('facebook-nodejs-business-sdk');
  return {
    init(token: string): void {
      sdkModule.FacebookAdsApi.init(token);
    },
    createAdAccount(accountId: string): SdkAdAccount {
      const account = new sdkModule.AdAccount(accountId);
      return {
        async getInsights(fields, params) {
          // SDK returns Cursor | Promise<Cursor>; await normalizes both.
          // Type cast bridges the SDK's loose Record<string, any> items to our SdkCursor shape.
          const cursor = await account.getInsights(fields, params);
          return cursor as unknown as SdkCursor;
        },
      };
    },
  };
}
