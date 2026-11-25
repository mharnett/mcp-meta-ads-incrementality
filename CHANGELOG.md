# Changelog

## [0.4.3](https://github.com/mharnett/mcp-meta-ads-incrementality/compare/mcp-meta-ads-incrementality-v0.4.2...mcp-meta-ads-incrementality-v0.4.3) (2026-11-25)


### Bug Fixes

* edit_creative_text checks placement rules before it creates; add mcpName for the MCP registry ([#31](https://github.com/mharnett/mcp-meta-ads-incrementality/issues/31)) ([0f97448](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/0f97448721118346ac73d91e040abdb8ce501e4d))
* url_tags and lead-form swaps check placement rules before creating the creative ([#30](https://github.com/mharnett/mcp-meta-ads-incrementality/issues/30)) ([570daf9](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/570daf9c029f9511d229ebfe85b52c6ce78f5969))
* url_tags and lead-form swaps rebind through the placement-rule check ([#28](https://github.com/mharnett/mcp-meta-ads-incrementality/issues/28)) ([a2b3798](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/a2b37981d71f4d8d059433ee20989da7eeecf7ba))

## [0.4.2](https://github.com/mharnett/mcp-meta-ads-incrementality/compare/mcp-meta-ads-incrementality-v0.4.1...mcp-meta-ads-incrementality-v0.4.2) (2026-11-22)


### Bug Fixes

* create tools refuse any status but PAUSED, and test the write gate at its call site ([#20](https://github.com/mharnett/mcp-meta-ads-incrementality/issues/20)) ([ad006d4](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/ad006d4da7c59a02954b143751da2d7cea7023d0))
* rebind dry run reports what the real run would refuse ([#25](https://github.com/mharnett/mcp-meta-ads-incrementality/issues/25)) ([12c01ab](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/12c01aba244009ae991921cd8f2a148052649726))
* rebind refuses when it can't read the old creative's placement rules ([#24](https://github.com/mharnett/mcp-meta-ads-incrementality/issues/24)) ([5d9b00b](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/5d9b00b47f82923f5a0e3618a842801ebdf0fbc5))

## [0.4.1](https://github.com/mharnett/mcp-meta-ads-incrementality/compare/mcp-meta-ads-incrementality-v0.4.0...mcp-meta-ads-incrementality-v0.4.1) (2026-11-10)


### Bug Fixes

* remove client name from campaign-build comment (277ed63)

## [0.4.0](https://github.com/mharnett/mcp-meta-ads-incrementality/compare/mcp-meta-ads-incrementality-v0.3.0...mcp-meta-ads-incrementality-v0.4.0) (2026-09-16)


### Features

* is_adset_budget_sharing_enabled default + video ad creative support ([#12](https://github.com/mharnett/mcp-meta-ads-incrementality/issues/12)) ([e4ab9f6](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/e4ab9f6708f7c10473c4abe05890d3b01a6be031))

## [0.3.0](https://github.com/mharnett/mcp-meta-ads-incrementality/compare/mcp-meta-ads-incrementality-v0.2.3...mcp-meta-ads-incrementality-v0.3.0) (2026-09-03)


### Features

* write gate via mcp-write-gate — read-only by default ([4de0b04](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/4de0b04078f569c248322e1b722027772eb12a2b))

## [0.2.3](https://github.com/mharnett/mcp-meta-ads-incrementality/compare/mcp-meta-ads-incrementality-v0.2.2...mcp-meta-ads-incrementality-v0.2.3) (2026-07-09)


### Bug Fixes

* **auth:** unify Meta Graph API version to a single source of truth ([22218ca](https://github.com/mharnett/mcp-meta-ads-incrementality/commit/22218ca14b4d1406834e9ccc19e4026b0d7ffc33))
