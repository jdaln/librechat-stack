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
  if docker exec \
    -e HTTP_PROXY= \
    -e HTTPS_PROXY= \
    -e http_proxy= \
    -e https_proxy= \
    LibreChat sh -ec 'curl -fsS --max-time 30 "${FIRECRAWL_API_URL}" >/dev/null'; then
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
  if CONFIG_JSON="$(docker exec api-proxy curl -fsS --max-time 10 http://127.0.0.1/api/config 2>/dev/null)"; then
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
  console.warn("LibreChat config endpoint did not expose detailed web search config; continuing to tool-chain probe:", JSON.stringify({
    interface: cfg?.interface?.webSearch,
    webSearch: cfg?.webSearch,
  }));
} else {
  console.log("LibreChat web search config is active.");
}
' "${CONFIG_JSON}"

echo "Checking SearX search endpoint through LibreChat network"
searx_search_ok=false
for attempt in $(seq 1 3); do
  set +e
  searx_result="$(
    docker exec \
      -e HTTP_PROXY= \
      -e HTTPS_PROXY= \
      -e http_proxy= \
      -e https_proxy= \
      LibreChat sh -ec 'curl -fsS --max-time 120 -H "X-API-Key: ${SEARXNG_API_KEY}" "${SEARXNG_INSTANCE_URL%/}/search?q=LibreChat%20official%20website&format=json"' 2>&1
  )"
  searx_rc=$?
  set -e
  if [[ "${searx_rc}" -eq 0 ]] && node -e 'const data = JSON.parse(process.argv[1]); if (!Array.isArray(data.results)) process.exit(1);' "${searx_result}"; then
    echo "SearX search endpoint returned JSON results array."
    searx_search_ok=true
    break
  fi
  printf '%s\n' "${searx_result}"
  sleep 4
done

if [[ "${searx_search_ok}" != true ]]; then
  echo "SearX search endpoint check failed after retries" >&2
  exit 1
fi

echo "Checking Jina reranker endpoint through LibreChat network"
jina_result="$(
  docker exec \
    -e HTTP_PROXY= \
    -e HTTPS_PROXY= \
    -e http_proxy= \
    -e https_proxy= \
    LibreChat sh -ec 'payload="{\"query\":\"LibreChat\",\"documents\":[\"LibreChat official website\",\"Unrelated document\"],\"batch_size\":2}"; curl -fsS --max-time 60 -H "content-type: application/json" --data "${payload}" "${JINA_API_URL}"'
)"
node -e '
const data = JSON.parse(process.argv[1]);
const ok = Array.isArray(data.results) && data.results.length === 2 && data.results[0].index === 0;
if (!ok) {
  console.error("Unexpected Jina response:", JSON.stringify(data).slice(0, 400));
  process.exit(1);
}
console.log("Jina reranker endpoint returned deterministic fallback ranking.");
' "${jina_result}"
