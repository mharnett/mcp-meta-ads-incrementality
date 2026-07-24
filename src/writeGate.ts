import { createWriteGate } from 'mcp-write-gate';

/**
 * Tools that mutate Meta Ads state. These are hidden from the tool list and
 * refused at call time unless META_ADS_MCP_WRITE=true.
 *
 * The env prefix is deliberately META_ADS — shared with the Python meta-ads
 * MCP server — so one flag means "Meta writes allowed this session" across
 * both servers.
 *
 * Adding a new tool? Put it in this set if it creates, updates, deletes,
 * uploads, swaps, rebinds, edits, or renames anything. The shape test in
 * writeGate.test.ts enforces this by name pattern.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'meta_ads_update_ad_url_tags',
  'meta_ads_rename_ad',
  'meta_ads_swap_ad_lead_form',
  'meta_ads_rebind_ad_creative',
  'meta_ads_edit_creative_text',
  'meta_ads_create_campaign',
  'meta_ads_create_adset',
  'meta_ads_create_ad_creative',
  'meta_ads_create_ad',
  'meta_ads_upload_image',
  'meta_ads_create_leadgen_form',
  'meta_ads_create_custom_audience',
  'meta_ads_upload_users_to_audience',
  'meta_ads_create_lookalike_audience',
  'meta_ads_update_object_status',
  'meta_ads_update_budget',
  'meta_ads_delete_object',
]);

const gate = createWriteGate({
  writeTools: WRITE_TOOLS,
  envPrefix: 'META_ADS',
});

export function isWriteTool(name: string): boolean {
  return gate.isWriteTool(name);
}

export function isWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gate.isWriteEnabled(env);
}

export function filterTools<T extends { name: string }>(
  allTools: readonly T[],
  env: NodeJS.ProcessEnv = process.env,
): T[] {
  return gate.filterTools(allTools, env);
}

export const WRITE_DISABLED_MESSAGE =
  'Write operations are disabled. Set META_ADS_MCP_WRITE=true in the MCP server environment ' +
  'to enable mutating tools (create/update/delete/upload/swap/rebind/edit/rename).';

/**
 * Assert that a tool call is allowed under the current write-mode setting.
 * Throws a clear Error if the tool mutates state and writes are disabled.
 */
export function assertWriteAllowed(
  toolName: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    gate.assertWriteAllowed(toolName, env);
  } catch {
    throw new Error(
      `Tool "${toolName}" is a write operation. ${WRITE_DISABLED_MESSAGE}`,
    );
  }
}
