#!/bin/bash
# Wrapper to launch Meta Ads Incrementality MCP with token from Keychain
#
# Shared Keychain helper (drak-ops): resolves through the installed package
# location, not a vendored copy — see drak_ops.keychain.keychain_shell_helper_path().
HELPER="$(python3 -c 'from drak_ops.keychain import keychain_shell_helper_path as p; print(p())')"
source "$HELPER"

export META_ACCESS_TOKEN=$(keychain_get "META_ACCESS_TOKEN" "meta-ads-mcp" 2>/dev/null)

if [ -z "$META_ACCESS_TOKEN" ]; then
  echo "[FATAL] META_ACCESS_TOKEN is empty -- Keychain lookup failed." >&2
  exit 1
fi

exec node /Users/mark/claude-code/mcps/mcp-meta-ads-incrementality/dist/index.js
