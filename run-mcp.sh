#!/bin/bash
# Wrapper to launch Meta Ads Incrementality MCP with token from Keychain
export META_ACCESS_TOKEN=$(security find-generic-password -a meta-ads-mcp -s META_ACCESS_TOKEN -w 2>/dev/null)

if [ -z "$META_ACCESS_TOKEN" ]; then
  echo "[FATAL] META_ACCESS_TOKEN is empty -- Keychain lookup failed." >&2
  exit 1
fi

exec node /Users/mark/claude-code/mcps/mcp-meta-ads-incrementality/dist/index.js
