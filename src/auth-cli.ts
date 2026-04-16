#!/usr/bin/env node
// ============================================
// mcp-meta-ads-auth -- one-time Meta OAuth + long-lived token exchange
// ============================================
// Flow:
//   1. Loopback HTTP listener on a free port
//   2. Open browser to Facebook OAuth dialog (implicit flow, response_type=token)
//   3. Callback page uses JS to extract token from URL fragment, POSTs to local server
//   4. Exchange short-lived token for long-lived token (60 days) using app_secret
//   5. Write credentials to ~/.config/mcp-meta-ads-nodejs/credentials.json
//
// Priority chain at runtime:
//   1. META_ACCESS_TOKEN env var (System User token -- never expires, recommended)
//   2. Cached OAuth token from this CLI (long-lived, ~60 days)

import http from "http";
import { URL } from "url";
import { writeStoredCredentials, credentialsFilePath, CREDENTIALS_FILE_VERSION, type StoredCredentials } from "./credentials.js";
import { findFreeLoopbackPort, openBrowser } from "./platform.js";

const META_GRAPH_VERSION = "v24.0";
const META_AUTH_URL = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
const META_GRAPH_URL = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
const AUTH_SCOPE = "business_management,ads_read,ads_management,pages_show_list,pages_read_engagement";

function parseArgs(argv: string[]): { help: boolean } {
  return { help: argv.includes("--help") || argv.includes("-h") };
}

function printHelp(): void {
  process.stdout.write(
    [
      "mcp-meta-ads-auth -- authorize Claude to access your Meta ad accounts",
      "",
      "Usage:",
      "  npx -p mcp-meta-ads-incrementality mcp-meta-ads-auth",
      "",
      "Options:",
      "  -h, --help    Show this help",
      "",
      `Credentials are written to: ${credentialsFilePath}`,
      "",
      "Note: Meta long-lived tokens expire after ~60 days.",
      "      Re-run this command when your token expires.",
      "      For permanent access, use a System User token from Business Manager",
      "      and set META_ACCESS_TOKEN in your environment.",
      "",
    ].join("\n"),
  );
}

// ============================================
// OAUTH: IMPLICIT FLOW WITH JS FRAGMENT EXTRACTION
// ============================================

function buildAuthUrl(appId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    response_type: "token",
    scope: AUTH_SCOPE,
    state,
  });
  return `${META_AUTH_URL}?${params.toString()}`;
}

/**
 * Meta's implicit OAuth puts the token in the URL fragment (#access_token=...).
 * Fragments are never sent to the server, so the callback page needs JavaScript
 * to extract it and POST it to us.
 */
function renderCallbackPage(port: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Meta Authentication</title>
  <style>
    body { font: 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 480px; margin: 80px auto; padding: 0 24px; color: #222; }
    h1 { font-size: 22px; margin-bottom: 12px; }
    p { line-height: 1.5; }
    .success { color: #16a34a; }
    .error { color: #dc2626; }
  </style>
</head>
<body>
  <h1 id="title">Authenticating...</h1>
  <p id="message">Processing your login...</p>
  <script>
    (function() {
      var hash = window.location.hash.substring(1);
      var params = new URLSearchParams(hash);
      var token = params.get('access_token');
      var state = params.get('state');
      var error = params.get('error');
      var errorDesc = params.get('error_description');

      if (error) {
        document.getElementById('title').textContent = 'Authorization denied';
        document.getElementById('title').className = 'error';
        document.getElementById('message').textContent = errorDesc || error;
        return;
      }

      if (!token) {
        document.getElementById('title').textContent = 'No token received';
        document.getElementById('title').className = 'error';
        document.getElementById('message').textContent = 'Facebook did not return an access token. Please try again.';
        return;
      }

      // POST the token to our local server
      fetch('http://127.0.0.1:${port}/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token, state: state })
      }).then(function(resp) {
        if (resp.ok) {
          document.getElementById('title').textContent = 'Signed in successfully';
          document.getElementById('title').className = 'success';
          document.getElementById('message').textContent = 'You can close this tab and return to the terminal.';
        } else {
          document.getElementById('title').textContent = 'Error';
          document.getElementById('title').className = 'error';
          document.getElementById('message').textContent = 'Failed to send token to local server.';
        }
      }).catch(function() {
        document.getElementById('title').textContent = 'Error';
        document.getElementById('title').className = 'error';
        document.getElementById('message').textContent = 'Could not connect to local server.';
      });
    })();
  </script>
</body>
</html>`;
}

function renderSimplePage(title: string, message: string, isError: boolean): string {
  const cls = isError ? "error" : "success";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px -apple-system,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#222}h1{font-size:22px}.success{color:#16a34a}.error{color:#dc2626}</style>
</head><body><h1 class="${cls}">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface CapturedToken {
  access_token: string;
  state: string;
}

async function waitForToken(port: number, expectedState: string, authUrl: string): Promise<CapturedToken> {
  return new Promise<CapturedToken>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; fn(); };
    const callbackHtml = renderCallbackPage(port);

    const server = http.createServer((req, res) => {
      if (!req.url) { res.writeHead(404).end(); return; }
      const parsed = new URL(req.url, `http://127.0.0.1:${port}`);

      // Serve the callback page (Facebook redirects here with #access_token=...)
      if (parsed.pathname === "/callback" || parsed.pathname === "/") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(callbackHtml);
        return;
      }

      // CORS preflight for the POST
      if (req.method === "OPTIONS" && parsed.pathname === "/token") {
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // Receive the token POSTed by the callback page's JavaScript
      if (req.method === "POST" && parsed.pathname === "/token") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          try {
            const data = JSON.parse(body) as { access_token?: string; state?: string };
            if (!data.access_token) {
              res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
              res.end("Missing access_token");
              return;
            }
            if (data.state !== expectedState) {
              res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
              res.end("State mismatch");
              finish(() => { server.close(); reject(new Error("OAuth state mismatch")); });
              return;
            }
            res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
            res.end("OK");
            finish(() => {
              setTimeout(() => server.close(), 200);
              resolve({ access_token: data.access_token!, state: data.state || "" });
            });
          } catch {
            res.writeHead(400, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" });
            res.end("Invalid JSON");
          }
        });
        return;
      }

      res.writeHead(404).end();
    });

    server.on("error", (err) => {
      finish(() => reject(new Error(`Loopback server failed: ${err.message}`)));
    });

    server.listen(port, "127.0.0.1", () => {
      process.stderr.write(`\nOpening your browser to sign in with Facebook...\n`);
      process.stderr.write(`If it doesn't open automatically, visit:\n  ${authUrl}\n\n`);
      openBrowser(authUrl).catch(() => {});
    });

    setTimeout(() => {
      finish(() => { server.close(); reject(new Error("Timed out waiting for OAuth callback (5 minutes).")); });
    }, 5 * 60 * 1000);
  });
}

// ============================================
// TOKEN EXCHANGE: short-lived -> long-lived
// ============================================

interface LongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number; // seconds, typically ~5184000 (60 days)
}

async function exchangeForLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string,
): Promise<LongLivedTokenResponse> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: shortLivedToken,
  });

  const res = await fetch(`${META_GRAPH_URL}/oauth/access_token?${params.toString()}`);
  const json = (await res.json()) as Record<string, unknown>;

  if (!res.ok || json.error) {
    const errMsg = (json.error as any)?.message || json.error || res.statusText;
    throw new Error(`Long-lived token exchange failed: ${errMsg}`);
  }

  if (!json.access_token) {
    throw new Error("No access_token in exchange response");
  }

  return {
    access_token: json.access_token as string,
    token_type: (json.token_type as string) || "bearer",
    expires_in: (json.expires_in as number) || 5184000,
  };
}

// ============================================
// VERIFY TOKEN + GET USER INFO
// ============================================

async function verifyToken(token: string): Promise<{ name: string; id: string }> {
  const res = await fetch(`${META_GRAPH_URL}/me?access_token=${encodeURIComponent(token)}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.error) {
    throw new Error(`Token verification failed: ${(json.error as any)?.message || json.error || res.statusText}`);
  }
  return { name: (json.name as string) || "Unknown", id: (json.id as string) || "" };
}

// ============================================
// LIST AD ACCOUNTS
// ============================================

interface AdAccountInfo {
  id: string;
  name: string;
  account_id: string;
}

async function listAdAccounts(token: string): Promise<AdAccountInfo[]> {
  const res = await fetch(
    `${META_GRAPH_URL}/me/adaccounts?fields=name,account_id&limit=100&access_token=${encodeURIComponent(token)}`,
  );
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.error) {
    throw new Error(`Failed to list ad accounts: ${(json.error as any)?.message || res.statusText}`);
  }
  return ((json.data as any[]) || []).map((a) => ({
    id: a.id,
    name: a.name || `(unnamed ${a.account_id})`,
    account_id: a.account_id,
  }));
}

// ============================================
// MAIN
// ============================================

export async function run(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return; }

  const appId = (process.env.META_APP_ID ?? "").trim();
  const appSecret = (process.env.META_APP_SECRET ?? "").trim();

  if (!appId) {
    process.stderr.write(
      "META_APP_ID environment variable is required.\n" +
        "Get your App ID from https://developers.facebook.com/apps/\n",
    );
    process.exit(2);
  }
  if (!appSecret) {
    process.stderr.write(
      "META_APP_SECRET environment variable is required for long-lived token exchange.\n" +
        "Find it in your Facebook App settings under App Secret.\n",
    );
    process.exit(2);
  }

  const port = await findFreeLoopbackPort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const state = randomState();
  const authUrl = buildAuthUrl(appId, redirectUri, state);

  process.stderr.write("\n=== Meta Ads authentication ===\n");

  const { access_token: shortLivedToken } = await waitForToken(port, state, authUrl);
  process.stderr.write("Short-lived token received. Exchanging for long-lived token...\n");

  const longLived = await exchangeForLongLivedToken(shortLivedToken, appId, appSecret);
  const expiryDays = Math.round(longLived.expires_in / 86400);
  process.stderr.write(`Long-lived token obtained (expires in ~${expiryDays} days).\n`);

  process.stderr.write("Verifying token...\n");
  const user = await verifyToken(longLived.access_token);

  process.stderr.write("Fetching accessible ad accounts...\n");
  const accounts = await listAdAccounts(longLived.access_token);

  const stored: StoredCredentials = {
    version: CREDENTIALS_FILE_VERSION,
    access_token: longLived.access_token,
    expires_in: longLived.expires_in,
    obtained_at: new Date().toISOString(),
    created_at: Math.floor(Date.now() / 1000),
    user_name: user.name,
    user_id: user.id,
    ad_accounts: accounts.map((a) => ({ id: a.id, name: a.name, account_id: a.account_id })),
  };
  writeStoredCredentials(stored);

  const expiryDate = new Date(Date.now() + longLived.expires_in * 1000).toISOString().slice(0, 10);

  process.stderr.write(
    [
      "",
      "Done.",
      "",
      `  User:        ${user.name} (${user.id})`,
      `  Ad accounts: ${accounts.length} accessible`,
      ...accounts.slice(0, 5).map((a) => `               - ${a.name} (${a.account_id})`),
      accounts.length > 5 ? `               ... and ${accounts.length - 5} more` : "",
      `  Expires:     ~${expiryDate} (${expiryDays} days)`,
      `  Saved to:    ${credentialsFilePath}`,
      "",
      "Next step: fully quit Claude Desktop (Cmd+Q / File > Exit) and reopen it.",
      'Then try: "Get Meta ad performance for last 7 days"',
      "",
      `Note: This token expires in ~${expiryDays} days. Re-run this command to refresh.`,
      "For permanent access, use a System User token and set META_ACCESS_TOKEN.",
      "",
    ].filter(Boolean).join("\n"),
  );
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Always run -- bin symlink name (mcp-meta-ads-auth) differs from file name
// (auth-cli.js), so isMain checks fail under npx.
run().catch((err) => {
  process.stderr.write(`\n${err.message}\n`);
  process.exit(1);
});
