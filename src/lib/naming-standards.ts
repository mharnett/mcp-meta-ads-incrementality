/**
 * Naming standards check — a TS implementation of shared ad-naming rules.
 *
 * The rules themselves are vendored in ./naming_defaults.json so this Node MCP
 * can validate without shelling out to Python. naming-standards.test.ts asserts
 * that validateName() actually enforces that vendored copy — so the constants
 * below cannot drift from the rules without failing CI.
 *
 * Do not hand-edit the constants to change a rule. Change it at the source and
 * re-run scripts/vendor-naming-defaults.sh; the tests will tell you what to
 * bring into line here.
 *
 * (This used to read "if the source changes, update here too", which is a
 * hand-sync nothing enforced — it had been stale for three months in a
 * published package before anyone looked.)
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
