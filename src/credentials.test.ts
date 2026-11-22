import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * credentials.ts decides which Meta token the server runs with.
 *
 * Containment: no test reads a real credential.
 *  - ./platform.js is mocked so the DEFAULT credentials path is a fresh temp
 *    dir. A test that forgot to pass a path still cannot open the real
 *    ~/Library/Preferences/mcp-meta-ads-nodejs/credentials.json.
 *  - META_ACCESS_TOKEN is stubbed in every test (to '' unless the test sets a
 *    fake value), so a token in the developer's shell is never picked up.
 *  - Every token below is a literal fake.
 */

const h = vi.hoisted(() => ({ failChmod: false }));

vi.mock('./platform.js', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const p = await import('node:path');
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), 'meta-creds-default-'));
  return { configDir: dir, credentialsFilePath: p.join(dir, 'credentials.json') };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (h.failChmod) throw new Error('EPERM: simulated chmod failure');
      return actual.chmodSync(...args);
    },
  };
});

import {
  CREDENTIALS_FILE_VERSION,
  credentialsFilePath,
  readStoredCredentials,
  resolveCredentials,
  writeStoredCredentials,
  type StoredCredentials,
} from './credentials.js';

const NOW = 1_800_000_000; // fixed unix seconds
const DAY = 86_400;
const posixOnly = it.skipIf(process.platform === 'win32');

let dir: string;
let file: string;
let stdoutWrite: ReturnType<typeof vi.spyOn>;
let stderrWrite: ReturnType<typeof vi.spyOn>;

function stored(overrides: Partial<StoredCredentials> = {}): StoredCredentials {
  return {
    version: CREDENTIALS_FILE_VERSION,
    access_token: 'FAKE_FILE_TOKEN',
    expires_in: 60 * DAY,
    obtained_at: '2027-01-15T00:00:00.000Z',
    created_at: NOW - DAY,
    ...overrides,
  };
}

function writeRaw(content: string) {
  writeFileSync(file, content, 'utf-8');
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'meta-creds-test-'));
  file = path.join(dir, 'credentials.json');
  vi.stubEnv('META_ACCESS_TOKEN', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW * 1000);
  stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  h.failChmod = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('containment', () => {
  it('points the default credentials path at a temp dir, not the real config dir', () => {
    expect(credentialsFilePath).toContain('meta-creds-default-');
    expect(credentialsFilePath).not.toMatch(/mcp-meta-ads-nodejs/);
  });
});

describe('resolveCredentials — priority', () => {
  it('uses META_ACCESS_TOKEN over a valid cached file', () => {
    writeStoredCredentials(stored(), file);
    vi.stubEnv('META_ACCESS_TOKEN', 'FAKE_ENV_TOKEN');

    expect(resolveCredentials(file)).toEqual({ access_token: 'FAKE_ENV_TOKEN', source: 'env' });
  });

  it('trims whitespace and one pair of surrounding quotes from the env token', () => {
    vi.stubEnv('META_ACCESS_TOKEN', '  "FAKE_ENV_TOKEN"  ');
    expect(resolveCredentials(file).access_token).toBe('FAKE_ENV_TOKEN');

    vi.stubEnv('META_ACCESS_TOKEN', "'FAKE_ENV_TOKEN'");
    expect(resolveCredentials(file).access_token).toBe('FAKE_ENV_TOKEN');
  });

  it('falls through to the cached file when the env token is only whitespace', () => {
    writeStoredCredentials(stored(), file);
    vi.stubEnv('META_ACCESS_TOKEN', '   ');

    const r = resolveCredentials(file);
    expect(r.source).toBe('file');
    expect(r.access_token).toBe('FAKE_FILE_TOKEN');
  });
});

describe('resolveCredentials — cached OAuth token', () => {
  it('returns the cached token with its absolute expiry', () => {
    writeStoredCredentials(stored({ created_at: NOW - DAY, expires_in: 60 * DAY }), file);

    expect(resolveCredentials(file)).toEqual({
      access_token: 'FAKE_FILE_TOKEN',
      source: 'file',
      expires_at: NOW - DAY + 60 * DAY,
    });
  });

  it('refuses an expired token instead of returning it, and says how to re-authenticate', () => {
    writeStoredCredentials(stored({ created_at: NOW - 61 * DAY, expires_in: 60 * DAY }), file);

    expect(() => resolveCredentials(file)).toThrow(/Meta OAuth token has expired \(obtained 2027-01-15/);
    expect(() => resolveCredentials(file)).toThrow(/mcp-meta-ads-auth/);
  });

  it('treats a token as expired at the exact expiry second', () => {
    writeStoredCredentials(stored({ created_at: NOW - 100, expires_in: 100 }), file);
    expect(() => resolveCredentials(file)).toThrow(/expired/);

    writeStoredCredentials(stored({ created_at: NOW - 99, expires_in: 100 }), file);
    expect(resolveCredentials(file).access_token).toBe('FAKE_FILE_TOKEN');
  });

  it('warns on stderr, never stdout, when the token expires within 7 days', () => {
    writeStoredCredentials(stored({ created_at: NOW - 55 * DAY, expires_in: 60 * DAY }), file);

    resolveCredentials(file);

    const warnings = stderrWrite.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(warnings).toMatch(/\[warning\] Meta OAuth token expires in 5 day\(s\)/);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('does not warn when the token has more than 7 days left', () => {
    writeStoredCredentials(stored({ created_at: NOW - DAY, expires_in: 60 * DAY }), file);

    resolveCredentials(file);

    expect(stderrWrite).not.toHaveBeenCalled();
  });
});

describe('resolveCredentials — nothing usable', () => {
  it('throws setup instructions naming the credentials path when no file exists', () => {
    expect(existsSync(file)).toBe(false);
    expect(() => resolveCredentials(file)).toThrow(/No Meta access token found/);
    expect(() => resolveCredentials(file)).toThrow(credentialsFilePath);
  });

  it('ignores a file written by a different credentials-file version', () => {
    writeRaw(JSON.stringify({ ...stored(), version: CREDENTIALS_FILE_VERSION + 1 }));

    expect(readStoredCredentials(file)).toBeNull();
    expect(() => resolveCredentials(file)).toThrow(/No Meta access token found/);
  });

  it('ignores a corrupt file instead of crashing the server', () => {
    writeRaw('{ "version": 1, "access_token": ');

    expect(readStoredCredentials(file)).toBeNull();
    expect(() => resolveCredentials(file)).toThrow(/No Meta access token found/);
  });

  it('treats a file with an empty access_token as no token', () => {
    writeStoredCredentials(stored({ access_token: '' }), file);

    expect(() => resolveCredentials(file)).toThrow(/No Meta access token found/);
  });
});

describe('writeStoredCredentials', () => {
  it('creates missing parent dirs and round-trips through readStoredCredentials', () => {
    const nested = path.join(dir, 'a', 'b', 'credentials.json');
    const creds = stored({ user_name: 'Test User', ad_accounts: [{ id: 'act_1', name: 'Test', account_id: '1' }] });

    writeStoredCredentials(creds, nested);

    expect(readStoredCredentials(nested)).toEqual(creds);
  });

  posixOnly('leaves the file readable by its owner only (0600)', () => {
    writeStoredCredentials(stored(), file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  posixOnly('tightens an existing world-readable file to 0600 on overwrite', () => {
    writeFileSync(file, '{}', { mode: 0o644 });

    writeStoredCredentials(stored(), file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  posixOnly('creates the file 0600 even when chmod fails, so the token is never world-readable', () => {
    h.failChmod = true;

    writeStoredCredentials(stored(), file);

    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
