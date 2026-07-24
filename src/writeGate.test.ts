import { describe, it, expect } from 'vitest';
import { TOOLS } from './toolDefinitions.js';
import {
  WRITE_TOOLS,
  isWriteTool,
  isWriteEnabled,
  filterTools,
  assertWriteAllowed,
  WRITE_DISABLED_MESSAGE,
} from './writeGate.js';

/**
 * Read-only tools. Every registered tool must be classified either here or in
 * WRITE_TOOLS — an unclassified tool fails the shape test below, so a future
 * mutating tool cannot land ungated.
 */
const READ_TOOLS = [
  'meta_ads_insights_incrementality',
  'meta_ads_list_ads_in_campaign',
  'meta_ads_get_ad_url_tags',
];

/** Name fragments that mark a tool as mutating. */
const MUTATING_NAME_PATTERN =
  /create_|update_|delete_|upload_|swap_|rebind_|edit_|rename_/;

describe('writeGate', () => {
  describe('shape: tool classification covers every registered tool', () => {
    it('every registered tool whose name matches the mutating pattern is in WRITE_TOOLS', () => {
      const ungated = TOOLS.map((t) => t.name).filter(
        (n) => MUTATING_NAME_PATTERN.test(n) && !WRITE_TOOLS.has(n),
      );
      expect(ungated).toEqual([]);
    });

    it('WRITE_TOOLS is a subset of the registered tool names', () => {
      const registered = new Set(TOOLS.map((t) => t.name));
      const phantom = [...WRITE_TOOLS].filter((n) => !registered.has(n));
      expect(phantom).toEqual([]);
    });

    it('every registered tool is classified as either read or write', () => {
      const classified = new Set<string>([...WRITE_TOOLS, ...READ_TOOLS]);
      const uncovered = TOOLS.map((t) => t.name).filter((n) => !classified.has(n));
      expect(uncovered).toEqual([]);
    });

    it('WRITE_TOOLS and READ_TOOLS do not overlap', () => {
      const overlap = READ_TOOLS.filter((n) => WRITE_TOOLS.has(n));
      expect(overlap).toEqual([]);
    });

    it('gates all 17 known mutating tools', () => {
      expect([...WRITE_TOOLS].sort()).toEqual(
        [
          'meta_ads_update_ad_url_tags',
          'meta_ads_rename_ad',
          'meta_ads_create_campaign',
          'meta_ads_create_adset',
          'meta_ads_create_ad_creative',
          'meta_ads_create_ad',
          'meta_ads_upload_image',
          'meta_ads_create_leadgen_form',
          'meta_ads_create_custom_audience',
          'meta_ads_upload_users_to_audience',
          'meta_ads_create_lookalike_audience',
          'meta_ads_update_object_status',
          'meta_ads_update_budget',
          'meta_ads_delete_object',
          'meta_ads_swap_ad_lead_form',
          'meta_ads_rebind_ad_creative',
          'meta_ads_edit_creative_text',
        ].sort(),
      );
    });
  });

  describe('read-only default (env unset)', () => {
    it('assertWriteAllowed throws for meta_ads_delete_object', () => {
      expect(() => assertWriteAllowed('meta_ads_delete_object', {})).toThrow(
        /write operation/i,
      );
    });

    it('assertWriteAllowed blocks every write tool', () => {
      for (const w of WRITE_TOOLS) {
        expect(() => assertWriteAllowed(w, {})).toThrow(/write operation/i);
      }
    });

    it('filterTools excludes every write tool', () => {
      const names = filterTools(TOOLS, {}).map((t) => t.name);
      for (const w of WRITE_TOOLS) {
        expect(names).not.toContain(w);
      }
    });

    it('filterTools keeps every read tool', () => {
      const names = filterTools(TOOLS, {}).map((t) => t.name);
      for (const r of READ_TOOLS) {
        expect(names).toContain(r);
      }
    });

    it('assertWriteAllowed permits read tools', () => {
      for (const r of READ_TOOLS) {
        expect(() => assertWriteAllowed(r, {})).not.toThrow();
      }
    });

    it('error message names the env var fix', () => {
      try {
        assertWriteAllowed('meta_ads_delete_object', {});
      } catch (err) {
        expect((err as Error).message).toContain('META_ADS_MCP_WRITE=true');
        return;
      }
      throw new Error('expected assertWriteAllowed to throw');
    });
  });

  describe('writes enabled (META_ADS_MCP_WRITE=true)', () => {
    const env = { META_ADS_MCP_WRITE: 'true' };

    it('assertWriteAllowed permits write tools', () => {
      for (const w of WRITE_TOOLS) {
        expect(() => assertWriteAllowed(w, env)).not.toThrow();
      }
    });

    it('filterTools lists every registered tool', () => {
      expect(filterTools(TOOLS, env).map((t) => t.name).sort()).toEqual(
        TOOLS.map((t) => t.name).sort(),
      );
    });

    it('isWriteEnabled accepts true/1/yes case-insensitively', () => {
      expect(isWriteEnabled({ META_ADS_MCP_WRITE: 'true' })).toBe(true);
      expect(isWriteEnabled({ META_ADS_MCP_WRITE: 'TRUE' })).toBe(true);
      expect(isWriteEnabled({ META_ADS_MCP_WRITE: '1' })).toBe(true);
      expect(isWriteEnabled({ META_ADS_MCP_WRITE: 'yes' })).toBe(true);
    });
  });

  describe('anchor: fail-closed on non-affirmative env values', () => {
    const badValues = ['false', '', '0', 'no', 'garbage', 'enable', 'on'];

    for (const v of badValues) {
      it(`refuses writes when META_ADS_MCP_WRITE=${JSON.stringify(v)}`, () => {
        const env = { META_ADS_MCP_WRITE: v };
        expect(isWriteEnabled(env)).toBe(false);
        expect(() => assertWriteAllowed('meta_ads_delete_object', env)).toThrow(
          /write operation/i,
        );
        const names = filterTools(TOOLS, env).map((t) => t.name);
        expect(names).not.toContain('meta_ads_delete_object');
      });
    }
  });

  describe('isWriteTool', () => {
    it('classifies write vs read tools', () => {
      expect(isWriteTool('meta_ads_delete_object')).toBe(true);
      expect(isWriteTool('meta_ads_create_campaign')).toBe(true);
      expect(isWriteTool('meta_ads_insights_incrementality')).toBe(false);
      expect(isWriteTool('meta_ads_list_ads_in_campaign')).toBe(false);
    });
  });

  it('WRITE_DISABLED_MESSAGE mentions the env var', () => {
    expect(WRITE_DISABLED_MESSAGE).toContain('META_ADS_MCP_WRITE=true');
  });
});
