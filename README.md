# mcp-meta-ads-incrementality

> An MCP server for Meta Marketing API insights, built around incrementality.
> The default attribution window is `incrementality`, not `7d_click + 1d_view`.

Most agency reports today use Meta's default 7-day-click + 1-day-view attributed conversions. That number systematically overstates ad impact: it credits clicks that would have converted anyway and gives view-credit for impressions that didn't change behavior. Meta exposes an `incrementality` breakdown on its insights API that returns the actual incremental conversion count.

This MCP server makes that the default, and lets you ask for the standard windows in the same call to quantify the gap.

## Status

`v0.1.0` — early. One tool today (`meta_ads_insights_incrementality`). Comprehensive unit-test coverage of the incrementality math, attribution-window handling, and Meta SDK request shape (120+ tests). Real-API integration is unverified at this version — we recommend running it against a sandboxed account first.

This package is not affiliated with, endorsed by, or sponsored by Meta Platforms, Inc. "Meta" and "Facebook" are trademarks of Meta Platforms, Inc.

## Install

```bash
npm install -g mcp-meta-ads-incrementality
```

Or run directly via `npx`:

```bash
npx mcp-meta-ads-incrementality --help
```

## Auth

Set `META_ACCESS_TOKEN` to a Meta Marketing API access token. A **System User token** from Business Manager is strongly recommended — it doesn't expire and is scoped to the ad accounts the System User has access to.

To create one:

1. Open [Business Manager](https://business.facebook.com/) → Business Settings → Users → System Users.
2. Create a new System User and assign it to the ad accounts you want to manage.
3. Generate a token with `ads_read` and `ads_management` permissions.
4. Export it: `export META_ACCESS_TOKEN=EAAB...`

User access tokens (60-day) also work. For agency use, get **Advanced Access** to the Marketing API via App Review — Standard Access only works against ad accounts the developer owns.

## Configure in your MCP client

Claude Desktop or Claude Code, in `.mcp.json`:

```json
{
  "mcpServers": {
    "meta-ads-incrementality": {
      "command": "npx",
      "args": ["-y", "mcp-meta-ads-incrementality"],
      "env": {
        "META_ACCESS_TOKEN": "EAAB..."
      }
    }
  }
}
```

## Tools

### `meta_ads_insights_incrementality`

Pull Meta Ads insights for a date range with one or more attribution windows. Returns per-row conversion counts and a summary.

**Inputs:**

| field | required | default | notes |
|---|---|---|---|
| `ad_account_id` | yes | — | with or without `act_` prefix |
| `date_range` | yes | — | `{ since: "YYYY-MM-DD", until: "YYYY-MM-DD" }` |
| `conversion_event_name` | yes | — | e.g. `offsite_conversion.fb_pixel_purchase` |
| `attribution_windows` | no | `["incrementality"]` | array of valid windows |
| `level` | no | `"campaign"` | `account`, `campaign`, `adset`, `ad` |
| `campaign_id` | no | — | restrict to a single campaign |
| `adset_id` | no | — | restrict to a single ad set |
| `breakdowns` | no | — | Meta breakdown fields |

**Valid attribution windows:** `incrementality`, `1d_click`, `7d_click`, `28d_click`, `1d_view`, `1d_ev`, `dda`, `skan_view`, `skan_click`. (Note: `7d_view` and `28d_view` were deprecated by Meta on Jan 12, 2026 and are not accepted.)

**Output shape:**

```jsonc
{
  "meta": {
    "ad_account_id": "act_123",
    "date_range": { "since": "2026-03-01", "until": "2026-03-31" },
    "level": "campaign",
    "conversion_event_name": "offsite_conversion.fb_pixel_purchase",
    "attribution_windows": ["incrementality", "7d_click", "1d_view"]
  },
  "rows": [
    {
      "campaign_id": "...",
      "campaign_name": "Brand",
      "spend": 5000,
      "conversions": { "incrementality": 40, "7d_click": 80, "1d_view": 20 },
      "default_attributed": 100,
      "inflation_factor": 2.5,
      "overstatement_pct": 60
    }
  ],
  "summary": {
    "total_spend": 5000,
    "total_conversions": { "incrementality": 40, "7d_click": 80, "1d_view": 20 },
    "cpa": { "incrementality": 125, "7d_click": 62.5, "1d_view": 250 },
    "inflation_factor": 2.5
  }
}
```

When `incrementality` and at least one of `7d_click` / `1d_view` are both requested, every row gets:

- `default_attributed` — sum of `7d_click` + `1d_view` (the standard agency number)
- `inflation_factor` — `default_attributed / incrementality` (how much larger the reported number is)
- `overstatement_pct` — `(default - incrementality) / default × 100`

## Pitch for agencies

Most agency reports show the default 7d-click + 1d-view conversion number. That number is systematically inflated. Meta's own `incrementality` breakdown is the true incremental count — and if you put both numbers next to each other in a client report, the gap is usually large. The `inflation_factor` field in this MCP's output is the headline metric: "the number you've been reporting is X× the actual incremental impact."

Use this MCP as the data source for your AI-driven reporting workflows. The defaults are set up so that the right number leads.

## Caveats

- The `incrementality` attribution window is referenced in Meta's Breakdowns documentation but is not in the canonical `action_attribution_windows` enum on the Ad Account Insights reference page. We've defaulted to it because it's the right thing to report — but if Meta changes the API, this MCP will need to follow. Pin the version if stability matters more than correctness.
- For agencies running campaigns where true incrementality matters at the dollar level, **Conversion Lift studies** (set up in advance with a randomized holdout group) remain the gold standard. This MCP does not yet expose those — that's planned for v0.2.
- Built on `facebook-nodejs-business-sdk` (Meta's official Node SDK). Inherits any quirks of that SDK including a known appsecret_proof pagination bug.

## License

MIT. See [LICENSE](./LICENSE).
