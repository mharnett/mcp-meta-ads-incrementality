import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  updateObjectStatus,
  updateBudget,
  deleteObject,
} from './lifecycle.js';

interface CapturedCall {
  url: string;
  method: string;
  body: URLSearchParams;
}

function setupFetchMock(responses: Array<unknown | { _status: number; _body: unknown }>) {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? new URLSearchParams(String(init.body)) : new URLSearchParams();
    calls.push({ url, method: init?.method ?? 'GET', body });
    const next = responses[i++] ?? {};
    if (next && typeof next === 'object' && '_status' in next) {
      const r = next as { _status: number; _body: unknown };
      return new Response(JSON.stringify(r._body), {
        status: r._status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(next), {
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

/* ========================================================================= */
/* updateObjectStatus                                                          */
/* ========================================================================= */

describe('updateObjectStatus', () => {
  it('POSTs to /{object_id} with status field', async () => {
    const { calls } = setupFetchMock([{ success: true }]);
    await updateObjectStatus({ object_id: 'cmp_1', status: 'PAUSED' }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/cmp_1$/);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body.get('status')).toBe('PAUSED');
  });

  it('accepts ACTIVE', async () => {
    const { calls } = setupFetchMock([{ success: true }]);
    await updateObjectStatus({ object_id: 'as_1', status: 'ACTIVE' }, TOKEN);
    expect(calls[0]?.body.get('status')).toBe('ACTIVE');
  });

  it('accepts ARCHIVED', async () => {
    const { calls } = setupFetchMock([{ success: true }]);
    await updateObjectStatus({ object_id: 'ad_1', status: 'ARCHIVED' }, TOKEN);
    expect(calls[0]?.body.get('status')).toBe('ARCHIVED');
  });

  it('returns success and echoes object_id + status', async () => {
    setupFetchMock([{ success: true }]);
    const r = await updateObjectStatus({ object_id: 'ad_1', status: 'PAUSED' }, TOKEN);
    expect(r).toEqual({ object_id: 'ad_1', status: 'PAUSED', success: true });
  });

  it('reports success=false when Graph returns success=false', async () => {
    setupFetchMock([{ success: false }]);
    const r = await updateObjectStatus({ object_id: 'ad_1', status: 'PAUSED' }, TOKEN);
    expect(r.success).toBe(false);
  });

  it('throws on Graph error', async () => {
    setupFetchMock([{ _status: 400, _body: { error: { code: 100, message: 'no perm' } } }]);
    await expect(
      updateObjectStatus({ object_id: 'cmp_1', status: 'ACTIVE' }, TOKEN),
    ).rejects.toThrow(/no perm/);
  });
});

/* ========================================================================= */
/* updateBudget                                                                */
/* ========================================================================= */

describe('updateBudget', () => {
  it('POSTs daily_budget when provided', async () => {
    const { calls } = setupFetchMock([{ success: true }]);
    await updateBudget({ object_id: 'as_1', daily_budget: 10000 }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/as_1$/);
    expect(calls[0]?.body.get('daily_budget')).toBe('10000');
  });

  it('POSTs lifetime_budget when provided', async () => {
    const { calls } = setupFetchMock([{ success: true }]);
    await updateBudget({ object_id: 'cmp_1', lifetime_budget: 500000 }, TOKEN);
    expect(calls[0]?.body.get('lifetime_budget')).toBe('500000');
  });

  it('throws when neither budget provided', async () => {
    setupFetchMock([]);
    await expect(updateBudget({ object_id: 'cmp_1' }, TOKEN)).rejects.toThrow(/budget/i);
  });

  it('throws when both budgets provided', async () => {
    setupFetchMock([]);
    await expect(
      updateBudget({ object_id: 'cmp_1', daily_budget: 100, lifetime_budget: 1000 }, TOKEN),
    ).rejects.toThrow(/both/i);
  });

  it('echoes the new budget in the result', async () => {
    setupFetchMock([{ success: true }]);
    const r = await updateBudget({ object_id: 'as_1', daily_budget: 12500 }, TOKEN);
    expect(r).toEqual({
      object_id: 'as_1',
      daily_budget: 12500,
      lifetime_budget: null,
      success: true,
    });
  });

  it('throws on Graph error', async () => {
    setupFetchMock([{ _status: 400, _body: { error: { code: 100, message: 'too low' } } }]);
    await expect(
      updateBudget({ object_id: 'as_1', daily_budget: 50 }, TOKEN),
    ).rejects.toThrow(/too low/);
  });
});

/* ========================================================================= */
/* deleteObject                                                                */
/* ========================================================================= */

describe('deleteObject', () => {
  it('DELETEs /{object_id}', async () => {
    const { calls } = setupFetchMock([{ success: true }]);
    await deleteObject({ object_id: 'ad_1' }, TOKEN);
    expect(calls[0]?.url).toMatch(/\/ad_1\?access_token=/);
    expect(calls[0]?.method).toBe('DELETE');
  });

  it('returns success=true when Graph returns success', async () => {
    setupFetchMock([{ success: true }]);
    const r = await deleteObject({ object_id: 'ad_1' }, TOKEN);
    expect(r).toEqual({ object_id: 'ad_1', success: true });
  });

  it('reports success=false when Graph returns success=false', async () => {
    setupFetchMock([{ success: false }]);
    const r = await deleteObject({ object_id: 'ad_1' }, TOKEN);
    expect(r.success).toBe(false);
  });

  it('throws on Graph error', async () => {
    setupFetchMock([{ _status: 400, _body: { error: { code: 100, message: 'cannot delete' } } }]);
    await expect(deleteObject({ object_id: 'ad_1' }, TOKEN)).rejects.toThrow(/cannot delete/);
  });
});
