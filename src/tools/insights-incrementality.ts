import { z } from 'zod';
import {
  AttributionWindowSchema,
  parseAttributionWindows,
  type AttributionWindow,
} from '../lib/attribution.js';
import {
  extractConversionRows,
  computeInflationFactor,
  type ExtractedConversion,
  type MetaInsightsRow,
} from '../lib/insights.js';
import type { GetInsightsParams, InsightsLevel } from '../lib/meta-client.js';

/* ------------------------------------------------------------------------- */
/* Input schema                                                              */
/* ------------------------------------------------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateRangeSchema = z.object({
  since: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD'),
  until: z.string().regex(ISO_DATE, 'date must be YYYY-MM-DD'),
});

const levelSchema = z.enum(['account', 'campaign', 'adset', 'ad']);

export const insightsIncrementalityInputSchema = z.object({
  ad_account_id: z.string().min(1, 'ad_account_id is required'),
  date_range: dateRangeSchema,
  conversion_event_name: z.string().min(1, 'conversion_event_name is required'),
  attribution_windows: z
    .array(AttributionWindowSchema)
    .optional()
    .transform((v) => parseAttributionWindows(v)),
  level: levelSchema.optional().default('campaign'),
  campaign_id: z.string().optional(),
  adset_id: z.string().optional(),
  breakdowns: z.array(z.string()).optional(),
});

export type InsightsIncrementalityInput = z.infer<
  typeof insightsIncrementalityInputSchema
>;

/* ------------------------------------------------------------------------- */
/* Output shape                                                              */
/* ------------------------------------------------------------------------- */

export interface InsightsIncrementalityRow extends ExtractedConversion {
  /** Sum of 7d_click + 1d_view (whichever are present), the "default attributed" number agencies report. Null when neither is requested. */
  default_attributed: number | null;
  /** default_attributed / incrementality. Null when incrementality is 0 or default not requested. */
  inflation_factor: number | null;
  /** (default_attributed - incrementality) / default_attributed * 100. Null in the same cases as inflation_factor. */
  overstatement_pct: number | null;
}

export interface InsightsIncrementalitySummary {
  total_spend: number;
  total_conversions: Record<string, number>;
  cpa: Record<string, number | null>;
  /** Computed from totals (not row averages): total_default_attributed / total_incrementality. Null if incrementality total is 0 or default not requested. */
  inflation_factor: number | null;
}

export interface InsightsIncrementalityResult {
  meta: {
    ad_account_id: string;
    date_range: { since: string; until: string };
    level: InsightsLevel;
    conversion_event_name: string;
    attribution_windows: AttributionWindow[];
  };
  rows: InsightsIncrementalityRow[];
  summary: InsightsIncrementalitySummary;
}

/* ------------------------------------------------------------------------- */
/* Dependencies                                                              */
/* ------------------------------------------------------------------------- */

/** Minimal interface this tool needs from a Meta insights client. */
export interface InsightsClient {
  getInsights(params: GetInsightsParams): Promise<MetaInsightsRow[]>;
}

export interface InsightsIncrementalityDeps {
  metaClient: InsightsClient;
}

/* ------------------------------------------------------------------------- */
/* Implementation                                                            */
/* ------------------------------------------------------------------------- */

const DEFAULT_AGENCY_WINDOWS: readonly AttributionWindow[] = ['7d_click', '1d_view'];

function computeRowComparison(
  conversions: Record<string, number>,
  windows: readonly AttributionWindow[],
): {
  default_attributed: number | null;
  inflation_factor: number | null;
  overstatement_pct: number | null;
} {
  const hasIncrementality = windows.includes('incrementality');
  const defaultParts = DEFAULT_AGENCY_WINDOWS.filter((w) => windows.includes(w));

  if (!hasIncrementality || defaultParts.length === 0) {
    return { default_attributed: null, inflation_factor: null, overstatement_pct: null };
  }

  const defaultAttributed = defaultParts.reduce(
    (sum, w) => sum + (conversions[w] ?? 0),
    0,
  );
  const incrementality = conversions.incrementality ?? 0;
  const inflation = computeInflationFactor({
    incrementality,
    comparison: defaultAttributed,
  });
  const overstatement =
    inflation == null || defaultAttributed === 0
      ? null
      : ((defaultAttributed - incrementality) / defaultAttributed) * 100;

  return {
    default_attributed: defaultAttributed,
    inflation_factor: inflation,
    overstatement_pct: overstatement,
  };
}

export async function runInsightsIncrementality(
  rawInput: unknown,
  deps: InsightsIncrementalityDeps,
): Promise<InsightsIncrementalityResult> {
  const input = insightsIncrementalityInputSchema.parse(rawInput);
  const windows = input.attribution_windows;

  const fetchParams: GetInsightsParams = {
    accountId: input.ad_account_id,
    dateRange: input.date_range,
    attributionWindows: windows,
    level: input.level,
    ...(input.campaign_id ? { campaignId: input.campaign_id } : {}),
    ...(input.adset_id ? { adsetId: input.adset_id } : {}),
    ...(input.breakdowns ? { breakdowns: input.breakdowns } : {}),
  };

  const rawRows = await deps.metaClient.getInsights(fetchParams);
  const extracted = extractConversionRows(rawRows, input.conversion_event_name, windows);

  const rows: InsightsIncrementalityRow[] = extracted.map((row) => ({
    ...row,
    ...computeRowComparison(row.conversions, windows),
  }));

  // Summary aggregation across rows
  const totalSpend = rows.reduce((sum, r) => sum + (r.spend ?? 0), 0);
  const totalConversions: Record<string, number> = {};
  for (const w of windows) totalConversions[w] = 0;
  for (const r of rows) {
    for (const w of windows) {
      totalConversions[w] = (totalConversions[w] ?? 0) + (r.conversions[w] ?? 0);
    }
  }

  const cpa: Record<string, number | null> = {};
  for (const w of windows) {
    const c = totalConversions[w] ?? 0;
    cpa[w] = c > 0 ? totalSpend / c : null;
  }

  const summaryComparison = computeRowComparison(totalConversions, windows);

  return {
    meta: {
      ad_account_id: input.ad_account_id,
      date_range: input.date_range,
      level: input.level,
      conversion_event_name: input.conversion_event_name,
      attribution_windows: [...windows],
    },
    rows,
    summary: {
      total_spend: totalSpend,
      total_conversions: totalConversions,
      cpa,
      inflation_factor: summaryComparison.inflation_factor,
    },
  };
}
