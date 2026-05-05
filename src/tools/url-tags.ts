/**
 * URL-tags tools — read and update the `url_tags` query-string fragment that
 * Meta appends to ad clickthrough URLs.
 *
 * Why a thin Graph-API client instead of the SDK: the SDK adapter in this repo
 * is shaped around insights cursors. URL-tags reads/writes are simple REST
 * calls, so we hit the Graph API directly via fetch.
 *
 * Update strategy: `POST /{ad-id}` with `creative={"creative_id":<existing>,
 * "url_tags":"..."}`. Meta interprets this as a creative-spec override and
 * forks a new creative under the hood while keeping the ad-id stable. This
 * avoids the manual create-creative-then-rebind dance and (per Meta docs)
 * does not reset learning the way a full creative swap would.
 */
const GRAPH_VERSION = 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

async function graphGet<T>(path: string, accessToken: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', accessToken);
  const res = await fetch(url.toString());
  const body = await res.json() as T & GraphErrorBody;
  if (!res.ok || body.error) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Meta Graph GET ${path} failed: ${msg}`);
  }
  return body;
}

async function graphPost<T>(path: string, accessToken: string, body: Record<string, string>): Promise<T> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.set(k, v);
  form.set('access_token', accessToken);
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const json = await res.json() as T & GraphErrorBody;
  if (!res.ok || json.error) {
    const msg = json.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Meta Graph POST ${path} failed: ${msg}`);
  }
  return json;
}

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

export interface AdUrlTagsInfo {
  ad_id: string;
  ad_name: string;
  campaign_id: string;
  campaign_name: string;
  creative_id: string;
  url_tags: string | null;
  link: string | null;
}

interface AdReadResponse {
  id: string;
  name: string;
  campaign_id: string;
  campaign?: { id: string; name: string };
  creative?: {
    id: string;
    url_tags?: string;
    object_story_spec?: {
      link_data?: { link?: string };
      video_data?: { call_to_action?: { value?: { link?: string } } };
    };
  };
}

export async function getAdUrlTags(adId: string, accessToken: string): Promise<AdUrlTagsInfo> {
  const ad = await graphGet<AdReadResponse>(adId, accessToken, {
    fields: 'id,name,campaign_id,campaign{id,name},creative{id,url_tags,object_story_spec{link_data{link},video_data{call_to_action}}}',
  });
  const link =
    ad.creative?.object_story_spec?.link_data?.link ??
    ad.creative?.object_story_spec?.video_data?.call_to_action?.value?.link ??
    null;
  return {
    ad_id: ad.id,
    ad_name: ad.name,
    campaign_id: ad.campaign_id,
    campaign_name: ad.campaign?.name ?? '',
    creative_id: ad.creative?.id ?? '',
    url_tags: ad.creative?.url_tags ?? null,
    link,
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
}

interface AdUpdateResponse {
  success?: boolean;
  id?: string;
}

/**
 * Update the `url_tags` on an ad. Path:
 *   1. Read current creative_id and url_tags (so we can return a diff).
 *   2. POST /{ad-id} with creative override (creative_id + url_tags). Meta
 *      forks a new creative spec; the ad-id is unchanged.
 *   3. Re-read the ad to surface the new creative_id for confirmation.
 *
 * If `dry_run` is true, only step 1 runs and the returned `new_creative_id`
 * is empty.
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
    };
  }

  const creativeOverride = JSON.stringify({
    creative_id: before.creative_id,
    url_tags: newUrlTags,
  });
  await graphPost<AdUpdateResponse>(adId, accessToken, { creative: creativeOverride });

  const after = await getAdUrlTags(adId, accessToken);
  return {
    ad_id: after.ad_id,
    ad_name: after.ad_name,
    previous_url_tags: before.url_tags,
    new_url_tags: after.url_tags ?? newUrlTags,
    previous_creative_id: before.creative_id,
    new_creative_id: after.creative_id,
    changed: before.creative_id !== after.creative_id || before.url_tags !== after.url_tags,
  };
}
