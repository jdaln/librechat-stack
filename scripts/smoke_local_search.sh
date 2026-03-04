#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_URL="$(
  awk -F= '$1 == "DOMAIN_SERVER" { print $2; exit }' "${ROOT_DIR}/.env" 2>/dev/null || true
)"
APP_URL="${APP_URL:-http://127.0.0.1:3080}"
APP_URL="${APP_URL%/}"
CONFIG_URL="${APP_URL}/api/config"

echo "Checking Firecrawl endpoint inside the stack"
for attempt in $(seq 1 60); do
  if docker exec LibreChat node -e '
fetch(process.env.FIRECRAWL_API_URL)
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
'; then
    break
  fi
  if [[ "${attempt}" == "60" ]]; then
    echo "Firecrawl API did not become ready" >&2
    exit 1
  fi
  sleep 2
done

echo "Checking LibreChat config endpoint: ${CONFIG_URL}"
for attempt in $(seq 1 60); do
  if CONFIG_JSON="$(curl -fsS --max-time 10 "${CONFIG_URL}" 2>/dev/null)"; then
    break
  fi
  if [[ "${attempt}" == "60" ]]; then
    echo "LibreChat config endpoint did not become ready: ${CONFIG_URL}" >&2
    exit 1
  fi
  sleep 2
done
node -e '
const cfg = JSON.parse(process.argv[1]);
const ok = cfg?.interface?.webSearch === true &&
  cfg?.webSearch?.searchProvider === "searxng" &&
  cfg?.webSearch?.scraperProvider === "firecrawl" &&
  cfg?.webSearch?.rerankerType === "jina";
if (!ok) {
  console.error("Unexpected web search config:", JSON.stringify({
    interface: cfg?.interface?.webSearch,
    webSearch: cfg?.webSearch,
  }));
  process.exit(1);
}
console.log("LibreChat web search config is active.");
' "${CONFIG_JSON}"

echo "Checking search tool chain inside LibreChat"
search_ok=false
for attempt in $(seq 1 3); do
  set +e
  search_result="$(
    docker exec -e NODE_OPTIONS= -w /app LibreChat node -e '
const { createSearchTool } = require("@librechat/agents");
(async () => {
  const logger = {
    log() {},
    info() {},
    warn() {},
    debug() {},
    error(...args) { console.error(...args); },
  };
  const tool = createSearchTool({
    searchProvider: "searxng",
    searxngInstanceUrl: process.env.SEARXNG_INSTANCE_URL,
    searxngApiKey: process.env.SEARXNG_API_KEY,
    scraperProvider: "firecrawl",
    firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
    firecrawlApiUrl: process.env.FIRECRAWL_API_URL,
    firecrawlVersion: process.env.FIRECRAWL_VERSION,
    rerankerType: "jina",
    jinaApiKey: process.env.JINA_API_KEY,
    jinaApiUrl: process.env.JINA_API_URL,
    topResults: 2,
    safeSearch: 1,
    logger,
  });
  const result = await tool.invoke(
    { query: "LibreChat official website github", news: false, images: false, videos: false },
    { toolCall: { turn: 0 } },
  );
  const text = Array.isArray(result) ? result[0] : result;
  const looksRelevant = typeof text === "string" && (
    text.includes("librechat.ai") || text.includes("github.com/danny-avila/LibreChat")
  );
  if (!looksRelevant) {
    console.error("Unexpected search output:", String(text).slice(0, 400));
    process.exit(1);
  }
  if (text.length > 20000) {
    console.error("Search output is unexpectedly large:", text.length);
    process.exit(1);
  }
  console.log("Search tool returned LibreChat homepage successfully.");
})().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
' 2>&1
  )"
  search_rc=$?
  set -e
  printf '%s\n' "${search_result}"
  if [[ "${search_rc}" -eq 0 ]]; then
    search_ok=true
    break
  fi
  sleep 4
done

if [[ "${search_ok}" != true ]]; then
  echo "Search tool chain check failed after retries" >&2
  exit 1
fi
