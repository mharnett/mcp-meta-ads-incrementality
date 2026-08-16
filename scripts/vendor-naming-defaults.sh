#!/usr/bin/env bash
# Regenerate src/lib/naming_defaults.json from the canonical YAML in drak-ops.
#
# The naming rules live in drak-ops (private, Python). This MCP is Node and
# public, so it cannot import them — it carries a vendored copy instead, and
# naming-standards.test.ts asserts validateName() actually enforces that copy.
#
# That closes the join inside this repo. The other join — canonical YAML vs
# this vendored copy — is guarded on the drak-ops side by a checksum test that
# fails when the YAML changes, telling you to re-run this script.
#
# Usage:  scripts/vendor-naming-defaults.sh [path-to-drak-ops]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DRAK_OPS="${1:-${DRAK_OPS_PATH:-$REPO/../drak-ops}}"
YAML="$DRAK_OPS/src/drak_ops/ad_standards/naming_defaults.yaml"

if [ ! -f "$YAML" ]; then
  echo "error: canonical YAML not found at $YAML" >&2
  echo "       pass the drak-ops checkout path as \$1 or set DRAK_OPS_PATH." >&2
  exit 1
fi

python3 - "$YAML" "$REPO/src/lib/naming_defaults.json" <<'PY'
import hashlib, json, sys
import yaml

src, dest = sys.argv[1], sys.argv[2]
raw = open(src, "rb").read()
data = yaml.safe_load(raw)["naming_standards"]
out = {
    "_comment": (
        "VENDORED — do not edit. Canonical source: drak-ops "
        "src/drak_ops/ad_standards/naming_defaults.yaml. Regenerate with "
        "scripts/vendor-naming-defaults.sh when that file changes."
    ),
    "_source_sha256": hashlib.sha256(raw).hexdigest(),
    "forbidden_chars": data["forbidden_chars"]["chars"],
    "allowed_pattern": data["allowed_pattern"]["regex"],
    "separator": data["separator"]["preferred"],
    "length": {
        "campaign": data["length"]["campaign_max_chars"],
        "adgroup": data["length"]["adgroup_max_chars"],
        "ad": data["length"]["ad_max_chars"],
    },
}
with open(dest, "w") as fh:
    json.dump(out, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print(f"wrote {dest} (source sha256 {out['_source_sha256'][:12]}…)")
PY
