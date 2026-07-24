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
  renameAd,
  swapAdLeadForm,
  rebindAdCreative,
  editCreativeText,
} from './tools/url-tags.js';
import {
  createCampaign,
  createAdSet,
  createAdCreative,
  createAd,
  uploadImage,
  type CreateCampaignInput,
  type CreateAdSetInput,
  type CreateAdCreativeInput,
  type CreateAdInput,
  type UploadImageInput,
} from './tools/campaign-build.js';
import {
  createLeadgenForm,
  createCustomAudience,
  uploadUsersToAudience,
  createLookalikeAudience,
  type CreateLeadgenFormInput,
  type CreateCustomAudienceInput,
  type UploadUsersToAudienceInput,
  type CreateLookalikeAudienceInput,
} from './tools/audiences-and-forms.js';
import {
  updateObjectStatus,
  updateBudget,
  deleteObject,
  type UpdateObjectStatusInput,
  type UpdateBudgetInput,
  type DeleteObjectInput,
} from './tools/lifecycle.js';
import { validateName } from './lib/naming-standards.js';
import { resolveCredentials } from './credentials.js';
import { TOOLS } from './toolDefinitions.js';
import { filterTools, assertWriteAllowed } from './writeGate.js';
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
/* Server                                                                    */
/* ------------------------------------------------------------------------- */

const server = new Server(
  { name: pkg.name, version: pkg.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: filterTools(TOOLS),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    assertWriteAllowed(name);
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
      case 'meta_ads_rename_ad': {
        const { ad_id, new_name, dry_run, allow_naming_violations } = (args ?? {}) as {
          ad_id?: string;
          new_name?: string;
          dry_run?: boolean;
          allow_naming_violations?: boolean;
        };
        if (!ad_id) throw new Error('ad_id is required');
        if (typeof new_name !== 'string' || !new_name) throw new Error('new_name is required');
        const violations = validateName(new_name, 'ad');
        if (violations.length > 0 && !allow_naming_violations) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: `Naming standard violations on "${new_name}":\n` +
                violations.map((v) => `  - ${v.rule}: ${v.detail}` +
                  (v.suggested ? ` (suggest: "${v.suggested}")` : '')).join('\n') +
                `\n\nPass allow_naming_violations=true to override.`,
            }],
          };
        }
        const result = await renameAd(ad_id, new_name, accessToken, Boolean(dry_run));
        const out = violations.length > 0
          ? { ...result, naming_violations: violations }
          : result;
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }
      case 'meta_ads_swap_ad_lead_form': {
        const { ad_id, new_form_id, cta_type, dry_run } = (args ?? {}) as {
          ad_id?: string;
          new_form_id?: string;
          cta_type?: string;
          dry_run?: boolean;
        };
        if (!ad_id) throw new Error('ad_id is required');
        if (typeof new_form_id !== 'string' || !new_form_id) throw new Error('new_form_id is required');
        const result = await swapAdLeadForm(ad_id, new_form_id, accessToken, Boolean(dry_run), cta_type);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'meta_ads_rebind_ad_creative': {
        const { ad_id, creative_id, dry_run, force } = (args ?? {}) as {
          ad_id?: string;
          creative_id?: string;
          dry_run?: boolean;
          force?: boolean;
        };
        if (!ad_id) throw new Error('ad_id is required');
        if (typeof creative_id !== 'string' || !creative_id) throw new Error('creative_id is required');
        const result = await rebindAdCreative(ad_id, creative_id, accessToken, Boolean(dry_run), Boolean(force));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'meta_ads_edit_creative_text': {
        const { ad_id, messages, headlines, descriptions, dry_run, force } = (args ?? {}) as {
          ad_id?: string;
          messages?: string[];
          headlines?: string[];
          descriptions?: string[];
          dry_run?: boolean;
          force?: boolean;
        };
        if (!ad_id) throw new Error('ad_id is required');
        const result = await editCreativeText(
          ad_id,
          { messages, headlines, descriptions },
          accessToken,
          Boolean(dry_run),
          Boolean(force),
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'meta_ads_create_campaign': {
        const r = await createCampaign((args ?? {}) as unknown as CreateCampaignInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_create_adset': {
        const r = await createAdSet((args ?? {}) as unknown as CreateAdSetInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_create_ad_creative': {
        const r = await createAdCreative((args ?? {}) as unknown as CreateAdCreativeInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_create_ad': {
        const r = await createAd((args ?? {}) as unknown as CreateAdInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_upload_image': {
        const r = await uploadImage((args ?? {}) as unknown as UploadImageInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_create_leadgen_form': {
        const r = await createLeadgenForm((args ?? {}) as unknown as CreateLeadgenFormInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_create_custom_audience': {
        const r = await createCustomAudience((args ?? {}) as unknown as CreateCustomAudienceInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_upload_users_to_audience': {
        const r = await uploadUsersToAudience((args ?? {}) as unknown as UploadUsersToAudienceInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_create_lookalike_audience': {
        const r = await createLookalikeAudience((args ?? {}) as unknown as CreateLookalikeAudienceInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_update_object_status': {
        const r = await updateObjectStatus((args ?? {}) as unknown as UpdateObjectStatusInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_update_budget': {
        const r = await updateBudget((args ?? {}) as unknown as UpdateBudgetInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
      }
      case 'meta_ads_delete_object': {
        const r = await deleteObject((args ?? {}) as unknown as DeleteObjectInput, accessToken);
        return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
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
