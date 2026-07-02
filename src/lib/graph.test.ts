import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GRAPH_VERSION, GRAPH_BASE } from './graph.js';

describe('Meta Graph API version — single source of truth', () => {
  it('GRAPH_VERSION is a well-formed Graph version', () => {
    expect(GRAPH_VERSION).toMatch(/^v\d+\.0$/);
  });

  it('GRAPH_BASE derives from GRAPH_VERSION', () => {
    expect(GRAPH_BASE).toBe(`https://graph.facebook.com/${GRAPH_VERSION}`);
  });

  it('auth-cli imports the shared version and hardcodes no Graph version of its own', () => {
    // Regression guard for the v24.0-vs-v22.0 drift: auth-cli previously pinned
    // its own META_GRAPH_VERSION = "v24.0" while data calls used v22.0. No module
    // may carry its own Graph-version literal; all must derive from GRAPH_VERSION.
    const src = readFileSync(new URL('../auth-cli.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/["'`]v\d+\.0["'`]/);
    expect(src).toMatch(/import[^;]*\bGRAPH_VERSION\b[^;]*from ['"]\.\/lib\/graph/);
  });
});
