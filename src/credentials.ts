// ============================================
// CREDENTIAL LOADING & PERSISTENCE
// ============================================
// Priority order:
//   1. META_ACCESS_TOKEN env var (System User token -- never expires, recommended)
//   2. Cached OAuth token from mcp-meta-ads-auth (long-lived, ~60 days)
//
// System User tokens are preferred for production. OAuth is the fallback
// for users who don't have Business Manager admin access.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import path from "path";
import { configDir, credentialsFilePath } from "./platform.js";

export const CREDENTIALS_FILE_VERSION = 1;

export interface StoredCredentials {
  version: number;
  access_token: string;
  expires_in: number;        // seconds from created_at
  obtained_at: string;       // ISO timestamp
  created_at: number;        // unix epoch seconds
  user_name?: string;
  user_id?: string;
  ad_accounts?: Array<{ id: string; name: string; account_id: string }>;
}

export interface ResolvedCredentials {
  access_token: string;
  source: "env" | "file";
  expires_at?: number;  // unix epoch seconds, undefined for env (System User tokens don't expire)
}

const envTrimmed = (key: string): string =>
  (process.env[key] || "").trim().replace(/^["']|["']$/g, "");

// ============================================
// FILE I/O
// ============================================

export function readStoredCredentials(filePath: string = credentialsFilePath): StoredCredentials | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== CREDENTIALS_FILE_VERSION) return null;
    return parsed as StoredCredentials;
  } catch {
    return null;
  }
}

export function writeStoredCredentials(
  creds: StoredCredentials,
  filePath: string = credentialsFilePath,
): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(creds, null, 2), { encoding: "utf-8" });
  try { chmodSync(filePath, 0o600); } catch {}
}

// ============================================
// RESOLVE (read-time priority chain)
// ============================================

export function resolveCredentials(
  credsFilePath: string = credentialsFilePath,
): ResolvedCredentials {
  // 1. Environment variable takes absolute priority (System User token)
  const envToken = envTrimmed("META_ACCESS_TOKEN");
  if (envToken) {
    return { access_token: envToken, source: "env" };
  }

  // 2. Cached OAuth token from auth CLI
  const stored = readStoredCredentials(credsFilePath);
  if (stored?.access_token) {
    const expiresAt = stored.created_at + stored.expires_in;
    const now = Math.floor(Date.now() / 1000);

    if (now >= expiresAt) {
      // Token expired
      throw new Error(
        buildExpiredMessage(stored),
      );
    }

    const daysLeft = Math.round((expiresAt - now) / 86400);
    if (daysLeft <= 7) {
      process.stderr.write(
        `[warning] Meta OAuth token expires in ${daysLeft} day(s). ` +
          `Re-run: npx -p mcp-meta-ads-incrementality mcp-meta-ads-auth\n`,
      );
    }

    return {
      access_token: stored.access_token,
      source: "file",
      expires_at: expiresAt,
    };
  }

  // 3. Nothing found
  throw new Error(buildMissingMessage());
}

function buildExpiredMessage(stored: StoredCredentials): string {
  return [
    `Meta OAuth token has expired (obtained ${stored.obtained_at}).`,
    ``,
    `To re-authenticate, run:`,
    `    npx -p mcp-meta-ads-incrementality mcp-meta-ads-auth`,
    ``,
    `Or for permanent access, set META_ACCESS_TOKEN to a System User token`,
    `from Meta Business Manager (never expires).`,
  ].join("\n");
}

function buildMissingMessage(): string {
  return [
    `No Meta access token found.`,
    ``,
    `Option 1 (recommended): System User token`,
    `  Create one at business.facebook.com > Business Settings > System Users`,
    `  Then set META_ACCESS_TOKEN in your environment.`,
    ``,
    `Option 2: Browser sign-in (expires in ~60 days)`,
    `  Run: npx -p mcp-meta-ads-incrementality mcp-meta-ads-auth`,
    ``,
    `Credentials are stored at: ${credentialsFilePath}`,
  ].join("\n");
}

export { configDir, credentialsFilePath } from "./platform.js";
