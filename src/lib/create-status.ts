/**
 * Create tools never start delivery. A new campaign, ad set or ad is created
 * PAUSED (staging) and enabled separately, after review, with ENABLE_TOOL.
 */
export const ENABLE_TOOL = 'meta_ads_update_object_status';

/**
 * Return the status a create tool must send: always 'PAUSED'.
 *
 * `undefined` defaults to PAUSED and 'paused' is accepted in any case. Any
 * other value throws before the caller makes a Graph request.
 */
export function pausedCreateStatus(toolName: string, status: unknown): 'PAUSED' {
  if (status === undefined) return 'PAUSED';
  if (typeof status === 'string' && status.trim().toUpperCase() === 'PAUSED') return 'PAUSED';
  throw new Error(
    `${toolName} creates objects PAUSED only (got status=${JSON.stringify(status)}). ` +
      `Create it PAUSED (the default), then enable it separately with ${ENABLE_TOOL}.`,
  );
}
