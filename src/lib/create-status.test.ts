import { describe, it, expect } from 'vitest';
import { ENABLE_TOOL, pausedCreateStatus } from './create-status.js';

describe('pausedCreateStatus', () => {
  it('defaults to PAUSED when no status is given', () => {
    expect(pausedCreateStatus('meta_ads_create_ad', undefined)).toBe('PAUSED');
  });

  for (const status of ['PAUSED', 'paused', ' Paused ']) {
    it(`accepts ${JSON.stringify(status)} and returns PAUSED`, () => {
      expect(pausedCreateStatus('meta_ads_create_ad', status)).toBe('PAUSED');
    });
  }

  for (const status of ['ACTIVE', 'active', 'ARCHIVED', 'DELETED', '', null, 1]) {
    it(`refuses ${JSON.stringify(status)}`, () => {
      expect(() => pausedCreateStatus('meta_ads_create_ad', status)).toThrow(
        /meta_ads_create_ad creates objects PAUSED only/,
      );
    });
  }

  it('names the tool to enable the object with afterwards', () => {
    expect(ENABLE_TOOL).toBe('meta_ads_update_object_status');
    expect(() => pausedCreateStatus('meta_ads_create_campaign', 'ACTIVE')).toThrow(
      `then enable it separately with ${ENABLE_TOOL}`,
    );
  });
});
