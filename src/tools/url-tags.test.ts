import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rebindAdCreative } from './url-tags.js';

/**
 * Regression test for the 2026-05-14 RDR incident (commit 38b49f1).
 *
 * Production bug class: meta_ads_create_ad_creative + meta_ads_rebind_ad_creative
 * was used to swap a creative on a live ad. The OLD creative had 4
 * asset_customization_rules (per-placement image rules set in Ads Manager UI).
 * The NEW creative — built programmatically — carried none. The rebind POST
 * succeeded silently, and every custom placement-by-image collapsed to the
 * default image. No error, no warning, just degraded delivery for the duration.
 *
 * The safety check in rebindAdCreative refuses the rebind when old rules > 0
 * and new rules === 0, unless force=true. This test pins that defense.
 */

interface CapturedCall {
  url: string;
  method: string;
}

function setupFetchMock(handler: (url: string) => unknown) {
  const calls: CapturedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const body = handler(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

const TOKEN = 'TT';
const AD_ID = 'ad_120238848384530447';
const OLD_CREATIVE_ID = 'cr_old_with_rules';
const NEW_CREATIVE_ID = 'cr_new_no_rules';

describe('rebindAdCreative — asset_customization_rules safety check', () => {
  it('refuses rebind when old creative has rules and new creative has none', async () => {
    const { calls } = setupFetchMock((url) => {
      if (url.includes(`/${AD_ID}?`) || url.endsWith(`/${AD_ID}`)) {
        return { id: AD_ID, name: 'RDR — headline test', creative: { id: OLD_CREATIVE_ID } };
      }
      if (url.includes(`/${OLD_CREATIVE_ID}`)) {
        return {
          asset_feed_spec: {
            asset_customization_rules: [
              { customization_spec: { publisher_platforms: ['facebook'] }, image_label: { name: 'a' } },
              { customization_spec: { publisher_platforms: ['instagram'] }, image_label: { name: 'b' } },
              { customization_spec: { positions: ['feed'] }, image_label: { name: 'c' } },
              { customization_spec: { positions: ['story'] }, image_label: { name: 'd' } },
            ],
          },
        };
      }
      if (url.includes(`/${NEW_CREATIVE_ID}`)) {
        return { asset_feed_spec: { asset_customization_rules: [] } };
      }
      return {};
    });

    await expect(
      rebindAdCreative(AD_ID, NEW_CREATIVE_ID, TOKEN, /* dryRun */ false, /* force */ false),
    ).rejects.toThrow(
      /Refusing to rebind ad ad_120238848384530447: previous creative cr_old_with_rules has 4 asset_customization_rules.*new creative cr_new_no_rules has none/s,
    );

    // Critical: the rebind POST must NOT have fired. Only the three GETs
    // (ad read + two creative reads) should be on the wire. If a POST slipped
    // through, the production data corruption already happened.
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toEqual([]);
  });
});
