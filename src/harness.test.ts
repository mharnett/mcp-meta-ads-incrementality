import { registerMcpTests } from "@drak/mcp-test-harness";
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

registerMcpTests({
  name: "mcp-meta-ads-incrementality",
  repoRoot: path.resolve(__dirname, ".."),
  toolPrefix: "meta_ads_",
  minTools: 1,
  requiredTools: ["meta_ads_insights_incrementality"],
  binEntries: { "mcp-meta-ads-incrementality": "dist/index.js", "mcp-meta-ads-auth": "dist/auth-cli.js" },
  hasAuthCli: true,
  authCliBin: "dist/auth-cli.js",
  hasCredentials: true,
  hasResilience: false,
  hasPlatform: true,
  requiredEnvVars: ["META_ACCESS_TOKEN"],
  envPrefix: "META_",
});
