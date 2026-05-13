/**
 * Tier 1 write tools: campaign / ad set / ad creative / ad / image upload.
 *
 * Defaults to PAUSED status on every object so MCP callers can build a full
 * campaign hierarchy without accidentally going live. Callers must explicitly
 * flip status=ACTIVE (today via meta_ads_update_object_status, or directly in
 * Ads Manager) after review.
 *
 * Image uploads use Meta's `bytes` form field (base64-encoded image data) —
 * keeps everything on the standard form-urlencoded POST shape used by lib/graph.
 */
import { graphPost } from '../lib/graph.js';

function normalizeAccountId(accountId: string): string {
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`;
}

/* ------------------------------------------------------------------------- */
/* createCampaign                                                             */
/* ------------------------------------------------------------------------- */

export interface CreateCampaignInput {
  account_id: string;
  name: string;
  objective: string;
  status?: 'PAUSED' | 'ACTIVE';
  special_ad_categories?: string[];
  buying_type?: 'AUCTION' | 'RESERVED';
  daily_budget?: number;
  lifetime_budget?: number;
}

export interface CreateCampaignResult {
  campaign_id: string;
  account_id: string;
  name: string;
  status: string;
}

export async function createCampaign(
  input: CreateCampaignInput,
  accessToken: string,
): Promise<CreateCampaignResult> {
  const account = normalizeAccountId(input.account_id);
  const status = input.status ?? 'PAUSED';
  const body: Record<string, string> = {
    name: input.name,
    objective: input.objective,
    status,
    special_ad_categories: JSON.stringify(input.special_ad_categories ?? []),
    buying_type: input.buying_type ?? 'AUCTION',
  };
  if (input.daily_budget !== undefined) body.daily_budget = String(input.daily_budget);
  if (input.lifetime_budget !== undefined) body.lifetime_budget = String(input.lifetime_budget);

  const res = await graphPost<{ id: string }>(`${account}/campaigns`, accessToken, body);
  return { campaign_id: res.id, account_id: account, name: input.name, status };
}

/* ------------------------------------------------------------------------- */
/* createAdSet                                                                */
/* ------------------------------------------------------------------------- */

export interface CreateAdSetInput {
  account_id: string;
  campaign_id: string;
  name: string;
  optimization_goal: string;
  billing_event: 'IMPRESSIONS' | 'LINK_CLICKS' | 'POST_ENGAGEMENT' | 'THRUPLAY';
  bid_strategy?: 'LOWEST_COST_WITHOUT_CAP' | 'LOWEST_COST_WITH_BID_CAP' | 'COST_CAP';
  bid_amount?: number;
  targeting: Record<string, unknown>;
  status?: 'PAUSED' | 'ACTIVE';
  daily_budget?: number;
  lifetime_budget?: number;
  promoted_object?: Record<string, unknown>;
  destination_type?: string;
  attribution_spec?: Array<{ event_type: string; window_days: number }>;
  is_incremental_attribution_enabled?: boolean;
  start_time?: string;
  end_time?: string;
}

export interface CreateAdSetResult {
  adset_id: string;
  account_id: string;
  campaign_id: string;
  name: string;
  status: string;
}

export async function createAdSet(
  input: CreateAdSetInput,
  accessToken: string,
): Promise<CreateAdSetResult> {
  if (input.daily_budget !== undefined && input.lifetime_budget !== undefined) {
    throw new Error('createAdSet: pass daily_budget OR lifetime_budget, not both.');
  }
  if (input.daily_budget === undefined && input.lifetime_budget === undefined) {
    throw new Error(
      'createAdSet: budget required. Pass daily_budget or lifetime_budget, or set the budget on the parent campaign (CBO).',
    );
  }

  const account = normalizeAccountId(input.account_id);
  const status = input.status ?? 'PAUSED';
  const body: Record<string, string> = {
    name: input.name,
    campaign_id: input.campaign_id,
    optimization_goal: input.optimization_goal,
    billing_event: input.billing_event,
    bid_strategy: input.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP',
    targeting: JSON.stringify(input.targeting),
    status,
  };
  if (input.daily_budget !== undefined) body.daily_budget = String(input.daily_budget);
  if (input.lifetime_budget !== undefined) body.lifetime_budget = String(input.lifetime_budget);
  if (input.bid_amount !== undefined) body.bid_amount = String(input.bid_amount);
  if (input.promoted_object) body.promoted_object = JSON.stringify(input.promoted_object);
  if (input.destination_type) body.destination_type = input.destination_type;
  if (input.attribution_spec) body.attribution_spec = JSON.stringify(input.attribution_spec);
  if (input.is_incremental_attribution_enabled !== undefined) {
    body.is_incremental_attribution_enabled = String(input.is_incremental_attribution_enabled);
  }
  if (input.start_time) body.start_time = input.start_time;
  if (input.end_time) body.end_time = input.end_time;

  const res = await graphPost<{ id: string }>(`${account}/adsets`, accessToken, body);
  return {
    adset_id: res.id,
    account_id: account,
    campaign_id: input.campaign_id,
    name: input.name,
    status,
  };
}

/* ------------------------------------------------------------------------- */
/* createAdCreative                                                            */
/* ------------------------------------------------------------------------- */

export interface CallToAction {
  type: string;
  value?: { link?: string; lead_gen_form_id?: string };
}

export interface CreateAdCreativeInput {
  account_id: string;
  name: string;
  page_id: string;
  image_hash?: string;
  link: string;
  message: string;
  headline?: string;
  description?: string;
  call_to_action?: CallToAction;
  /** Shortcut: builds call_to_action={type:'SIGN_UP', value:{lead_gen_form_id}}. */
  lead_gen_form_id?: string;
  url_tags?: string;
  /** Optional Instagram business account id for cross-posting. */
  instagram_actor_id?: string;
}

export interface CreateAdCreativeResult {
  creative_id: string;
  account_id: string;
  name: string;
}

export async function createAdCreative(
  input: CreateAdCreativeInput,
  accessToken: string,
): Promise<CreateAdCreativeResult> {
  const account = normalizeAccountId(input.account_id);

  const callToAction: CallToAction | undefined = input.call_to_action ??
    (input.lead_gen_form_id
      ? { type: 'SIGN_UP', value: { lead_gen_form_id: input.lead_gen_form_id } }
      : undefined);

  const linkData: Record<string, unknown> = {
    link: input.link,
    message: input.message,
  };
  if (input.image_hash) linkData.image_hash = input.image_hash;
  if (input.headline) linkData.name = input.headline;
  if (input.description) linkData.description = input.description;
  if (callToAction) linkData.call_to_action = callToAction;

  const objectStorySpec: Record<string, unknown> = {
    page_id: input.page_id,
    link_data: linkData,
  };
  if (input.instagram_actor_id) objectStorySpec.instagram_actor_id = input.instagram_actor_id;

  const body: Record<string, string> = {
    name: input.name,
    object_story_spec: JSON.stringify(objectStorySpec),
  };
  if (input.url_tags) body.url_tags = input.url_tags;

  const res = await graphPost<{ id: string }>(`${account}/adcreatives`, accessToken, body);
  return { creative_id: res.id, account_id: account, name: input.name };
}

/* ------------------------------------------------------------------------- */
/* createAd                                                                   */
/* ------------------------------------------------------------------------- */

export interface CreateAdInput {
  account_id: string;
  name: string;
  adset_id: string;
  creative_id: string;
  status?: 'PAUSED' | 'ACTIVE';
}

export interface CreateAdResult {
  ad_id: string;
  account_id: string;
  adset_id: string;
  creative_id: string;
  name: string;
  status: string;
}

export async function createAd(
  input: CreateAdInput,
  accessToken: string,
): Promise<CreateAdResult> {
  const account = normalizeAccountId(input.account_id);
  const status = input.status ?? 'PAUSED';
  const body: Record<string, string> = {
    name: input.name,
    adset_id: input.adset_id,
    creative: JSON.stringify({ creative_id: input.creative_id }),
    status,
  };
  const res = await graphPost<{ id: string }>(`${account}/ads`, accessToken, body);
  return {
    ad_id: res.id,
    account_id: account,
    adset_id: input.adset_id,
    creative_id: input.creative_id,
    name: input.name,
    status,
  };
}

/* ------------------------------------------------------------------------- */
/* uploadImage                                                                */
/* ------------------------------------------------------------------------- */

export interface UploadImageInput {
  account_id: string;
  /** Base64-encoded image bytes. Prefer for tests / when caller already has bytes. */
  image_bytes?: string;
  /** Local file path. If provided, the file is read and base64-encoded. */
  image_path?: string;
}

export interface UploadImageResult {
  image_hash: string;
  url: string;
  account_id: string;
}

interface AdImagesResponse {
  images?: Record<string, { hash: string; url: string }>;
}

export async function uploadImage(
  input: UploadImageInput,
  accessToken: string,
): Promise<UploadImageResult> {
  let bytes = input.image_bytes;
  if (!bytes && input.image_path) {
    const { readFileSync } = await import('node:fs');
    bytes = readFileSync(input.image_path).toString('base64');
  }
  if (!bytes) {
    throw new Error('uploadImage: provide image_bytes (base64) or image_path.');
  }

  const account = normalizeAccountId(input.account_id);
  const res = await graphPost<AdImagesResponse>(`${account}/adimages`, accessToken, {
    bytes,
  });
  const first = res.images ? Object.values(res.images)[0] : undefined;
  if (!first) {
    throw new Error('uploadImage: response missing images.bytes — Graph returned no hash.');
  }
  return { image_hash: first.hash, url: first.url, account_id: account };
}
