import type { AttributionWindow } from './attribution.js';

/**
 * A single entry in the `actions` (or `action_values`) array on a Meta /insights row.
 *
 * Per-window numbers appear as additional string-keyed properties whose values are
 * usually strings (Meta returns numbers as strings in the JSON wire format), but we
 * tolerate raw numbers and unparseable values defensively.
 */
export interface MetaActionEntry {
  action_type: string;
  value?: string | number;
  // Per-window breakdown values, dynamically keyed by attribution window name.
  [window: string]: string | number | undefined;
}

/**
 * A row from Meta's /insights endpoint. Most fields are optional because shape
 * varies by `breakdowns` and `level` (account / campaign / adset / ad).
 */
export interface MetaInsightsRow {
  date_start?: string;
  date_stop?: string;
  spend?: string | number;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  actions?: MetaActionEntry[];
  action_values?: MetaActionEntry[];
}

export interface ExtractedConversion {
  date_start?: string;
  date_stop?: string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?: string;
  adset_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend: number | null;
  /** Per-window conversion counts. Always populated for every requested window. */
  conversions: Record<string, number>;
}

function toNumberOrZero(input: string | number | undefined): number {
  if (input == null) return 0;
  const n = typeof input === 'number' ? input : Number(input);
  return Number.isFinite(n) ? n : 0;
}

function toNumberOrNull(input: string | number | undefined): number | null {
  if (input == null) return null;
  const n = typeof input === 'number' ? input : Number(input);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract a single named conversion across the requested attribution windows from
 * one /insights row.
 *
 * - If the action_type is not present in the row, every requested window returns 0.
 * - If a window value is missing for an otherwise-present action, that window returns 0.
 * - When Meta returns multiple entries for the same action_type (multi-currency rows,
 *   pixel + offline merges), the values are summed across entries.
 * - String→number coercion is defensive: NaN becomes 0.
 */
export function extractConversion(
  row: MetaInsightsRow,
  conversionEventName: string,
  windows: readonly AttributionWindow[],
): ExtractedConversion {
  const conversions: Record<string, number> = {};
  for (const w of windows) conversions[w] = 0;

  if (Array.isArray(row.actions)) {
    for (const action of row.actions) {
      if (action?.action_type !== conversionEventName) continue;
      for (const w of windows) {
        const current = conversions[w] ?? 0;
        conversions[w] = current + toNumberOrZero(action[w]);
      }
    }
  }

  return {
    date_start: row.date_start,
    date_stop: row.date_stop,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    ad_id: row.ad_id,
    ad_name: row.ad_name,
    spend: toNumberOrNull(row.spend),
    conversions,
  };
}

/**
 * Multi-row variant. Maps `extractConversion` over each row in input order.
 * Use when the underlying /insights call had `breakdowns` set, returning one
 * row per breakdown bucket.
 */
export function extractConversionRows(
  rows: readonly MetaInsightsRow[],
  conversionEventName: string,
  windows: readonly AttributionWindow[],
): ExtractedConversion[] {
  return rows.map((r) => extractConversion(r, conversionEventName, windows));
}

/**
 * Compute the inflation factor: how much larger is the comparison window
 * (typically default 7d_click+1d_view attribution) than the incrementality number?
 *
 * - Returns the ratio comparison / incrementality.
 * - Returns null when incrementality is 0 (no defined ratio) or both are 0.
 *
 * Example: incrementality=40, comparison=100 → 2.5 (the default number is 2.5×
 * the incremental number, i.e. 60% of reported conversions are not incremental).
 */
export function computeInflationFactor(input: {
  incrementality: number;
  comparison: number;
}): number | null {
  if (input.incrementality === 0) return null;
  return input.comparison / input.incrementality;
}
