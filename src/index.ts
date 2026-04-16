#!/usr/bin/env node
/**
 * mcp-meta-ads-incrementality — MCP server entrypoint.
 *
 * Exposes Meta Marketing API insights with a focus on incrementality reporting.
 * Defaults to Meta's `incrementality` attribution window so agencies can lead
 * with the incremental conversion number rather than the inflated default
 * 7d-click + 1d-view that platform reports surface today.
 *
 * Auth: reads META_ACCESS_TOKEN from the environment. Recommended: System User
 * token from Business Manager (long-lived, scoped to ad accounts the System
 * User has access to). User access tokens also work but expire.
 *
 * Transport: stdio. Configure inside your MCP client (Claude Desktop, Claude
 * Code, etc.) by pointing it at this binary.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MetaInsightsClient, createDefaultMetaSdk } from './lib/meta-client.js';
import {
  runInsightsIncrementality,
  type InsightsIncrementalityDeps,
} from './tools/insights-incrementality.js';
import { ALL_KNOWN_WINDOWS } from './lib/attribution.js';
import { resolveCredentials } from './credentials.js';

/* ------------------------------------------------------------------------- */
/* CLI flags                                                                 */
/* ------------------------------------------------------------------------- */

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
) as { name: string; version: string };

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stderr.write(`${pkg.name} v${pkg.version}\n\n`);
  process.stderr.write(`MCP server for Meta Marketing API incrementality reporting.\n`);
  process.stderr.write(`Communicates over stdio. Configure in your MCP client.\n\n`);
  process.stderr.write(`Auth (priority order):\n`);
  process.stderr.write(`  1. META_ACCESS_TOKEN env var (System User token, recommended)\n`);
  process.stderr.write(`  2. Cached OAuth token from: npx -p mcp-meta-ads-incrementality mcp-meta-ads-auth\n\n`);
  process.stderr.write(`Options:\n`);
  process.stderr.write(`  --help, -h     Show this help\n`);
  process.stderr.write(`  --version, -v  Show version\n`);
  process.exit(0);
}
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stderr.write(`${pkg.version}\n`);
  process.exit(0);
}

/* ------------------------------------------------------------------------- */
/* Auth & client construction                                                */
/* ------------------------------------------------------------------------- */

let accessToken: string;
try {
  const resolved = resolveCredentials();
  accessToken = resolved.access_token;
  process.stderr.write(`[startup] Auth: ${resolved.source === 'env' ? 'META_ACCESS_TOKEN env var' : 'cached OAuth token'}\n`);
  if (resolved.expires_at) {
    const daysLeft = Math.round((resolved.expires_at - Date.now() / 1000) / 86400);
    process.stderr.write(`[startup] Token expires in ~${daysLeft} days\n`);
  }
} catch (err) {
  process.stderr.write(`[fatal] ${(err as Error).message}\n`);
  process.exit(1);
}

let deps: InsightsIncrementalityDeps;
try {
  const sdk = await createDefaultMetaSdk();
  const metaClient = new MetaInsightsClient(sdk, accessToken);
  deps = { metaClient };
} catch (err) {
  process.stderr.write(`[fatal] Failed to initialize Meta SDK: ${(err as Error).message}\n`);
  process.exit(1);
}

/* ------------------------------------------------------------------------- */
/* Tool definitions (JSONSchema)                                             */
/* ------------------------------------------------------------------------- */

const TOOL_INSIGHTS_INCREMENTALITY = {
  name: 'meta_ads_insights_incrementality',
  description:
    'Pull Meta Ads insights with a focus on incremental conversions. By default this returns ' +
    'Meta\'s "incrementality" attribution window — the actual incremental conversion count — ' +
    'rather than the default 7d-click + 1d-view number that systematically overstates ad impact. ' +
    'When both incrementality and default windows are requested in the same call, the response ' +
    'includes inflation_factor and overstatement_pct so an agency can quantify the gap between ' +
    'reported and incremental performance.',
  inputSchema: {
    type: 'object',
    properties: {
      ad_account_id: {
        type: 'string',
        description: 'Meta ad account id (with or without the act_ prefix).',
      },
      date_range: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'YYYY-MM-DD start date (inclusive)' },
          until: { type: 'string', description: 'YYYY-MM-DD end date (inclusive)' },
        },
        required: ['since', 'until'],
      },
      conversion_event_name: {
        type: 'string',
        description:
          'The action_type to extract, e.g. "offsite_conversion.fb_pixel_purchase", ' +
          '"omni_purchase", or a custom conversion name.',
      },
      attribution_windows: {
        type: 'array',
        items: { type: 'string', enum: [...ALL_KNOWN_WINDOWS] },
        description:
          'Which attribution windows to fetch. Defaults to ["incrementality"]. Pass ' +
          '["incrementality", "7d_click", "1d_view"] for the headline incrementality-vs-default ' +
          'comparison. Add "dda" to also include Meta\'s data-driven attribution number.',
      },
      level: {
        type: 'string',
        enum: ['account', 'campaign', 'adset', 'ad'],
        description: 'Aggregation level. Defaults to "campaign".',
      },
      campaign_id: { type: 'string', description: 'Optional: restrict to a single campaign.' },
      adset_id: { type: 'string', description: 'Optional: restrict to a single ad set.' },
      breakdowns: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional Meta breakdowns, e.g. ["publisher_platform", "age"].',
      },
    },
    required: ['ad_account_id', 'date_range', 'conversion_event_name'],
  },
} as const;

const TOOLS = [TOOL_INSIGHTS_INCREMENTALITY];

/* ------------------------------------------------------------------------- */
/* Server                                                                    */
/* ------------------------------------------------------------------------- */

const server = new Server(
  { name: pkg.name, version: pkg.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case 'meta_ads_insights_incrementality': {
        const result = await runInsightsIncrementality(args, deps);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      }
      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[ready] ${pkg.name} v${pkg.version} listening on stdio\n`);
