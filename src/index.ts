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
import {
  listAdsInCampaign,
  getAdUrlTags,
  updateAdUrlTags,
} from './tools/url-tags.js';
import { ALL_KNOWN_WINDOWS } from './lib/attribution.js';
import { resolveCredentials } from './credentials.js';
import { safeResponse } from './safe-response.js';

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

const TOOL_LIST_ADS_IN_CAMPAIGN = {
  name: 'meta_ads_list_ads_in_campaign',
  description:
    'List all ads in a Meta campaign with their id, name, status, and current creative_id. ' +
    'Use as the discovery step before reading or updating url_tags across a campaign.',
  inputSchema: {
    type: 'object',
    properties: {
      campaign_id: { type: 'string', description: 'Meta campaign id (numeric).' },
    },
    required: ['campaign_id'],
  },
} as const;

const TOOL_GET_AD_URL_TAGS = {
  name: 'meta_ads_get_ad_url_tags',
  description:
    'Read the current url_tags (URL parameters) on a single Meta ad, plus the underlying ' +
    'clickthrough link and creative_id. Use to inspect what utm tagging is in place today ' +
    'before updating it.',
  inputSchema: {
    type: 'object',
    properties: {
      ad_id: { type: 'string', description: 'Meta ad id (numeric).' },
    },
    required: ['ad_id'],
  },
} as const;

const TOOL_UPDATE_AD_URL_TAGS = {
  name: 'meta_ads_update_ad_url_tags',
  description:
    'Update the url_tags (URL parameters) on a single Meta ad. The value should be a query-' +
    'string fragment WITHOUT a leading ?, e.g. "utm_source=facebook&utm_campaign=foo&' +
    'campaignid={{campaign.id}}". Note Meta uses double-brace macros ({{campaign.id}}, ' +
    '{{ad.id}}, {{ad.name}}, etc.), not Google-Ads-style single braces. ' +
    'Mechanism: POSTs a creative override to the ad, which forks a new creative under the ' +
    'hood while keeping the ad_id stable. Pass dry_run=true to preview without writing. ' +
    'Recommend testing on a PAUSED ad before touching active ones — Meta may briefly re-review.',
  inputSchema: {
    type: 'object',
    properties: {
      ad_id: { type: 'string', description: 'Meta ad id (numeric).' },
      url_tags: {
        type: 'string',
        description:
          'New url_tags value. Query-string fragment, no leading ?. Use {{campaign.id}} / ' +
          '{{ad.id}} / {{ad.name}} for Meta dynamic macros.',
      },
      dry_run: {
        type: 'boolean',
        description: 'If true, return a diff without writing. Default false.',
      },
    },
    required: ['ad_id', 'url_tags'],
  },
} as const;

const TOOLS = [
  TOOL_INSIGHTS_INCREMENTALITY,
  TOOL_LIST_ADS_IN_CAMPAIGN,
  TOOL_GET_AD_URL_TAGS,
  TOOL_UPDATE_AD_URL_TAGS,
];

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
          content: [{ type: 'text', text: JSON.stringify(safeResponse(result, name), null, 2) }],
        };
      }
      case 'meta_ads_list_ads_in_campaign': {
        const { campaign_id } = (args ?? {}) as { campaign_id?: string };
        if (!campaign_id) throw new Error('campaign_id is required');
        const result = await listAdsInCampaign(campaign_id, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'meta_ads_get_ad_url_tags': {
        const { ad_id } = (args ?? {}) as { ad_id?: string };
        if (!ad_id) throw new Error('ad_id is required');
        const result = await getAdUrlTags(ad_id, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'meta_ads_update_ad_url_tags': {
        const { ad_id, url_tags, dry_run } = (args ?? {}) as {
          ad_id?: string;
          url_tags?: string;
          dry_run?: boolean;
        };
        if (!ad_id) throw new Error('ad_id is required');
        if (typeof url_tags !== 'string') throw new Error('url_tags is required');
        const result = await updateAdUrlTags(ad_id, url_tags, accessToken, Boolean(dry_run));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
