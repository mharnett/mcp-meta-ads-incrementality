/**
 * URL-tags tools — read and update the `url_tags` query-string fragment that
 * Meta appends to ad clickthrough URLs.
 *
 * Why a thin Graph-API client instead of the SDK: the SDK adapter in this repo
 * is shaped around insights cursors. URL-tags reads/writes are simple REST
 * calls, so we hit the Graph API directly via fetch.
 *
 * Update strategy: create-then-rebind. We tried `POST /{ad-id}` with an
 * inline creative override (`creative={creative_id, url_tags}`) — Meta returns
 * success but silently no-ops, leaving the ad on the original creative.
 * Verified empirically on ad 120243275305000447 (2026-05-05): POST returned
 * success, read-back showed url_tags unchanged. Meta creatives are effectively
 * immutable, so the working pattern is:
 *   1. Read the existing creative's object_story_id (Page-post reference).
 *   2. POST /act_X/adcreatives with same object_story_id + new url_tags →
 *      yields a new creative_id.
 *   3. POST /{ad-id} with creative_id=<new> to rebind.
 * The ad-id is unchanged. Meta may briefly re-review the ad.
 */
import { graphGet, graphPost } from '../lib/graph.js';

/* ------------------------------------------------------------------------- */
/* List ads in a campaign                                                    */
/* ------------------------------------------------------------------------- */

export interface AdSummary {
  id: string;
  name: string;
  status: string;
  effective_status?: string;
  campaign_id: string;
  creative_id: string;
}

interface ListAdsResponse {
  data: Array<{
    id: string;
    name: string;
    status: string;
    effective_status?: string;
    campaign_id: string;
    creative?: { id: string };
  }>;
  paging?: { cursors?: { after?: string }; next?: string };
}

export async function listAdsInCampaign(
  campaignId: string,
  accessToken: string,
): Promise<AdSummary[]> {
  const all: AdSummary[] = [];
  let after: string | undefined;
  do {
    const params: Record<string, string> = {
      fields: 'id,name,status,effective_status,campaign_id,creative{id}',
      limit: '100',
    };
    if (after) params.after = after;
    const page = await graphGet<ListAdsResponse>(`${campaignId}/ads`, accessToken, params);
    for (const ad of page.data) {
      all.push({
        id: ad.id,
        name: ad.name,
        status: ad.status,
        effective_status: ad.effective_status,
        campaign_id: ad.campaign_id,
        creative_id: ad.creative?.id ?? '',
      });
    }
    after = page.paging?.next ? page.paging.cursors?.after : undefined;
  } while (after);
  return all;
}

/* ------------------------------------------------------------------------- */
/* Read url_tags for one ad                                                  */
/* ------------------------------------------------------------------------- */

export interface LearningStageInfo {
  status: string | null;
  last_significant_edit_ts: number | null;
}

export interface AdUrlTagsInfo {
  ad_id: string;
  ad_name: string;
  account_id: string;
  campaign_id: string;
  campaign_name: string;
  creative_id: string;
  object_story_id: string | null;
  url_tags: string | null;
  link: string | null;
  learning_stage_info: LearningStageInfo | null;
}

interface AdReadResponse {
  id: string;
  name: string;
  account_id?: string;
  campaign_id: string;
  adset_id?: string;
  campaign?: { id: string; name: string };
  creative?: {
    id: string;
    url_tags?: string;
    object_story_id?: string;
    effective_object_story_id?: string;
    object_story_spec?: {
      link_data?: { link?: string };
      video_data?: { call_to_action?: { value?: { link?: string } } };
    };
  };
}

async function fetchAdsetLearningStage(
  adsetId: string | null,
  accessToken: string,
): Promise<LearningStageInfo | null> {
  if (!adsetId) return null;
  try {
    const r = await graphGet<{ learning_stage_info?: { status?: string; last_significant_edit_ts?: number } }>(
      adsetId,
      accessToken,
      { fields: 'learning_stage_info' },
    );
    if (!r.learning_stage_info) return null;
    return {
      status: r.learning_stage_info.status ?? null,
      last_significant_edit_ts: r.learning_stage_info.last_significant_edit_ts ?? null,
    };
  } catch {
    return null;
  }
}

export async function getAdUrlTags(adId: string, accessToken: string): Promise<AdUrlTagsInfo> {
  const ad = await graphGet<AdReadResponse>(adId, accessToken, {
    fields: 'id,name,account_id,campaign_id,adset_id,campaign{id,name},creative{id,url_tags,object_story_id,effective_object_story_id,object_story_spec{link_data{link},video_data{call_to_action}}}',
  });
  const link =
    ad.creative?.object_story_spec?.link_data?.link ??
    ad.creative?.object_story_spec?.video_data?.call_to_action?.value?.link ??
    null;
  const learning = await fetchAdsetLearningStage(ad.adset_id ?? null, accessToken);
  return {
    ad_id: ad.id,
    ad_name: ad.name,
    account_id: ad.account_id ?? '',
    campaign_id: ad.campaign_id,
    campaign_name: ad.campaign?.name ?? '',
    creative_id: ad.creative?.id ?? '',
    object_story_id: ad.creative?.object_story_id ?? ad.creative?.effective_object_story_id ?? null,
    url_tags: ad.creative?.url_tags ?? null,
    link,
    learning_stage_info: learning,
  };
}

/* ------------------------------------------------------------------------- */
/* Update url_tags on one ad                                                 */
/* ------------------------------------------------------------------------- */

export interface UpdateAdUrlTagsResult {
  ad_id: string;
  ad_name: string;
  previous_url_tags: string | null;
  new_url_tags: string;
  previous_creative_id: string;
  new_creative_id: string;
  changed: boolean;
  learning_before: LearningStageInfo | null;
  learning_after: LearningStageInfo | null;
  significant_edit_triggered: boolean | null;
}

interface AdUpdateResponse {
  success?: boolean;
  id?: string;
}

interface CreativeCreateResponse {
  id: string;
}

/**
 * Update url_tags via create-then-rebind WITH social-feedback preservation.
 *
 * The Meta UI itself forks a new creative when url_tags changes (verified by
 * inspecting Ads Manager network calls 2026-05-05 — the internal payload
 * shows action_metadata.type=DUPLICATION_UPGRADE and
 * enable_social_feedback_preservation=true). Meta's relearning trigger is
 * field-aware: changes to url_tags alone are documented as not resetting
 * learning, when social-feedback preservation carries forward.
 *
 * This implementation replicates that behavior on the public Marketing API:
 *   1. Read current creative → get object_story_id, account_id, learning_stage_info.
 *   2. POST /act_X/adcreatives with {object_story_id, url_tags,
 *      object_story_spec.use_page_actor_override flag implicit} — same
 *      Page-post reference, only url_tags differs.
 *   3. POST /{ad-id} with creative_id=<new>.
 *   4. Re-read learning_stage_info; compare last_significant_edit_ts.
 *
 * If last_significant_edit_ts is unchanged, Meta did not consider the edit
 * significant — confirming learning is preserved. If it advanced to roughly
 * the time of our write, Meta did trigger a relearning event and the writer
 * should be considered unsafe for active ads.
 */
export async function updateAdUrlTags(
  adId: string,
  newUrlTags: string,
  accessToken: string,
  dryRun: boolean,
): Promise<UpdateAdUrlTagsResult> {
  const before = await getAdUrlTags(adId, accessToken);

  if (dryRun) {
    return {
      ad_id: before.ad_id,
      ad_name: before.ad_name,
      previous_url_tags: before.url_tags,
      new_url_tags: newUrlTags,
      previous_creative_id: before.creative_id,
      new_creative_id: '',
      changed: before.url_tags !== newUrlTags,
      learning_before: before.learning_stage_info,
      learning_after: null,
      significant_edit_triggered: null,
    };
  }

  if (before.url_tags === newUrlTags) {
    return {
      ad_id: before.ad_id,
      ad_name: before.ad_name,
      previous_url_tags: before.url_tags,
      new_url_tags: newUrlTags,
      previous_creative_id: before.creative_id,
      new_creative_id: before.creative_id,
      changed: false,
      learning_before: before.learning_stage_info,
      learning_after: before.learning_stage_info,
      significant_edit_triggered: false,
    };
  }

  if (!before.object_story_id) {
    throw new Error(
      `Ad ${adId} creative ${before.creative_id} has no object_story_id; ` +
      `create-then-rebind path requires a Page-post-backed creative.`,
    );
  }
  if (!before.account_id) {
    throw new Error(`Ad ${adId} did not return account_id.`);
  }

  const created = await graphPost<CreativeCreateResponse>(
    `act_${before.account_id}/adcreatives`,
    accessToken,
    {
      object_story_id: before.object_story_id,
      url_tags: newUrlTags,
      name: `${before.ad_name} — url_tags ${new Date().toISOString().slice(0, 10)}`,
    },
  );

  await graphPost<AdUpdateResponse>(adId, accessToken, {
    creative: JSON.stringify({ creative_id: created.id }),
  });

  const after = await getAdUrlTags(adId, accessToken);
  const beforeTs = before.learning_stage_info?.last_significant_edit_ts ?? null;
  const afterTs = after.learning_stage_info?.last_significant_edit_ts ?? null;
  const significantEditTriggered =
    beforeTs !== null && afterTs !== null ? afterTs > beforeTs : null;

  return {
    ad_id: after.ad_id,
    ad_name: after.ad_name,
    previous_url_tags: before.url_tags,
    new_url_tags: after.url_tags ?? newUrlTags,
    previous_creative_id: before.creative_id,
    new_creative_id: after.creative_id,
    changed: before.creative_id !== after.creative_id || before.url_tags !== after.url_tags,
    learning_before: before.learning_stage_info,
    learning_after: after.learning_stage_info,
    significant_edit_triggered: significantEditTriggered,
  };
}

/* ------------------------------------------------------------------------- */
/* Swap lead form on an ad                                                   */
/* ------------------------------------------------------------------------- */

export interface SwapAdLeadFormResult {
  ad_id: string;
  ad_name: string;
  previous_creative_id: string;
  new_creative_id: string;
  previous_form_id: string | null;
  new_form_id: string;
  mode: 'asset_feed_spec' | 'object_story_spec';
  changed: boolean;
}

interface CreativeReadFull {
  id: string;
  name?: string;
  url_tags?: string;
  object_story_id?: string;
  effective_object_story_id?: string;
  object_story_spec?: {
    page_id?: string;
    instagram_actor_id?: string;
    link_data?: {
      link?: string;
      message?: string;
      name?: string;
      description?: string;
      image_hash?: string;
      call_to_action?: { type?: string; value?: { lead_gen_form_id?: string; link?: string } };
    };
  };
  asset_feed_spec?: {
    images?: Array<{ hash?: string }>;
    bodies?: Array<{ text?: string }>;
    titles?: Array<{ text?: string }>;
    descriptions?: Array<{ text?: string }>;
    link_urls?: Array<{ website_url?: string }>;
    call_to_action_types?: string[];
    call_to_actions?: Array<{ type?: string; value?: { lead_gen_form_id?: string } }>;
    ad_formats?: string[];
  };
}

interface AdReadForSwap {
  id: string;
  name: string;
  account_id?: string;
  creative?: CreativeReadFull;
}

/**
 * Swap the lead form on an ad by rebuilding its creative with a new form_id.
 *
 * Meta creatives are immutable, so we create-then-rebind:
 *  1. Read the ad's current creative (full spec — handles both legacy
 *     object_story_spec and modern asset_feed_spec creatives).
 *  2. POST /act_X/adcreatives with the same image/text spec but new
 *     lead_gen_form_id inside the SIGN_UP CTA.
 *  3. POST /{ad-id} with creative_id=<new> to rebind.
 *
 * The ad-id is unchanged. Meta may briefly re-review.
 */
export async function swapAdLeadForm(
  adId: string,
  newFormId: string,
  accessToken: string,
  dryRun: boolean,
  ctaTypeOverride?: string,
): Promise<SwapAdLeadFormResult> {
  const fields =
    'id,name,account_id,creative{' +
      'id,name,url_tags,object_story_id,effective_object_story_id,' +
      'object_story_spec{page_id,link_data{link,message,name,description,image_hash,call_to_action}},' +
      'asset_feed_spec{images,bodies,titles,descriptions,link_urls,call_to_action_types,call_to_actions,ad_formats}' +
    '}';
  const ad = await graphGet<AdReadForSwap>(adId, accessToken, { fields });

  const creative = ad.creative;
  if (!creative) throw new Error(`Ad ${adId}: no creative attached.`);
  if (!ad.account_id) throw new Error(`Ad ${adId}: response missing account_id.`);

  const previousFormId =
    creative.object_story_spec?.link_data?.call_to_action?.value?.lead_gen_form_id ??
    creative.asset_feed_spec?.call_to_actions?.[0]?.value?.lead_gen_form_id ??
    null;

  const existingCtaType =
    creative.object_story_spec?.link_data?.call_to_action?.type ??
    creative.asset_feed_spec?.call_to_actions?.[0]?.type ??
    null;
  const ctaType = ctaTypeOverride ?? existingCtaType ?? 'SIGN_UP';

  const isAssetFeed = !!creative.asset_feed_spec && (creative.asset_feed_spec.bodies?.length ?? 0) > 0;
  const mode: 'asset_feed_spec' | 'object_story_spec' = isAssetFeed ? 'asset_feed_spec' : 'object_story_spec';

  if (dryRun) {
    return {
      ad_id: ad.id,
      ad_name: ad.name,
      previous_creative_id: creative.id,
      new_creative_id: '',
      previous_form_id: previousFormId,
      new_form_id: newFormId,
      mode,
      changed: previousFormId !== newFormId,
    };
  }

  if (previousFormId === newFormId) {
    return {
      ad_id: ad.id,
      ad_name: ad.name,
      previous_creative_id: creative.id,
      new_creative_id: creative.id,
      previous_form_id: previousFormId,
      new_form_id: newFormId,
      mode,
      changed: false,
    };
  }

  const acct = ad.account_id.startsWith('act_') ? ad.account_id : `act_${ad.account_id}`;
  const newCta = { type: ctaType, value: { lead_gen_form_id: newFormId } };
  const body: Record<string, string> = {
    name: `${creative.name ?? ad.name} — form-swap ${new Date().toISOString().slice(0, 10)}`,
  };
  if (creative.url_tags) body.url_tags = creative.url_tags;

  if (isAssetFeed) {
    const afs = creative.asset_feed_spec!;
    const rebuilt: Record<string, unknown> = {
      images: afs.images ?? [],
      bodies: afs.bodies ?? [],
      link_urls: afs.link_urls ?? [],
      ad_formats: afs.ad_formats ?? ['SINGLE_IMAGE'],
      call_to_action_types: [ctaType],
      call_to_actions: [newCta],
    };
    if (afs.titles?.length) rebuilt.titles = afs.titles;
    if (afs.descriptions?.length) rebuilt.descriptions = afs.descriptions;

    const oss = creative.object_story_spec;
    const ossOut: Record<string, unknown> = { page_id: oss?.page_id };
    if (oss?.instagram_actor_id) ossOut.instagram_actor_id = oss.instagram_actor_id;

    body.object_story_spec = JSON.stringify(ossOut);
    body.asset_feed_spec = JSON.stringify(rebuilt);
  } else {
    const oss = creative.object_story_spec;
    const ld = oss?.link_data;
    if (!oss?.page_id || !ld?.link || !ld?.message) {
      throw new Error(
        `Ad ${adId} creative ${creative.id}: legacy creative missing page_id/link/message — cannot rebuild for form swap.`,
      );
    }
    const linkData: Record<string, unknown> = {
      link: ld.link,
      message: ld.message,
      call_to_action: newCta,
    };
    if (ld.image_hash) linkData.image_hash = ld.image_hash;
    if (ld.name) linkData.name = ld.name;
    if (ld.description) linkData.description = ld.description;

    const ossOut: Record<string, unknown> = { page_id: oss.page_id, link_data: linkData };
    if (oss.instagram_actor_id) ossOut.instagram_actor_id = oss.instagram_actor_id;
    body.object_story_spec = JSON.stringify(ossOut);
  }

  const created = await graphPost<CreativeCreateResponse>(`${acct}/adcreatives`, accessToken, body);
  await graphPost<AdUpdateResponse>(adId, accessToken, {
    creative: JSON.stringify({ creative_id: created.id }),
  });

  return {
    ad_id: ad.id,
    ad_name: ad.name,
    previous_creative_id: creative.id,
    new_creative_id: created.id,
    previous_form_id: previousFormId,
    new_form_id: newFormId,
    mode,
    changed: true,
  };
}

/* ------------------------------------------------------------------------- */
/* Rebind an ad to a different creative                                      */
/* ------------------------------------------------------------------------- */

export interface RebindAdCreativeResult {
  ad_id: string;
  ad_name: string;
  previous_creative_id: string;
  new_creative_id: string;
  changed: boolean;
}

/**
 * Rebind an ad to a different creative_id. Atomic. ad_id stays stable.
 * Use with createAdCreative to do full ad rebuilds (e.g. swap form + rebuild
 * text content) without touching the ad_id.
 */
export async function rebindAdCreative(
  adId: string,
  newCreativeId: string,
  accessToken: string,
  dryRun: boolean,
): Promise<RebindAdCreativeResult> {
  const before = await graphGet<{ id: string; name: string; creative?: { id: string } }>(
    adId,
    accessToken,
    { fields: 'id,name,creative{id}' },
  );
  const previousId = before.creative?.id ?? '';
  if (dryRun || previousId === newCreativeId) {
    return {
      ad_id: before.id,
      ad_name: before.name,
      previous_creative_id: previousId,
      new_creative_id: newCreativeId,
      changed: previousId !== newCreativeId && !dryRun,
    };
  }
  await graphPost<AdUpdateResponse>(adId, accessToken, {
    creative: JSON.stringify({ creative_id: newCreativeId }),
  });
  return {
    ad_id: before.id,
    ad_name: before.name,
    previous_creative_id: previousId,
    new_creative_id: newCreativeId,
    changed: true,
  };
}

/* ------------------------------------------------------------------------- */
/* Rename ad                                                                 */
/* ------------------------------------------------------------------------- */

export interface RenameAdResult {
  ad_id: string;
  previous_name: string;
  new_name: string;
  changed: boolean;
}

export async function renameAd(
  adId: string,
  newName: string,
  accessToken: string,
  dryRun: boolean,
): Promise<RenameAdResult> {
  const before = await graphGet<{ id: string; name: string }>(adId, accessToken, {
    fields: 'id,name',
  });
  if (dryRun || before.name === newName) {
    return {
      ad_id: before.id,
      previous_name: before.name,
      new_name: newName,
      changed: !dryRun ? false : before.name !== newName,
    };
  }
  await graphPost<AdUpdateResponse>(adId, accessToken, { name: newName });
  const after = await graphGet<{ id: string; name: string }>(adId, accessToken, {
    fields: 'id,name',
  });
  return {
    ad_id: after.id,
    previous_name: before.name,
    new_name: after.name,
    changed: before.name !== after.name,
  };
}
