/**
 * The MCP Registry listing (server.json) and the npm package must agree, or the
 * registry refuses the publish:
 *  - the registry proves npm ownership by reading `mcpName` from the published
 *    package.json, and it must equal server.json's `name`;
 *  - server.json's npm entry must name this package, at the version published.
 *
 * Each release bumps package.json (release-please). server.json's versions move
 * with it only because release-please-config.json lists server.json under
 * extra-files; without that, the listing would point at an old npm version that
 * has no `mcpName`, and the publish would fail. Same guard as the other listed
 * Drak MCPs (mcp-google-ads release-automation.guard.test.mjs).
 *
 * Reads committed files only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = (name: string): any => JSON.parse(readFileSync(path.join(ROOT, name), 'utf-8'));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pkg = readJson('package.json');
const server = readJson('server.json');
const config = readJson('release-please-config.json');

/** Every string field named "version" in a JSON value, as a concrete jsonpath. */
function versionFields(node: unknown, at = '$'): Array<[string, string]> {
  if (Array.isArray(node)) return node.flatMap((v, i) => versionFields(v, `${at}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node).flatMap(([k, v]) =>
      k === 'version' && typeof v === 'string' ? [[`${at}.${k}`, v] as [string, string]] : versionFields(v, `${at}.${k}`),
    );
  }
  return [];
}

/** The JSONPath subset extra-files uses here: dotted keys and [*]. */
const selects = (jsonpath: string, concrete: string) =>
  new RegExp(`^${escapeRe(jsonpath).replace(/\\\[\\\*\\\]/g, '\\[\\d+\\]')}$`).test(concrete);

describe('MCP Registry listing matches the npm package', () => {
  it("package.json's mcpName equals server.json's name (the registry's npm ownership check)", () => {
    expect(typeof server.name).toBe('string');
    expect(pkg.mcpName).toBe(server.name);
  });

  it("server.json's npm package entry is this package", () => {
    const npm = (server.packages ?? []).filter((p: { registryType?: string }) => p.registryType === 'npm');
    expect(npm.map((p: { identifier?: string }) => p.identifier)).toEqual([pkg.name]);
  });

  it("server.json's versions equal package.json's version", () => {
    const fields = versionFields(server);
    expect(fields.length).toBeGreaterThanOrEqual(2);
    const stale = fields.filter(([, v]) => v !== pkg.version).map(([at, v]) => `${at}=${v}`);
    expect(stale, `package.json is ${pkg.version}`).toEqual([]);
  });
});

describe('each release bumps server.json', () => {
  // Top-level config is the default for every package; the "." entry wins.
  const root = { ...config, ...config.packages?.['.'] };
  const jsonpaths: string[] = (root['extra-files'] ?? [])
    .filter((f: unknown) => typeof f === 'object' && f !== null && (f as { path?: string }).path === 'server.json')
    .filter((f: { type?: string }) => f.type === 'json')
    .map((f: { jsonpath: string }) => f.jsonpath);
  const fields = versionFields(server);

  it('release-please.yml loads release-please-config.json, so its extra-files apply', () => {
    const yml = readFileSync(path.join(ROOT, '.github/workflows/release-please.yml'), 'utf-8')
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(yml).toMatch(/config-file:\s*release-please-config\.json/);
    expect(yml).not.toMatch(/release-type:/);
  });

  it('every version field in server.json is reached by a server.json extra-files jsonpath, and each jsonpath reaches one', () => {
    expect(fields.length).toBeGreaterThanOrEqual(2);
    const missed = fields.filter(([at]) => !jsonpaths.some((jp) => selects(jp, at))).map(([at]) => at);
    expect(missed).toEqual([]);
    const dead = jsonpaths.filter((jp) => !fields.some(([at]) => selects(jp, at)));
    expect(dead).toEqual([]);
  });
});
