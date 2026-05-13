/**
 * Tier 2 write tools: lead-form creation and audience management.
 *
 * Lead-form creation requires Page-scoped permissions on the access token. A
 * token whose app lacks Lead Ads management capability fails with Graph error
 * code 3 ("Application does not have the capability to make this API call").
 * That is an app-level gate; client code cannot bypass it.
 *
 * Customer-list audience uploads are SHA-256 hashed locally before send, per
 * Meta's contract. Hashing happens here — callers pass plaintext.
 */
import { createHash } from 'node:crypto';
import { graphPost } from '../lib/graph.js';

/* ------------------------------------------------------------------------- */
/* createLeadgenForm                                                          */
/* ------------------------------------------------------------------------- */

export type LeadFormType = 'MORE_VOLUME' | 'HIGHER_INTENT';

export interface LeadFormQuestionOption {
  value: string;
  key: string;
}

export interface LeadFormQuestion {
  type: string;
  key?: string;
  label?: string;
  options?: LeadFormQuestionOption[];
}

export interface LeadFormContextCard {
  style: 'PARAGRAPH_STYLE' | 'LIST_STYLE';
  title: string;
  content: string[];
  button_text?: string;
}

export interface LeadFormThankYouPage {
  title: string;
  body: string;
  button_text: string;
  button_type: 'VIEW_WEBSITE' | 'CALL_BUSINESS' | 'MESSAGE_BUSINESS';
  website_url?: string;
}

export interface LeadFormPrivacyPolicy {
  url: string;
  link_text?: string;
}

export interface CreateLeadgenFormInput {
  page_id: string;
  name: string;
  locale?: string;
  form_type?: LeadFormType;
  block_display_for_non_targeted_viewer?: boolean;
  privacy_policy: LeadFormPrivacyPolicy;
  context_card?: LeadFormContextCard;
  questions: LeadFormQuestion[];
  thank_you_page: LeadFormThankYouPage;
  follow_up_action_url?: string;
}

export interface CreateLeadgenFormResult {
  form_id: string;
  page_id: string;
  name: string;
}

export async function createLeadgenForm(
  input: CreateLeadgenFormInput,
  accessToken: string,
): Promise<CreateLeadgenFormResult> {
  const body: Record<string, string> = {
    name: input.name,
    locale: input.locale ?? 'en_US',
    form_type: input.form_type ?? 'MORE_VOLUME',
    block_display_for_non_targeted_viewer: String(
      input.block_display_for_non_targeted_viewer ?? false,
    ),
    privacy_policy: JSON.stringify(input.privacy_policy),
    questions: JSON.stringify(input.questions),
    thank_you_page: JSON.stringify(input.thank_you_page),
  };
  if (input.context_card) body.context_card = JSON.stringify(input.context_card);
  if (input.follow_up_action_url) body.follow_up_action_url = input.follow_up_action_url;

  const res = await graphPost<{ id: string }>(
    `${input.page_id}/leadgen_forms`,
    accessToken,
    body,
  );
  return { form_id: res.id, page_id: input.page_id, name: input.name };
}

/* ------------------------------------------------------------------------- */
/* createCustomAudience                                                       */
/* ------------------------------------------------------------------------- */

export interface CreateCustomAudienceInput {
  account_id: string;
  name: string;
  description?: string;
  customer_file_source?:
    | 'USER_PROVIDED_ONLY'
    | 'PARTNER_PROVIDED_ONLY'
    | 'BOTH_USER_AND_PARTNER_PROVIDED';
}

export interface CreateCustomAudienceResult {
  audience_id: string;
  account_id: string;
  name: string;
}

function normalizeAccountId(accountId: string): string {
  return accountId.startsWith('act_') ? accountId : `act_${accountId}`;
}

export async function createCustomAudience(
  input: CreateCustomAudienceInput,
  accessToken: string,
): Promise<CreateCustomAudienceResult> {
  const account = normalizeAccountId(input.account_id);
  const body: Record<string, string> = {
    name: input.name,
    subtype: 'CUSTOM',
    customer_file_source: input.customer_file_source ?? 'USER_PROVIDED_ONLY',
  };
  if (input.description) body.description = input.description;

  const res = await graphPost<{ id: string }>(`${account}/customaudiences`, accessToken, body);
  return { audience_id: res.id, account_id: account, name: input.name };
}

/* ------------------------------------------------------------------------- */
/* uploadUsersToAudience                                                      */
/* ------------------------------------------------------------------------- */

export type AudienceSchemaField =
  | 'EMAIL' | 'PHONE' | 'FN' | 'LN' | 'COUNTRY' | 'ZIP' | 'CT' | 'ST'
  | 'DOBY' | 'GEN' | 'MADID';

export interface AudienceUser {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  country?: string;
  zip?: string;
  city?: string;
  state?: string;
}

export interface UploadUsersToAudienceInput {
  audience_id: string;
  users: AudienceUser[];
  schema?: AudienceSchemaField[];
  session_id?: number;
  batch_size?: number;
}

export interface UploadUsersToAudienceResult {
  audience_id: string;
  schema: AudienceSchemaField[];
  records_sent: number;
  batches: number;
  invalid_entry_samples: string[];
  num_received: number;
  num_invalid_entries: number;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function normalizeField(field: AudienceSchemaField, value: string): string {
  switch (field) {
    case 'EMAIL':
      return value.toLowerCase().trim();
    case 'PHONE':
      return value.replace(/\D/g, '');
    case 'FN':
    case 'LN':
    case 'CT':
    case 'ST':
    case 'COUNTRY':
      return value.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    case 'ZIP':
      return (value.toLowerCase().trim().split('-')[0] ?? '');
    default:
      return value.toLowerCase().trim();
  }
}

function userField(user: AudienceUser, field: AudienceSchemaField): string | undefined {
  switch (field) {
    case 'EMAIL': return user.email;
    case 'PHONE': return user.phone;
    case 'FN': return user.first_name;
    case 'LN': return user.last_name;
    case 'CT': return user.city;
    case 'ST': return user.state;
    case 'COUNTRY': return user.country;
    case 'ZIP': return user.zip;
    default: return undefined;
  }
}

function userToRow(user: AudienceUser, schema: AudienceSchemaField[]): string[] {
  return schema.map((field) => {
    const raw = userField(user, field);
    if (!raw) return '';
    return sha256(normalizeField(field, raw));
  });
}

function inferSchema(users: AudienceUser[]): AudienceSchemaField[] {
  const first = users[0];
  if (!first) return ['EMAIL'];
  if (first.email) return ['EMAIL'];
  if (first.phone) return ['PHONE'];
  throw new Error(
    'Could not infer schema: first user has neither email nor phone. Pass schema explicitly.',
  );
}

interface UsersResponse {
  audience_id?: string;
  session_id?: number;
  num_received?: number;
  num_invalid_entries?: number;
  invalid_entry_samples?: string[];
}

export async function uploadUsersToAudience(
  input: UploadUsersToAudienceInput,
  accessToken: string,
): Promise<UploadUsersToAudienceResult> {
  if (input.users.length === 0) {
    throw new Error('uploadUsersToAudience: users array is empty.');
  }
  const schema = input.schema ?? inferSchema(input.users);
  const batchSize = Math.min(Math.max(input.batch_size ?? 1000, 1), 10000);

  let totalReceived = 0;
  let totalInvalid = 0;
  const invalidSamples: string[] = [];
  let batchCount = 0;

  for (let offset = 0; offset < input.users.length; offset += batchSize) {
    const slice = input.users.slice(offset, offset + batchSize);
    const data = slice.map((u) => userToRow(u, schema));
    const payload = { schema, data };
    const res = await graphPost<UsersResponse>(
      `${input.audience_id}/users`,
      accessToken,
      {
        payload: JSON.stringify(payload),
        session_id: String(input.session_id ?? 0),
      },
    );
    batchCount += 1;
    if (typeof res.num_received === 'number') totalReceived += res.num_received;
    if (typeof res.num_invalid_entries === 'number') totalInvalid += res.num_invalid_entries;
    if (Array.isArray(res.invalid_entry_samples)) {
      for (const s of res.invalid_entry_samples) {
        if (invalidSamples.length < 5) invalidSamples.push(s);
      }
    }
  }

  return {
    audience_id: input.audience_id,
    schema,
    records_sent: input.users.length,
    batches: batchCount,
    invalid_entry_samples: invalidSamples,
    num_received: totalReceived,
    num_invalid_entries: totalInvalid,
  };
}

/* ------------------------------------------------------------------------- */
/* createLookalikeAudience                                                    */
/* ------------------------------------------------------------------------- */

export interface CreateLookalikeAudienceInput {
  account_id: string;
  name: string;
  origin_audience_id: string;
  country: string;
  ratio?: number;
  description?: string;
}

export interface CreateLookalikeAudienceResult {
  audience_id: string;
  account_id: string;
  name: string;
  origin_audience_id: string;
  country: string;
  ratio: number;
}

export async function createLookalikeAudience(
  input: CreateLookalikeAudienceInput,
  accessToken: string,
): Promise<CreateLookalikeAudienceResult> {
  const account = normalizeAccountId(input.account_id);
  const ratio = input.ratio ?? 0.01;
  if (ratio < 0.01 || ratio > 0.2) {
    throw new Error(`createLookalikeAudience: ratio ${ratio} out of range [0.01, 0.20].`);
  }
  const lookalikeSpec = { type: 'similarity', ratio, country: input.country };
  const body: Record<string, string> = {
    name: input.name,
    subtype: 'LOOKALIKE',
    origin_audience_id: input.origin_audience_id,
    lookalike_spec: JSON.stringify(lookalikeSpec),
  };
  if (input.description) body.description = input.description;

  const res = await graphPost<{ id: string }>(`${account}/customaudiences`, accessToken, body);
  return {
    audience_id: res.id,
    account_id: account,
    name: input.name,
    origin_audience_id: input.origin_audience_id,
    country: input.country,
    ratio,
  };
}
