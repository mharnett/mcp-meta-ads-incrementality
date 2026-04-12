import { describe, it, expect } from 'vitest';
import {
  extractConversion,
  extractConversionRows,
  computeInflationFactor,
  type MetaInsightsRow,
} from './insights.js';

const ROW = (overrides: Partial<MetaInsightsRow> = {}): MetaInsightsRow => ({
  date_start: '2026-03-01',
  date_stop: '2026-03-31',
  spend: '100.50',
  actions: [],
  ...overrides,
});

describe('insights extraction', () => {
  describe('extractConversion — single row, single conversion', () => {
    it('extracts a conversion across the requested windows from a present action', () => {
      const row = ROW({
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            value: '50',
            '7d_click': '20',
            '1d_view': '5',
            incrementality: '10',
          },
        ],
      });

      const result = extractConversion(row, 'offsite_conversion.fb_pixel_purchase', [
        'incrementality',
        '7d_click',
        '1d_view',
      ]);

      expect(result.conversions).toEqual({
        incrementality: 10,
        '7d_click': 20,
        '1d_view': 5,
      });
    });

    it('coerces string spend to a number', () => {
      const row = ROW({ spend: '1234.56' });
      const result = extractConversion(row, 'foo', ['incrementality']);
      expect(result.spend).toBe(1234.56);
    });

    it('returns spend as null when the row has no spend field', () => {
      const row = ROW({ spend: undefined });
      const result = extractConversion(row, 'foo', ['incrementality']);
      expect(result.spend).toBeNull();
    });

    it('returns 0 for every requested window when the action_type is missing entirely', () => {
      const row = ROW({
        actions: [{ action_type: 'link_click', value: '500', '7d_click': '500' }],
      });
      const result = extractConversion(row, 'offsite_conversion.fb_pixel_purchase', [
        'incrementality',
        '7d_click',
      ]);
      expect(result.conversions).toEqual({ incrementality: 0, '7d_click': 0 });
    });

    it('returns 0 for an individual window absent on an otherwise-present action', () => {
      const row = ROW({
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            value: '50',
            '7d_click': '20',
            // no incrementality, no 1d_view
          },
        ],
      });
      const result = extractConversion(row, 'offsite_conversion.fb_pixel_purchase', [
        'incrementality',
        '7d_click',
        '1d_view',
      ]);
      expect(result.conversions).toEqual({
        incrementality: 0,
        '7d_click': 20,
        '1d_view': 0,
      });
    });

    it('treats an empty actions array as zero conversions', () => {
      const row = ROW({ actions: [] });
      const result = extractConversion(row, 'offsite_conversion.fb_pixel_purchase', [
        'incrementality',
      ]);
      expect(result.conversions).toEqual({ incrementality: 0 });
    });

    it('treats a missing actions field as zero conversions', () => {
      const row = ROW({ actions: undefined });
      const result = extractConversion(row, 'offsite_conversion.fb_pixel_purchase', [
        'incrementality',
      ]);
      expect(result.conversions).toEqual({ incrementality: 0 });
    });

    it('matches action_type by exact string (offsite_conversion.fb_pixel_purchase ≠ purchase)', () => {
      const row = ROW({
        actions: [{ action_type: 'purchase', value: '5', incrementality: '5' }],
      });
      const result = extractConversion(row, 'offsite_conversion.fb_pixel_purchase', [
        'incrementality',
      ]);
      expect(result.conversions.incrementality).toBe(0);
    });

    it('preserves the row date_start and date_stop on the result', () => {
      const row = ROW({ date_start: '2026-03-01', date_stop: '2026-03-31' });
      const result = extractConversion(row, 'foo', ['incrementality']);
      expect(result.date_start).toBe('2026-03-01');
      expect(result.date_stop).toBe('2026-03-31');
    });

    it('handles a window value that is a number, not a string', () => {
      const row = ROW({
        actions: [
          {
            action_type: 'purchase',
            value: '5',
            incrementality: 7 as unknown as string,
          },
        ],
      });
      const result = extractConversion(row, 'purchase', ['incrementality']);
      expect(result.conversions.incrementality).toBe(7);
    });

    it('returns 0 for a window value that parses as NaN', () => {
      const row = ROW({
        actions: [
          { action_type: 'purchase', value: '5', incrementality: 'not-a-number' },
        ],
      });
      const result = extractConversion(row, 'purchase', ['incrementality']);
      expect(result.conversions.incrementality).toBe(0);
    });
  });

  describe('extractConversion — sums duplicated action_type entries', () => {
    it('sums values across multiple matching action entries (Meta sometimes returns multi-currency rows)', () => {
      const row = ROW({
        actions: [
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            value: '10',
            incrementality: '4',
          },
          {
            action_type: 'offsite_conversion.fb_pixel_purchase',
            value: '15',
            incrementality: '6',
          },
        ],
      });
      const result = extractConversion(row, 'offsite_conversion.fb_pixel_purchase', [
        'incrementality',
      ]);
      expect(result.conversions.incrementality).toBe(10);
    });
  });

  describe('extractConversionRows — multi-row response (breakdowns)', () => {
    it('returns one extracted result per row in input order', () => {
      const rows: MetaInsightsRow[] = [
        ROW({
          campaign_name: 'A',
          spend: '100',
          actions: [
            { action_type: 'purchase', value: '10', incrementality: '4' },
          ],
        }),
        ROW({
          campaign_name: 'B',
          spend: '200',
          actions: [
            { action_type: 'purchase', value: '20', incrementality: '8' },
          ],
        }),
      ];
      const results = extractConversionRows(rows, 'purchase', ['incrementality']);
      expect(results).toHaveLength(2);
      expect(results[0]?.spend).toBe(100);
      expect(results[1]?.spend).toBe(200);
      expect(results[0]?.conversions.incrementality).toBe(4);
      expect(results[1]?.conversions.incrementality).toBe(8);
    });

    it('preserves row-level breakdown fields (campaign_name, adset_name, ad_name)', () => {
      const rows: MetaInsightsRow[] = [
        ROW({ campaign_name: 'Campaign-1', adset_name: 'AdSet-1', ad_name: 'Ad-1' }),
      ];
      const results = extractConversionRows(rows, 'purchase', ['incrementality']);
      expect(results[0]?.campaign_name).toBe('Campaign-1');
      expect(results[0]?.adset_name).toBe('AdSet-1');
      expect(results[0]?.ad_name).toBe('Ad-1');
    });

    it('returns an empty array for empty input', () => {
      expect(extractConversionRows([], 'purchase', ['incrementality'])).toEqual([]);
    });
  });

  describe('computeInflationFactor', () => {
    it('returns the ratio of comparison_value / incrementality_value', () => {
      // Default attribution reports 100, incremental is 40 → 2.5x inflation
      expect(computeInflationFactor({ incrementality: 40, comparison: 100 })).toBeCloseTo(
        2.5,
        5,
      );
    });

    it('returns 1 when both numbers are equal', () => {
      expect(computeInflationFactor({ incrementality: 50, comparison: 50 })).toBe(1);
    });

    it('returns null when incrementality is 0 (would divide by zero)', () => {
      expect(computeInflationFactor({ incrementality: 0, comparison: 10 })).toBeNull();
    });

    it('returns null when both are 0', () => {
      expect(computeInflationFactor({ incrementality: 0, comparison: 0 })).toBeNull();
    });

    it('returns a value below 1 when comparison is lower than incrementality (rare but possible)', () => {
      expect(computeInflationFactor({ incrementality: 100, comparison: 50 })).toBe(0.5);
    });
  });
});
