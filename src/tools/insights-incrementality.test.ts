import { describe, it, expect, beforeEach } from 'vitest';
import {
  runInsightsIncrementality,
  insightsIncrementalityInputSchema,
  type InsightsIncrementalityDeps,
} from './insights-incrementality.js';
import type { GetInsightsParams } from '../lib/meta-client.js';
import type { MetaInsightsRow } from '../lib/insights.js';

/* ------------------------------------------------------------------------- */
/* Fake meta client                                                          */
/* ------------------------------------------------------------------------- */

interface FakeMetaClient {
  lastCall: GetInsightsParams | null;
  nextRows: MetaInsightsRow[];
  nextError: Error | null;
  getInsights(params: GetInsightsParams): Promise<MetaInsightsRow[]>;
}

function createFakeMetaClient(): FakeMetaClient {
  const state: FakeMetaClient = {
    lastCall: null,
    nextRows: [],
    nextError: null,
    async getInsights(params: GetInsightsParams) {
      state.lastCall = params;
      if (state.nextError) throw state.nextError;
      return state.nextRows;
    },
  };
  return state;
}

function makeDeps(client: FakeMetaClient): InsightsIncrementalityDeps {
  return { metaClient: { getInsights: (p) => client.getInsights(p) } };
}

const VALID_INPUT = {
  ad_account_id: 'act_123',
  date_range: { since: '2026-03-01', until: '2026-03-31' },
  conversion_event_name: 'offsite_conversion.fb_pixel_purchase',
};

/* ------------------------------------------------------------------------- */
/* Input schema                                                              */
/* ------------------------------------------------------------------------- */

describe('insightsIncrementalityInputSchema', () => {
  it('accepts the minimum valid input', () => {
    const parsed = insightsIncrementalityInputSchema.parse(VALID_INPUT);
    expect(parsed.ad_account_id).toBe('act_123');
    expect(parsed.conversion_event_name).toBe('offsite_conversion.fb_pixel_purchase');
  });

  it('requires ad_account_id', () => {
    const { ad_account_id: _drop, ...rest } = VALID_INPUT;
    expect(() => insightsIncrementalityInputSchema.parse(rest)).toThrow();
  });

  it('requires date_range', () => {
    const { date_range: _drop, ...rest } = VALID_INPUT;
    expect(() => insightsIncrementalityInputSchema.parse(rest)).toThrow();
  });

  it('requires date_range.since', () => {
    expect(() =>
      insightsIncrementalityInputSchema.parse({
        ...VALID_INPUT,
        date_range: { until: '2026-03-31' },
      }),
    ).toThrow();
  });

  it('requires date_range.until', () => {
    expect(() =>
      insightsIncrementalityInputSchema.parse({
        ...VALID_INPUT,
        date_range: { since: '2026-03-01' },
      }),
    ).toThrow();
  });

  it('rejects malformed dates', () => {
    expect(() =>
      insightsIncrementalityInputSchema.parse({
        ...VALID_INPUT,
        date_range: { since: 'last-week', until: '2026-03-31' },
      }),
    ).toThrow();
  });

  it('requires conversion_event_name', () => {
    const { conversion_event_name: _drop, ...rest } = VALID_INPUT;
    expect(() => insightsIncrementalityInputSchema.parse(rest)).toThrow();
  });

  it('rejects empty conversion_event_name', () => {
    expect(() =>
      insightsIncrementalityInputSchema.parse({ ...VALID_INPUT, conversion_event_name: '' }),
    ).toThrow();
  });

  it('defaults attribution_windows to [incrementality] when omitted', () => {
    const parsed = insightsIncrementalityInputSchema.parse(VALID_INPUT);
    expect(parsed.attribution_windows).toEqual(['incrementality']);
  });

  it('defaults level to campaign when omitted', () => {
    const parsed = insightsIncrementalityInputSchema.parse(VALID_INPUT);
    expect(parsed.level).toBe('campaign');
  });

  it('accepts a custom attribution_windows array', () => {
    const parsed = insightsIncrementalityInputSchema.parse({
      ...VALID_INPUT,
      attribution_windows: ['7d_click', '1d_view'],
    });
    expect(parsed.attribution_windows).toEqual(['7d_click', '1d_view']);
  });

  it('rejects an invalid attribution window', () => {
    expect(() =>
      insightsIncrementalityInputSchema.parse({
        ...VALID_INPUT,
        attribution_windows: ['7d_view'],
      }),
    ).toThrow();
  });

  it('rejects an invalid level', () => {
    expect(() =>
      insightsIncrementalityInputSchema.parse({ ...VALID_INPUT, level: 'pixel' }),
    ).toThrow();
  });

  it('accepts breakdowns as optional string array', () => {
    const parsed = insightsIncrementalityInputSchema.parse({
      ...VALID_INPUT,
      breakdowns: ['publisher_platform'],
    });
    expect(parsed.breakdowns).toEqual(['publisher_platform']);
  });

  it('accepts campaign_id and adset_id filters', () => {
    const parsed = insightsIncrementalityInputSchema.parse({
      ...VALID_INPUT,
      campaign_id: '123',
      adset_id: '456',
    });
    expect(parsed.campaign_id).toBe('123');
    expect(parsed.adset_id).toBe('456');
  });
});

/* ------------------------------------------------------------------------- */
/* runInsightsIncrementality — happy path & call construction                */
/* ------------------------------------------------------------------------- */

describe('runInsightsIncrementality — happy path', () => {
  let client: FakeMetaClient;

  beforeEach(() => {
    client = createFakeMetaClient();
  });

  it('passes through ad_account_id, date_range, level, and incrementality default to meta client', async () => {
    client.nextRows = [];
    await runInsightsIncrementality(VALID_INPUT, makeDeps(client));
    expect(client.lastCall).toMatchObject({
      accountId: 'act_123',
      dateRange: { since: '2026-03-01', until: '2026-03-31' },
      level: 'campaign',
      attributionWindows: ['incrementality'],
    });
  });

  it('passes through campaign_id and adset_id when provided', async () => {
    client.nextRows = [];
    await runInsightsIncrementality(
      { ...VALID_INPUT, campaign_id: '111', adset_id: '222' },
      makeDeps(client),
    );
    expect(client.lastCall?.campaignId).toBe('111');
    expect(client.lastCall?.adsetId).toBe('222');
  });

  it('passes through breakdowns when provided', async () => {
    client.nextRows = [];
    await runInsightsIncrementality(
      { ...VALID_INPUT, breakdowns: ['publisher_platform', 'age'] },
      makeDeps(client),
    );
    expect(client.lastCall?.breakdowns).toEqual(['publisher_platform', 'age']);
  });

  it('returns rows containing extracted conversions and spend', async () => {
    client.nextRows = [
      {
        date_start: '2026-03-01',
        date_stop: '2026-03-31',
        spend: '500',
        campaign_id: 'c1',
        campaign_name: 'Brand',
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            incrementality: '40',
          },
        ],
      },
    ];

    const result = await runInsightsIncrementality(VALID_INPUT, makeDeps(client));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.spend).toBe(500);
    expect(result.rows[0]?.conversions.incrementality).toBe(40);
    expect(result.rows[0]?.campaign_id).toBe('c1');
    expect(result.rows[0]?.campaign_name).toBe('Brand');
  });

  it('returns meta block describing the request', async () => {
    client.nextRows = [];
    const result = await runInsightsIncrementality(VALID_INPUT, makeDeps(client));
    expect(result.meta).toEqual({
      ad_account_id: 'act_123',
      date_range: { since: '2026-03-01', until: '2026-03-31' },
      level: 'campaign',
      conversion_event_name: 'offsite_conversion.fb_pixel_purchase',
      attribution_windows: ['incrementality'],
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Comparison mode — incrementality vs default agency reporting              */
/* ------------------------------------------------------------------------- */

describe('runInsightsIncrementality — comparison mode', () => {
  let client: FakeMetaClient;

  beforeEach(() => {
    client = createFakeMetaClient();
  });

  it('computes inflation_factor on each row when incrementality + 7d_click + 1d_view all requested', async () => {
    // 7d_click=80, 1d_view=20, incrementality=40 → default attributed=100, inflation=2.5x
    client.nextRows = [
      {
        spend: '500',
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            '7d_click': '80',
            '1d_view': '20',
            incrementality: '40',
          },
        ],
      },
    ];

    const result = await runInsightsIncrementality(
      {
        ...VALID_INPUT,
        attribution_windows: ['incrementality', '7d_click', '1d_view'],
      },
      makeDeps(client),
    );

    expect(result.rows[0]?.default_attributed).toBe(100);
    expect(result.rows[0]?.inflation_factor).toBeCloseTo(2.5, 5);
    expect(result.rows[0]?.overstatement_pct).toBeCloseTo(60, 5);
  });

  it('returns null inflation_factor when incrementality is not in the requested windows', async () => {
    client.nextRows = [
      {
        spend: '500',
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            '7d_click': '80',
            '1d_view': '20',
          },
        ],
      },
    ];

    const result = await runInsightsIncrementality(
      { ...VALID_INPUT, attribution_windows: ['7d_click', '1d_view'] },
      makeDeps(client),
    );

    expect(result.rows[0]?.inflation_factor).toBeNull();
    expect(result.rows[0]?.overstatement_pct).toBeNull();
    expect(result.rows[0]?.default_attributed).toBeNull();
  });

  it('returns null inflation_factor when default windows not requested', async () => {
    client.nextRows = [
      {
        spend: '500',
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            incrementality: '40',
          },
        ],
      },
    ];

    const result = await runInsightsIncrementality(VALID_INPUT, makeDeps(client));

    expect(result.rows[0]?.inflation_factor).toBeNull();
    expect(result.rows[0]?.default_attributed).toBeNull();
  });

  it('handles incrementality=0 (no defined inflation, returns null)', async () => {
    client.nextRows = [
      {
        spend: '500',
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            '7d_click': '50',
            '1d_view': '10',
            incrementality: '0',
          },
        ],
      },
    ];

    const result = await runInsightsIncrementality(
      {
        ...VALID_INPUT,
        attribution_windows: ['incrementality', '7d_click', '1d_view'],
      },
      makeDeps(client),
    );

    expect(result.rows[0]?.default_attributed).toBe(60);
    expect(result.rows[0]?.inflation_factor).toBeNull();
    expect(result.rows[0]?.overstatement_pct).toBeNull();
  });

  it('uses 7d_click alone as default when 1d_view not requested', async () => {
    client.nextRows = [
      {
        spend: '500',
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            '7d_click': '80',
            incrementality: '40',
          },
        ],
      },
    ];

    const result = await runInsightsIncrementality(
      { ...VALID_INPUT, attribution_windows: ['incrementality', '7d_click'] },
      makeDeps(client),
    );

    expect(result.rows[0]?.default_attributed).toBe(80);
    expect(result.rows[0]?.inflation_factor).toBe(2);
  });
});

/* ------------------------------------------------------------------------- */
/* Summary aggregation                                                       */
/* ------------------------------------------------------------------------- */

describe('runInsightsIncrementality — summary aggregation', () => {
  let client: FakeMetaClient;

  beforeEach(() => {
    client = createFakeMetaClient();
  });

  it('sums spend across rows', async () => {
    client.nextRows = [
      { spend: '100', actions: [] },
      { spend: '250', actions: [] },
      { spend: '50.5', actions: [] },
    ];
    const result = await runInsightsIncrementality(VALID_INPUT, makeDeps(client));
    expect(result.summary.total_spend).toBeCloseTo(400.5, 5);
  });

  it('sums conversions per window across rows', async () => {
    client.nextRows = [
      {
        spend: '100',
        actions: [{ action_type: 'purchase', incrementality: '5', '7d_click': '15' }],
      },
      {
        spend: '100',
        actions: [{ action_type: 'purchase', incrementality: '10', '7d_click': '30' }],
      },
    ];
    const result = await runInsightsIncrementality(
      {
        ...VALID_INPUT,
        conversion_event_name: 'purchase',
        attribution_windows: ['incrementality', '7d_click'],
      },
      makeDeps(client),
    );
    expect(result.summary.total_conversions.incrementality).toBe(15);
    expect(result.summary.total_conversions['7d_click']).toBe(45);
  });

  it('computes summary inflation_factor from totals (not averaging row-level)', async () => {
    // Row 1: incrementality=5, 7d_click=15 (3x)
    // Row 2: incrementality=10, 7d_click=20 (2x)
    // Totals: incrementality=15, 7d_click=35
    // Summary inflation = 35/15 ≈ 2.333 (NOT the average of 3 and 2 = 2.5)
    client.nextRows = [
      {
        spend: '100',
        actions: [{ action_type: 'purchase', incrementality: '5', '7d_click': '15' }],
      },
      {
        spend: '100',
        actions: [{ action_type: 'purchase', incrementality: '10', '7d_click': '20' }],
      },
    ];
    const result = await runInsightsIncrementality(
      {
        ...VALID_INPUT,
        conversion_event_name: 'purchase',
        attribution_windows: ['incrementality', '7d_click'],
      },
      makeDeps(client),
    );
    expect(result.summary.inflation_factor).toBeCloseTo(35 / 15, 5);
  });

  it('computes summary CPA per window (spend / conversions)', async () => {
    client.nextRows = [
      {
        spend: '500',
        actions: [{ action_type: 'purchase', incrementality: '10' }],
      },
    ];
    const result = await runInsightsIncrementality(
      { ...VALID_INPUT, conversion_event_name: 'purchase' },
      makeDeps(client),
    );
    expect(result.summary.cpa.incrementality).toBe(50);
  });

  it('returns null cpa when conversions are 0 (avoid divide-by-zero)', async () => {
    client.nextRows = [{ spend: '500', actions: [] }];
    const result = await runInsightsIncrementality(VALID_INPUT, makeDeps(client));
    expect(result.summary.cpa.incrementality).toBeNull();
  });

  it('returns 0 spend and empty conversions on empty rows', async () => {
    client.nextRows = [];
    const result = await runInsightsIncrementality(VALID_INPUT, makeDeps(client));
    expect(result.summary.total_spend).toBe(0);
    expect(result.summary.total_conversions).toEqual({ incrementality: 0 });
    expect(result.rows).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
/* Error propagation                                                         */
/* ------------------------------------------------------------------------- */

describe('runInsightsIncrementality — error handling', () => {
  it('propagates meta client errors', async () => {
    const client = createFakeMetaClient();
    client.nextError = new Error('OAuthException: invalid token');
    await expect(
      runInsightsIncrementality(VALID_INPUT, makeDeps(client)),
    ).rejects.toThrow(/OAuthException/);
  });

  it('throws a Zod error on invalid input rather than calling the client', async () => {
    const client = createFakeMetaClient();
    await expect(
      runInsightsIncrementality(
        { ...VALID_INPUT, ad_account_id: undefined } as unknown,
        makeDeps(client),
      ),
    ).rejects.toThrow();
    expect(client.lastCall).toBeNull();
  });
});
