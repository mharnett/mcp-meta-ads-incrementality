import { describe, it, expect } from 'vitest';
import {
  AttributionWindowSchema,
  isValidAttributionWindow,
  DEFAULT_ATTRIBUTION_WINDOWS,
  STANDARD_AGENCY_WINDOWS,
  ALL_KNOWN_WINDOWS,
  PRESET_COMPARE_ALL,
  parseAttributionWindows,
} from './attribution.js';

describe('attribution windows', () => {
  describe('ALL_KNOWN_WINDOWS', () => {
    it('includes incrementality — the differentiator this MCP is built around', () => {
      expect(ALL_KNOWN_WINDOWS).toContain('incrementality');
    });

    it('includes documented click windows still supported post-Jan-2026', () => {
      expect(ALL_KNOWN_WINDOWS).toEqual(
        expect.arrayContaining(['1d_click', '7d_click', '28d_click']),
      );
    });

    it('includes 1d_view (the only view window remaining after Jan 2026)', () => {
      expect(ALL_KNOWN_WINDOWS).toContain('1d_view');
    });

    it('includes 1d_ev (engaged view)', () => {
      expect(ALL_KNOWN_WINDOWS).toContain('1d_ev');
    });

    it('includes dda (data-driven attribution) as a documented less-click-biased alternative', () => {
      expect(ALL_KNOWN_WINDOWS).toContain('dda');
    });

    it('includes SKAN windows for iOS measurement', () => {
      expect(ALL_KNOWN_WINDOWS).toContain('skan_view');
      expect(ALL_KNOWN_WINDOWS).toContain('skan_click');
    });

    it('does NOT include 7d_view (deprecated Jan 12, 2026)', () => {
      expect(ALL_KNOWN_WINDOWS).not.toContain('7d_view');
    });

    it('does NOT include 28d_view (deprecated Jan 12, 2026)', () => {
      expect(ALL_KNOWN_WINDOWS).not.toContain('28d_view');
    });

    it('contains no duplicates', () => {
      expect(new Set(ALL_KNOWN_WINDOWS).size).toBe(ALL_KNOWN_WINDOWS.length);
    });
  });

  describe('DEFAULT_ATTRIBUTION_WINDOWS', () => {
    it('defaults to incrementality only — incrementality leads in this MCP', () => {
      expect(DEFAULT_ATTRIBUTION_WINDOWS).toEqual(['incrementality']);
    });

    it('is a frozen array (cannot be mutated by callers)', () => {
      expect(Object.isFrozen(DEFAULT_ATTRIBUTION_WINDOWS)).toBe(true);
    });
  });

  describe('STANDARD_AGENCY_WINDOWS', () => {
    it('exposes the industry default 7d_click + 1d_view as a named preset', () => {
      expect(STANDARD_AGENCY_WINDOWS).toEqual(['7d_click', '1d_view']);
    });

    it('is a frozen array', () => {
      expect(Object.isFrozen(STANDARD_AGENCY_WINDOWS)).toBe(true);
    });
  });

  describe('PRESET_COMPARE_ALL', () => {
    it('combines incrementality, the standard agency windows, and dda', () => {
      expect(PRESET_COMPARE_ALL).toEqual(['incrementality', '7d_click', '1d_view', 'dda']);
    });

    it('is a frozen array', () => {
      expect(Object.isFrozen(PRESET_COMPARE_ALL)).toBe(true);
    });
  });

  describe('isValidAttributionWindow', () => {
    it('returns true for incrementality', () => {
      expect(isValidAttributionWindow('incrementality')).toBe(true);
    });

    it('returns true for 7d_click', () => {
      expect(isValidAttributionWindow('7d_click')).toBe(true);
    });

    it('returns true for dda', () => {
      expect(isValidAttributionWindow('dda')).toBe(true);
    });

    it('returns false for the deprecated 7d_view', () => {
      expect(isValidAttributionWindow('7d_view')).toBe(false);
    });

    it('returns false for the deprecated 28d_view', () => {
      expect(isValidAttributionWindow('28d_view')).toBe(false);
    });

    it('returns false for an arbitrary string', () => {
      expect(isValidAttributionWindow('foo')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(isValidAttributionWindow('')).toBe(false);
    });

    it('returns false for a near-miss like "1d"', () => {
      expect(isValidAttributionWindow('1d')).toBe(false);
    });

    it('is case-sensitive — "7D_CLICK" is not valid', () => {
      expect(isValidAttributionWindow('7D_CLICK')).toBe(false);
    });
  });

  describe('AttributionWindowSchema (Zod)', () => {
    it('parses a valid window unchanged', () => {
      expect(AttributionWindowSchema.parse('incrementality')).toBe('incrementality');
    });

    it('throws on an invalid window', () => {
      expect(() => AttributionWindowSchema.parse('invalid')).toThrow();
    });

    it('throws on the deprecated 7d_view with a clear error', () => {
      expect(() => AttributionWindowSchema.parse('7d_view')).toThrow();
    });

    it('throws on a non-string input', () => {
      expect(() => AttributionWindowSchema.parse(7 as unknown as string)).toThrow();
    });
  });

  describe('parseAttributionWindows', () => {
    it('returns the default [incrementality] when input is undefined', () => {
      expect(parseAttributionWindows(undefined)).toEqual(['incrementality']);
    });

    it('returns the default [incrementality] when input is null', () => {
      expect(parseAttributionWindows(null)).toEqual(['incrementality']);
    });

    it('returns the default [incrementality] when input is an empty array', () => {
      expect(parseAttributionWindows([])).toEqual(['incrementality']);
    });

    it('returns a single valid window unchanged', () => {
      expect(parseAttributionWindows(['7d_click'])).toEqual(['7d_click']);
    });

    it('returns a multi-window comparison array, preserving caller order', () => {
      expect(
        parseAttributionWindows(['incrementality', '7d_click', '1d_view', 'dda']),
      ).toEqual(['incrementality', '7d_click', '1d_view', 'dda']);
    });

    it('deduplicates repeated windows but preserves first-occurrence order', () => {
      expect(parseAttributionWindows(['7d_click', '1d_view', '7d_click'])).toEqual([
        '7d_click',
        '1d_view',
      ]);
    });

    it('throws when any window in the array is invalid', () => {
      expect(() => parseAttributionWindows(['7d_click', 'invalid'])).toThrow();
    });

    it('throws on a deprecated window with a clear error mentioning the window name', () => {
      expect(() => parseAttributionWindows(['7d_view'])).toThrow(/7d_view/);
    });

    it('returns a fresh array (does not return the DEFAULT_ATTRIBUTION_WINDOWS reference)', () => {
      const result = parseAttributionWindows(undefined);
      expect(result).not.toBe(DEFAULT_ATTRIBUTION_WINDOWS);
    });

    it('returned array is mutable by the caller (DEFAULT is frozen, this is a copy)', () => {
      const result = parseAttributionWindows(undefined);
      expect(() => result.push('7d_click')).not.toThrow();
    });
  });
});
