/**
 * Naming standards check — TS port of drak-ops/ad_standards/naming_defaults.yaml.
 *
 * Canonical source of truth is the YAML in drak-ops. This file mirrors those
 * rules so the Node-based MCP can validate without shelling out to Python.
 * If the YAML changes, update here too — search for the YAML's commit ts
 * comment to identify drift.
 *
 * Mirrors as of: drak-ops 6537d2e (2026-05-05).
 */

const FORBIDDEN_CHARS = [
  ' ', '(', ')', ',', '&', '?', '#', '=', '+', '%', '/', '\\', '"', "'",
];
const ALLOWED_PATTERN = /^[A-Za-z0-9_\-.:]+$/;
const SEPARATOR = '-';

export type EntityType = 'campaign' | 'adgroup' | 'ad';

const LENGTH_MAX: Record<EntityType, number> = {
  campaign: 128,
  adgroup: 128,
  ad: 256,
};

export interface NamingViolation {
  entity_type: EntityType;
  name: string;
  rule: string;
  detail: string;
  suggested?: string;
}

function suggestSanitized(name: string): string {
  let cleaned = name.replace(/\s+/g, SEPARATOR);
  cleaned = cleaned.replace(/[(),&?#=+%\\/"']+/g, SEPARATOR);
  cleaned = cleaned.replace(new RegExp(`${SEPARATOR}{2,}`, 'g'), SEPARATOR);
  return cleaned.replace(new RegExp(`^[${SEPARATOR}.]+|[${SEPARATOR}.]+$`, 'g'), '');
}

export function validateName(name: string, entityType: EntityType): NamingViolation[] {
  const violations: NamingViolation[] = [];

  const found = FORBIDDEN_CHARS.filter((c) => name.includes(c));
  if (found.length > 0) {
    violations.push({
      entity_type: entityType,
      name,
      rule: 'forbidden_chars',
      detail: `Contains forbidden character(s): ${JSON.stringify(found)}`,
      suggested: suggestSanitized(name),
    });
  }

  if (!ALLOWED_PATTERN.test(name)) {
    violations.push({
      entity_type: entityType,
      name,
      rule: 'allowed_pattern',
      detail: `Does not match allowed pattern ${ALLOWED_PATTERN}`,
      suggested: suggestSanitized(name),
    });
  }

  const max = LENGTH_MAX[entityType];
  if (name.length > max) {
    violations.push({
      entity_type: entityType,
      name,
      rule: 'length',
      detail: `Length ${name.length} exceeds platform max ${max}`,
      suggested: name.slice(0, max),
    });
  }

  return violations;
}
