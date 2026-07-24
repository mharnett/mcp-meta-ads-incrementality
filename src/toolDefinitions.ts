/**
 * Tool definitions (JSONSchema) for mcp-meta-ads-incrementality.
 *
 * Pure data — no side effects — so tests (writeGate.test.ts) can import the
 * full tool list without triggering the server entrypoint in index.ts
 * (credential resolution, SDK init, stdio transport).
 */

import { ALL_KNOWN_WINDOWS } from './lib/attribution.js';

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

const TOOL_RENAME_AD = {
  name: 'meta_ads_rename_ad',
  description:
    'Rename a Meta ad. Useful before applying url_tags with the {{ad.name}} macro — ad ' +
    'names with spaces produce literal spaces or %20 in the resulting URL. The new name is ' +
    'validated against shared naming standards (no spaces or URL-special characters); ' +
    'violations block the write unless allow_naming_violations=true. Pass dry_run=true ' +
    'to preview without writing.',
  inputSchema: {
    type: 'object',
    properties: {
      ad_id: { type: 'string', description: 'Meta ad id (numeric).' },
      new_name: { type: 'string', description: 'New ad name.' },
      dry_run: {
        type: 'boolean',
        description: 'If true, return a diff without writing. Default false.',
      },
      allow_naming_violations: {
        type: 'boolean',
        description: 'If true, bypass the naming-standards check. Default false.',
      },
    },
    required: ['ad_id', 'new_name'],
  },
} as const;

/* ------------------------------------------------------------------------- */
/* Tier 1 — campaign / ad set / creative / ad / image                        */
/* ------------------------------------------------------------------------- */

const TOOL_CREATE_CAMPAIGN = {
  name: 'meta_ads_create_campaign',
  description:
    'Create a Meta ad campaign. Defaults to PAUSED status so the MCP cannot accidentally take ' +
    'spend live. Set buying_type=AUCTION (default) for the standard auction model. CBO callers ' +
    'pass daily_budget at the campaign level; ABO callers omit it and budget at the ad set level.',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'Ad account id (with or without act_ prefix).' },
      name: { type: 'string' },
      objective: {
        type: 'string',
        description: 'Meta objective enum, e.g. OUTCOME_LEADS, OUTCOME_TRAFFIC, OUTCOME_SALES.',
      },
      status: { type: 'string', enum: ['PAUSED', 'ACTIVE'], description: 'Default PAUSED.' },
      special_ad_categories: {
        type: 'array',
        items: { type: 'string' },
        description: 'e.g. ["HOUSING"]. Default [].',
      },
      buying_type: { type: 'string', enum: ['AUCTION', 'RESERVED'], description: 'Default AUCTION.' },
      daily_budget: { type: 'number', description: 'Cents. Set only for CBO campaigns.' },
      lifetime_budget: { type: 'number', description: 'Cents. Alternative to daily_budget.' },
    },
    required: ['account_id', 'name', 'objective'],
  },
} as const;

const TOOL_CREATE_ADSET = {
  name: 'meta_ads_create_adset',
  description:
    'Create a Meta ad set inside an existing campaign. Defaults to PAUSED. For ON_AD lead-gen ' +
    'ad sets, pass destination_type="ON_AD" and promoted_object={page_id}. For OFFSITE ' +
    'conversions, promoted_object={page_id, pixel_id, custom_event_type}. Pass is_incremental_' +
    'attribution_enabled=true to switch to Meta\'s Incremental Conversions optimization (per ' +
    'agency guidance). Budget required: daily_budget OR lifetime_budget (not both, not neither ' +
    'unless inheriting from a CBO campaign).',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string' },
      campaign_id: { type: 'string' },
      name: { type: 'string' },
      optimization_goal: {
        type: 'string',
        description: 'e.g. LEAD_GENERATION, OFFSITE_CONVERSIONS, LINK_CLICKS, REACH.',
      },
      billing_event: {
        type: 'string',
        enum: ['IMPRESSIONS', 'LINK_CLICKS', 'POST_ENGAGEMENT', 'THRUPLAY'],
      },
      bid_strategy: {
        type: 'string',
        enum: ['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'],
        description: 'Default LOWEST_COST_WITHOUT_CAP (Highest volume).',
      },
      bid_amount: { type: 'number', description: 'Cents. Required for COST_CAP / WITH_BID_CAP.' },
      targeting: { type: 'object', description: 'Full Meta targeting spec.' },
      status: { type: 'string', enum: ['PAUSED', 'ACTIVE'] },
      daily_budget: { type: 'number', description: 'Cents.' },
      lifetime_budget: { type: 'number', description: 'Cents.' },
      promoted_object: { type: 'object' },
      destination_type: { type: 'string', description: 'e.g. ON_AD, WEBSITE, APP, MESSENGER.' },
      attribution_spec: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            event_type: { type: 'string' },
            window_days: { type: 'number' },
          },
          required: ['event_type', 'window_days'],
        },
      },
      is_incremental_attribution_enabled: { type: 'boolean' },
      start_time: { type: 'string' },
      end_time: { type: 'string' },
    },
    required: ['account_id', 'campaign_id', 'name', 'optimization_goal', 'billing_event', 'targeting'],
  },
} as const;

const TOOL_CREATE_AD_CREATIVE = {
  name: 'meta_ads_create_ad_creative',
  description:
    'Create a Meta ad creative (single image). Two modes: (1) legacy object_story_spec ' +
    'when message/headline/description are single strings; (2) asset_feed_spec / Flexible Ads ' +
    'when any of messages[]/headlines[]/descriptions[] has >1 entry — Meta then mix-and-matches ' +
    'variants per impression (cap 5 each). Pass lead_gen_form_id to auto-wire the SIGN_UP CTA. ' +
    'Pair with meta_ads_upload_image to get an image_hash.',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string' },
      name: { type: 'string' },
      page_id: { type: 'string' },
      image_hash: { type: 'string', description: 'From meta_ads_upload_image. Required for both single and asset_feed_spec modes.' },
      link: { type: 'string', description: 'Clickthrough URL.' },
      message: { type: 'string', description: 'Single primary text. Mutually exclusive with messages[].' },
      messages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 primary text variants. Triggers asset_feed_spec mode if >1.',
      },
      headline: { type: 'string', description: 'Single headline below the image.' },
      headlines: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 headline variants. Triggers asset_feed_spec mode if >1.',
      },
      description: { type: 'string', description: 'Single sub-description.' },
      descriptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 description variants. Triggers asset_feed_spec mode if >1.',
      },
      call_to_action: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'e.g. SIGN_UP, DOWNLOAD, LEARN_MORE, SHOP_NOW.' },
          value: {
            type: 'object',
            properties: {
              link: { type: 'string' },
              lead_gen_form_id: { type: 'string' },
            },
          },
        },
        required: ['type'],
      },
      lead_gen_form_id: {
        type: 'string',
        description: 'Shortcut: builds CTA={type:SIGN_UP, value:{lead_gen_form_id}}.',
      },
      url_tags: {
        type: 'string',
        description: 'Query-string fragment for tracking, no leading ?. Use {{ad.name}} macros.',
      },
      instagram_actor_id: {
        type: 'string',
        description: 'Optional IG business account for cross-posting.',
      },
    },
    required: ['account_id', 'name', 'page_id', 'link'],
  },
} as const;

const TOOL_CREATE_AD = {
  name: 'meta_ads_create_ad',
  description:
    'Create a Meta ad attached to an ad set and creative. Defaults to PAUSED.',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string' },
      name: { type: 'string' },
      adset_id: { type: 'string' },
      creative_id: { type: 'string' },
      status: { type: 'string', enum: ['PAUSED', 'ACTIVE'] },
    },
    required: ['account_id', 'name', 'adset_id', 'creative_id'],
  },
} as const;

const TOOL_UPLOAD_IMAGE = {
  name: 'meta_ads_upload_image',
  description:
    'Upload an image to an ad account and return its image_hash + CDN URL. Pass either ' +
    'image_bytes (base64-encoded) or image_path (local file path; this MCP reads + encodes it).',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string' },
      image_bytes: { type: 'string', description: 'Base64-encoded image data.' },
      image_path: { type: 'string', description: 'Local file path to read.' },
    },
    required: ['account_id'],
  },
} as const;

/* ------------------------------------------------------------------------- */
/* Tier 2 — audiences + lead forms                                            */
/* ------------------------------------------------------------------------- */

const TOOL_CREATE_LEADGEN_FORM = {
  name: 'meta_ads_create_leadgen_form',
  description:
    'Create a Meta lead-gen Instant Form on a Facebook Page. Requires Page-scoped permissions on ' +
    'the access token; calls that fail with Graph error code 3 ("Application does not have the ' +
    'capability to make this API call") indicate the app lacks Lead Ads management capability ' +
    'and need an App Review fix, not a client-code change. Also requires the Page to have ' +
    'accepted Facebook\'s Lead Generation Terms of Service (Page Settings → Lead Ads Terms) — ' +
    'fails with subcode 1815089 if not.',
  inputSchema: {
    type: 'object',
    properties: {
      page_id: { type: 'string' },
      name: { type: 'string' },
      locale: { type: 'string', description: 'Default en_US.' },
      form_type: { type: 'string', enum: ['MORE_VOLUME', 'HIGHER_INTENT'] },
      block_display_for_non_targeted_viewer: { type: 'boolean' },
      privacy_policy: {
        type: 'object',
        properties: { url: { type: 'string' }, link_text: { type: 'string' } },
        required: ['url'],
      },
      context_card: {
        type: 'object',
        properties: {
          style: { type: 'string', enum: ['PARAGRAPH_STYLE', 'LIST_STYLE'] },
          title: { type: 'string' },
          content: { type: 'array', items: { type: 'string' } },
          button_text: { type: 'string' },
        },
        required: ['style', 'title', 'content'],
      },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            key: { type: 'string' },
            label: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: { value: { type: 'string' }, key: { type: 'string' } },
                required: ['value', 'key'],
              },
            },
          },
          required: ['type'],
        },
      },
      thank_you_page: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          button_text: { type: 'string' },
          button_type: { type: 'string', enum: ['VIEW_WEBSITE', 'CALL_BUSINESS', 'MESSAGE_BUSINESS'] },
          website_url: { type: 'string' },
        },
        required: ['title', 'body', 'button_text', 'button_type'],
      },
      follow_up_action_url: { type: 'string' },
    },
    required: ['page_id', 'name', 'privacy_policy', 'questions', 'thank_you_page'],
  },
} as const;

const TOOL_CREATE_CUSTOM_AUDIENCE = {
  name: 'meta_ads_create_custom_audience',
  description:
    'Create an empty Custom Audience on an ad account, ready to receive records via ' +
    'meta_ads_upload_users_to_audience. Returns audience_id. Not usable in ad sets until at ' +
    'least one user batch is uploaded and processed.',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string' },
      name: { type: 'string' },
      description: { type: 'string' },
      customer_file_source: {
        type: 'string',
        enum: ['USER_PROVIDED_ONLY', 'PARTNER_PROVIDED_ONLY', 'BOTH_USER_AND_PARTNER_PROVIDED'],
      },
    },
    required: ['account_id', 'name'],
  },
} as const;

const TOOL_UPLOAD_USERS_TO_AUDIENCE = {
  name: 'meta_ads_upload_users_to_audience',
  description:
    'Upload user records to a Custom Audience. Records are SHA-256 hashed locally before send ' +
    '(emails lowercased+trimmed; phones stripped to digits; names normalized to alphanumeric) — ' +
    'pass plaintext, do not pre-hash. Schema is inferred from the first record (EMAIL or PHONE) ' +
    'if not specified. Returns num_received and num_invalid_entries.',
  inputSchema: {
    type: 'object',
    properties: {
      audience_id: { type: 'string' },
      users: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            phone: { type: 'string' },
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            country: { type: 'string' },
            zip: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
          },
        },
      },
      schema: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['EMAIL', 'PHONE', 'FN', 'LN', 'COUNTRY', 'ZIP', 'CT', 'ST', 'DOBY', 'GEN', 'MADID'],
        },
      },
      session_id: { type: 'number' },
      batch_size: { type: 'number', description: 'Default 1000, max 10000.' },
    },
    required: ['audience_id', 'users'],
  },
} as const;

const TOOL_CREATE_LOOKALIKE_AUDIENCE = {
  name: 'meta_ads_create_lookalike_audience',
  description:
    'Create a Lookalike Audience seeded by an existing Custom Audience. Ratio is a fraction of ' +
    'country population (0.01 = top 1%, highest similarity / smallest reach; 0.10 = broader). ' +
    'Default 0.01. Range 0.01–0.20.',
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string' },
      name: { type: 'string' },
      origin_audience_id: { type: 'string' },
      country: { type: 'string', description: 'ISO 3166-1 alpha-2.' },
      ratio: { type: 'number' },
      description: { type: 'string' },
    },
    required: ['account_id', 'name', 'origin_audience_id', 'country'],
  },
} as const;

/* ------------------------------------------------------------------------- */
/* Tier 3 + 4 — lifecycle                                                     */
/* ------------------------------------------------------------------------- */

const TOOL_UPDATE_OBJECT_STATUS = {
  name: 'meta_ads_update_object_status',
  description:
    'Toggle the status of a campaign, ad set, or ad. Pass object_id of any of those types. ' +
    'PAUSED stops spend; ACTIVE resumes; ARCHIVED removes from active views without deleting.',
  inputSchema: {
    type: 'object',
    properties: {
      object_id: { type: 'string', description: 'Campaign, ad set, or ad id.' },
      status: { type: 'string', enum: ['PAUSED', 'ACTIVE', 'ARCHIVED'] },
    },
    required: ['object_id', 'status'],
  },
} as const;

const TOOL_UPDATE_BUDGET = {
  name: 'meta_ads_update_budget',
  description:
    'Update the daily or lifetime budget on a campaign or ad set. Pass exactly one of ' +
    'daily_budget or lifetime_budget (in cents). For CBO campaigns, set on the campaign; for ' +
    'ABO ad sets, set on each ad set.',
  inputSchema: {
    type: 'object',
    properties: {
      object_id: { type: 'string', description: 'Campaign or ad set id.' },
      daily_budget: { type: 'number', description: 'Cents.' },
      lifetime_budget: { type: 'number', description: 'Cents.' },
    },
    required: ['object_id'],
  },
} as const;

const TOOL_DELETE_OBJECT = {
  name: 'meta_ads_delete_object',
  description:
    'Permanently delete a Meta object (campaign, ad set, ad, creative, custom audience). ' +
    'Irreversible — prefer meta_ads_update_object_status with status=ARCHIVED unless you truly ' +
    'want to remove the object and its history.',
  inputSchema: {
    type: 'object',
    properties: { object_id: { type: 'string' } },
    required: ['object_id'],
  },
} as const;

const TOOL_SWAP_AD_LEAD_FORM = {
  name: 'meta_ads_swap_ad_lead_form',
  description:
    'Swap the lead form on an existing Meta ad by rebuilding its creative with a new ' +
    'lead_gen_form_id, then rebinding the ad. Ad_id stays stable. Handles both legacy ' +
    'object_story_spec creatives and modern asset_feed_spec (Flexible Ads) creatives — ' +
    'preserves all image/text content, only the SIGN_UP CTA form_id changes. Pass dry_run=true ' +
    'to preview. Meta may briefly re-review the ad after the swap.',
  inputSchema: {
    type: 'object',
    properties: {
      ad_id: { type: 'string', description: 'Meta ad id (numeric).' },
      new_form_id: { type: 'string', description: 'New lead_gen_form_id to bind.' },
      cta_type: {
        type: 'string',
        description:
          'Override the CTA button type (e.g. DOWNLOAD, SIGN_UP, LEARN_MORE, GET_OFFER). ' +
          'If omitted, preserves the existing CTA type from the ad\'s current creative.',
      },
      dry_run: { type: 'boolean', description: 'If true, return a diff without writing. Default false.' },
    },
    required: ['ad_id', 'new_form_id'],
  },
} as const;

const TOOL_REBIND_AD_CREATIVE = {
  name: 'meta_ads_rebind_ad_creative',
  description:
    'Rebind an ad to a different creative_id. ad_id stays stable. Use together with ' +
    'meta_ads_create_ad_creative to do full ad rebuilds (e.g. swap form + rebuild text content) ' +
    'without losing performance history on the ad object. SAFETY: refuses to rebind when the ' +
    'old creative has asset_customization_rules (per-placement image rules) and the new one ' +
    'does not — pass force=true to override. Pass dry_run=true to preview.',
  inputSchema: {
    type: 'object',
    properties: {
      ad_id: { type: 'string', description: 'Meta ad id (numeric).' },
      creative_id: { type: 'string', description: 'New creative_id to bind to the ad.' },
      dry_run: { type: 'boolean', description: 'If true, return a diff without writing. Default false.' },
      force: {
        type: 'boolean',
        description: 'Bypass the asset_customization_rules safety check. Use only when intentionally replacing per-placement image rules.',
      },
    },
    required: ['ad_id', 'creative_id'],
  },
} as const;

const TOOL_EDIT_CREATIVE_TEXT = {
  name: 'meta_ads_edit_creative_text',
  description:
    'Edit the text fields (messages/headlines/descriptions) on an ad\'s creative while ' +
    'PRESERVING images, videos, asset_customization_rules (per-placement image rules set ' +
    'in Ads Manager UI), CTAs, and link_urls. Use this instead of create_ad_creative + ' +
    'rebind_ad_creative when the ad has custom placements-by-image — the create+rebind ' +
    'pattern silently flattens those rules. Refuses if asset_customization_rules reference ' +
    'per-text labels (body_label/title_label/description_label) and the new text count ' +
    'differs from the existing count — pass force=true to override. Multi-variant ads ' +
    '(asset_feed_spec) accept up to 5 entries per field; legacy single-variant ads ' +
    '(object_story_spec) accept ≤1 entry per field.',
  inputSchema: {
    type: 'object',
    properties: {
      ad_id: { type: 'string', description: 'Meta ad id (numeric).' },
      messages: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 primary text variants. Replaces the entire bodies[] array.',
      },
      headlines: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 headline variants. Replaces the entire titles[] array.',
      },
      descriptions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Up to 5 description variants. Replaces the entire descriptions[] array.',
      },
      dry_run: { type: 'boolean', description: 'If true, return a diff without writing.' },
      force: {
        type: 'boolean',
        description: 'Bypass the label-orphaning safety check (only for DCO-style ads with labeled text).',
      },
    },
    required: ['ad_id'],
  },
} as const;

export const TOOLS = [
  TOOL_INSIGHTS_INCREMENTALITY,
  TOOL_LIST_ADS_IN_CAMPAIGN,
  TOOL_GET_AD_URL_TAGS,
  TOOL_UPDATE_AD_URL_TAGS,
  TOOL_RENAME_AD,
  TOOL_SWAP_AD_LEAD_FORM,
  TOOL_REBIND_AD_CREATIVE,
  TOOL_EDIT_CREATIVE_TEXT,
  TOOL_CREATE_CAMPAIGN,
  TOOL_CREATE_ADSET,
  TOOL_CREATE_AD_CREATIVE,
  TOOL_CREATE_AD,
  TOOL_UPLOAD_IMAGE,
  TOOL_CREATE_LEADGEN_FORM,
  TOOL_CREATE_CUSTOM_AUDIENCE,
  TOOL_UPLOAD_USERS_TO_AUDIENCE,
  TOOL_CREATE_LOOKALIKE_AUDIENCE,
  TOOL_UPDATE_OBJECT_STATUS,
  TOOL_UPDATE_BUDGET,
  TOOL_DELETE_OBJECT,
];
