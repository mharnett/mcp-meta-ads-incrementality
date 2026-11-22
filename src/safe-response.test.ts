import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeResponse } from './safe-response.js';

/**
 * safeResponse is the last thing every tool result passes through before it
 * is written to the MCP stdio transport (index.ts). Two failure modes matter:
 * an oversized payload that crashes the client, and a log line that lands on
 * stdout and corrupts the JSON-RPC stream.
 *
 * Pure function: no network, no files, no credentials.
 */

const LIMIT = 200_000;
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf-8');

let stdoutWrite: ReturnType<typeof vi.spyOn>;
let stderrWrite: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

function rows(n: number, size = 1_000) {
  return Array.from({ length: n }, (_, i) => ({ i, pad: 'x'.repeat(size) }));
}

describe('safeResponse', () => {
  it('returns a payload under the limit untouched, by reference, without logging', () => {
    const data = { data: rows(10), count: 10 };
    expect(safeResponse(data, 'tool')).toBe(data);
    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it('keeps a payload of exactly 200,000 bytes and truncates one byte more', () => {
    // JSON of ["a…","b…"] is len1 + len2 + 7 bytes.
    const atLimit = ['a'.repeat(100_000), 'b'.repeat(LIMIT - 7 - 100_000)];
    expect(bytes(atLimit)).toBe(LIMIT);
    expect(safeResponse(atLimit, 'tool')).toHaveLength(2);

    const overLimit = ['a'.repeat(100_000), 'b'.repeat(LIMIT - 6 - 100_000)];
    expect(bytes(overLimit)).toBe(LIMIT + 1);
    expect(safeResponse(overLimit, 'tool')).toHaveLength(1);
  });

  it('halves an oversized top-level array until it fits, keeping the leading rows in order', () => {
    const data = rows(500); // ~511 KB
    expect(bytes(data)).toBeGreaterThan(LIMIT);

    const out = safeResponse(data, 'tool');

    expect(bytes(out)).toBeLessThanOrEqual(LIMIT);
    expect(out.length).toBe(125); // 500 -> 250 -> 125
    expect(out.map((r) => r.i)).toEqual(data.slice(0, 125).map((r) => r.i));
  });

  it('truncates a wrapped `data` array, flags it and keeps count and row_count in step', () => {
    const data = { account: 'Test account', data: rows(500), count: 500, row_count: 500 };

    const out = safeResponse(data, 'tool') as typeof data & { truncated?: boolean };

    expect(bytes(out)).toBeLessThanOrEqual(LIMIT);
    expect(out.data.length).toBe(125);
    expect(out.count).toBe(125);
    expect(out.row_count).toBe(125);
    expect(out.truncated).toBe(true);
    expect(out.account).toBe('Test account');
  });

  it('never mutates the caller’s object', () => {
    const data = { data: rows(500), count: 500 };

    safeResponse(data, 'tool');

    expect(data.data).toHaveLength(500);
    expect(data.count).toBe(500);
    expect('truncated' in data).toBe(false);
  });

  it('measures UTF-8 bytes, not characters', () => {
    // 1,000 rows of 150 two-byte characters: ~155K characters, ~305K bytes.
    const data = Array.from({ length: 1_000 }, () => 'é'.repeat(150));
    expect(JSON.stringify(data).length).toBeLessThan(LIMIT);
    expect(bytes(data)).toBeGreaterThan(LIMIT);

    const out = safeResponse(data, 'tool');

    expect(out.length).toBeLessThan(1_000);
    expect(bytes(out)).toBeLessThanOrEqual(LIMIT);
  });

  it('writes its truncation warning to stderr, never stdout (stdout is the MCP channel)', () => {
    safeResponse(rows(500), 'tool');

    expect(stderrWrite).toHaveBeenCalled();
    expect(String(stderrWrite.mock.calls[0]?.[0])).toMatch(/\[warning\] Response exceeds 200000B/);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('returns a payload it cannot shrink intact rather than throwing or dropping fields', () => {
    const data = { note: 'y'.repeat(LIMIT + 10), id: 'keep-me' };

    const out = safeResponse(data, 'tool');

    expect(out).toEqual(data);
  });
});
