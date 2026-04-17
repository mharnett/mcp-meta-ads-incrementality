/**
 * Truncate oversized API responses to stay within MCP transport limits.
 * Repeatedly halves the largest array until the JSON fits under MAX_SIZE.
 */

const MAX_RESPONSE_SIZE = 200_000; // 200KB

export function safeResponse<T>(data: T, context: string): T {
  let current = data;
  for (let pass = 0; pass < 10; pass++) {
    const jsonStr = JSON.stringify(current);
    const sizeBytes = Buffer.byteLength(jsonStr, "utf-8");
    if (sizeBytes <= MAX_RESPONSE_SIZE) return current;

    if (pass === 0 && typeof current === "object" && current !== null) {
      current = JSON.parse(JSON.stringify(current)) as T;
    }

    process.stderr.write(
      `[warning] Response exceeds ${MAX_RESPONSE_SIZE}B (${sizeBytes}B), truncating (pass ${pass})\n`,
    );

    if (Array.isArray(current)) {
      current = (current as any[]).slice(0, Math.max(1, Math.floor((current as any[]).length * 0.5))) as T;
      continue;
    }

    if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, any>;
      let truncated = false;
      for (const key of ["items", "results", "data", "rows", "campaigns", "insights"]) {
        if (Array.isArray(obj[key]) && obj[key].length > 1) {
          obj[key] = obj[key].slice(0, Math.max(1, Math.floor(obj[key].length * 0.5)));
          if ("count" in obj) obj.count = obj[key].length;
          if ("row_count" in obj) obj.row_count = obj[key].length;
          obj.truncated = true;
          truncated = true;
          break;
        }
      }
      if (truncated) continue;
    }

    break;
  }
  return current;
}
