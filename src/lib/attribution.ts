import { z } from 'zod';

/**
 * All Meta attribution window values this MCP recognizes.
 *
 * Includes:
 * - `incrementality` — the differentiator. Meta's incremental conversion attribution.
 *   This is not exhaustively documented in Meta's public Marketing API reference but
 *   is referenced in the Breakdowns documentation. We default to it because the entire
 *   purpose of this MCP is to surface incremental performance over the inflated
 *   default 7d-click + 1d-view number that agencies report today.
 * - `1d_click`, `7d_click`, `28d_click` — documented click windows still supported
 *   after the Jan 12, 2026 deprecation of `7d_view` and `28d_view`.
 * - `1d_view` — the only view window remaining post-deprecation.
 * - `1d_ev` — engaged view (video views ≥10s within 1 day).
 * - `dda` — Meta's data-driven attribution. Documented; less click-biased than the
 *   default. Useful as a "less inflated" comparison number.
 * - `skan_view`, `skan_click` — SKAdNetwork attribution for iOS post-ATT.
 *
 * Deliberately excluded:
 * - `7d_view`, `28d_view` — deprecated by Meta on Jan 12, 2026 and no longer returned.
 *   Surfacing them here would invite confused bug reports.
 */
export const ALL_KNOWN_WINDOWS = [
  'incrementality',
  '1d_click',
  '7d_click',
  '28d_click',
  '1d_view',
  '1d_ev',
  'dda',
  'skan_view',
  'skan_click',
] as const;

export type AttributionWindow = (typeof ALL_KNOWN_WINDOWS)[number];

const KNOWN_WINDOW_SET: ReadonlySet<string> = new Set(ALL_KNOWN_WINDOWS);

/**
 * The default windows requested when the caller does not specify any.
 *
 * Set to `['incrementality']` because this MCP is built around the thesis that
 * agencies should lead with incremental conversions, not Meta's default
 * 7d-click + 1d-view number which systematically overstates ad impact.
 */
export const DEFAULT_ATTRIBUTION_WINDOWS: readonly AttributionWindow[] = Object.freeze([
  'incrementality',
] as const);

/**
 * The industry-default attribution that agencies currently report. Exposed as a
 * named preset so callers can ask for "what would Ads Manager show by default?"
 * for comparison against `incrementality`.
 */
export const STANDARD_AGENCY_WINDOWS: readonly AttributionWindow[] = Object.freeze([
  '7d_click',
  '1d_view',
] as const);

/**
 * Convenience preset that fetches all four numbers in one API call so a caller
 * can show the complete gap: incremental, default-inflated, and Meta's own
 * better-but-still-attributed `dda` model.
 */
export const PRESET_COMPARE_ALL: readonly AttributionWindow[] = Object.freeze([
  'incrementality',
  '7d_click',
  '1d_view',
  'dda',
] as const);

/**
 * Type guard. Returns true only for exact string matches against the known
 * window enum. Case-sensitive — Meta's API is case-sensitive on these values.
 */
export function isValidAttributionWindow(value: unknown): value is AttributionWindow {
  return typeof value === 'string' && KNOWN_WINDOW_SET.has(value);
}

/**
 * Zod schema for a single attribution window. Uses `z.enum` so error messages
 * include the full list of accepted values.
 */
export const AttributionWindowSchema = z.enum(ALL_KNOWN_WINDOWS);

/**
 * Normalize caller-supplied attribution windows to a validated, deduplicated array.
 *
 * - undefined / null / empty array → DEFAULT_ATTRIBUTION_WINDOWS (incrementality)
 * - any other input is validated; invalid windows throw with a clear error
 *   that names the offending value
 * - duplicates are removed, but first-occurrence order is preserved
 * - returns a fresh mutable array (not a reference to a frozen constant)
 */
export function parseAttributionWindows(
  input: readonly string[] | null | undefined,
): AttributionWindow[] {
  if (input == null || input.length === 0) {
    return [...DEFAULT_ATTRIBUTION_WINDOWS];
  }

  const seen = new Set<AttributionWindow>();
  const result: AttributionWindow[] = [];
  for (const raw of input) {
    if (!isValidAttributionWindow(raw)) {
      throw new Error(
        `Invalid attribution window: "${raw}". Valid values are: ${ALL_KNOWN_WINDOWS.join(', ')}.`,
      );
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      result.push(raw);
    }
  }
  return result;
}
