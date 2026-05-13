/**
 * Tier 3 + 4 lifecycle tools: status toggle, budget update, delete.
 *
 * Meta uses the same POST /{id} endpoint for any object (campaign, ad set, ad)
 * with `status` or budget fields, and DELETE /{id} for removal. This module
 * exposes one tool per concern; callers pass an object_id of any type.
 */
import { graphDelete, graphPost } from '../lib/graph.js';

export type ObjectStatus = 'PAUSED' | 'ACTIVE' | 'ARCHIVED' | 'DELETED';

/* ------------------------------------------------------------------------- */
/* updateObjectStatus                                                          */
/* ------------------------------------------------------------------------- */

export interface UpdateObjectStatusInput {
  object_id: string;
  status: ObjectStatus;
}

export interface UpdateObjectStatusResult {
  object_id: string;
  status: ObjectStatus;
  success: boolean;
}

interface GraphSuccessResponse {
  success?: boolean;
  id?: string;
}

export async function updateObjectStatus(
  input: UpdateObjectStatusInput,
  accessToken: string,
): Promise<UpdateObjectStatusResult> {
  const res = await graphPost<GraphSuccessResponse>(input.object_id, accessToken, {
    status: input.status,
  });
  return {
    object_id: input.object_id,
    status: input.status,
    success: res.success ?? false,
  };
}

/* ------------------------------------------------------------------------- */
/* updateBudget                                                                */
/* ------------------------------------------------------------------------- */

export interface UpdateBudgetInput {
  object_id: string;
  daily_budget?: number;
  lifetime_budget?: number;
}

export interface UpdateBudgetResult {
  object_id: string;
  daily_budget: number | null;
  lifetime_budget: number | null;
  success: boolean;
}

export async function updateBudget(
  input: UpdateBudgetInput,
  accessToken: string,
): Promise<UpdateBudgetResult> {
  if (input.daily_budget === undefined && input.lifetime_budget === undefined) {
    throw new Error('updateBudget: pass daily_budget or lifetime_budget.');
  }
  if (input.daily_budget !== undefined && input.lifetime_budget !== undefined) {
    throw new Error('updateBudget: pass daily_budget OR lifetime_budget, not both.');
  }

  const body: Record<string, string> = {};
  if (input.daily_budget !== undefined) body.daily_budget = String(input.daily_budget);
  if (input.lifetime_budget !== undefined) body.lifetime_budget = String(input.lifetime_budget);

  const res = await graphPost<GraphSuccessResponse>(input.object_id, accessToken, body);
  return {
    object_id: input.object_id,
    daily_budget: input.daily_budget ?? null,
    lifetime_budget: input.lifetime_budget ?? null,
    success: res.success ?? false,
  };
}

/* ------------------------------------------------------------------------- */
/* deleteObject                                                                */
/* ------------------------------------------------------------------------- */

export interface DeleteObjectInput {
  object_id: string;
}

export interface DeleteObjectResult {
  object_id: string;
  success: boolean;
}

export async function deleteObject(
  input: DeleteObjectInput,
  accessToken: string,
): Promise<DeleteObjectResult> {
  const res = await graphDelete<GraphSuccessResponse>(input.object_id, accessToken);
  return { object_id: input.object_id, success: res.success ?? false };
}
