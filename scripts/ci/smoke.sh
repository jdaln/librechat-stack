#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

INGRESS_URL="${INGRESS_URL:-http://127.0.0.1:3081}"
ARTIFACTS_DIR="${CI_ARTIFACTS_DIR:-ci_artifacts}"
SMOKE_CLEAN_VOLUMES="${SMOKE_CLEAN_VOLUMES:-0}"

compose_files=(
  -f docker-compose.yml
  -f compose.hardening.yml
  -f optional/code-interpreter/compose.yml
  -f optional/local-search/compose.yml
)

prepare_runtime_secrets() {
  local env_file="${ROOT_DIR}/.env"
  local secrets_dir="${ROOT_DIR}/secrets"

  if [[ ! -f "${env_file}" ]]; then
    echo "Missing ${env_file}" >&2
    exit 1
  fi

  read_env_var() {
    local key="$1"
    awk -F= -v k="${key}" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "${env_file}"
  }

  mkdir -p "${secrets_dir}"
  printf '%s' "$(read_env_var MONGO_ROOT_USER)" > "${secrets_dir}/runtime-mongo-root-user.txt"
  printf '%s' "$(read_env_var MONGO_ROOT_PASSWORD)" > "${secrets_dir}/runtime-mongo-root-password.txt"
  printf '%s' "$(read_env_var MONGO_APP_USER)" > "${secrets_dir}/runtime-mongo-app-user.txt"
  printf '%s' "$(read_env_var MONGO_APP_PASSWORD)" > "${secrets_dir}/runtime-mongo-app-password.txt"
  chmod 600 "${secrets_dir}/runtime-mongo-root-user.txt" \
            "${secrets_dir}/runtime-mongo-root-password.txt" \
            "${secrets_dir}/runtime-mongo-app-user.txt" \
            "${secrets_dir}/runtime-mongo-app-password.txt" || true
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

compose_down() {
  local -a down_args
  down_args=(
    --env-file .env
    "${compose_files[@]}"
    down
  )
  if [[ "${SMOKE_CLEAN_VOLUMES}" == "1" ]]; then
    down_args+=(-v)
  fi
  compose "${down_args[@]}"
}

wait_http() {
  local url="$1"
  local attempts="${2:-60}"
  local i

  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for ${url}" >&2
  return 1
}

wait_internal_http() {
  local url="$1"
  local attempts="${2:-60}"
  local i

  for ((i = 1; i <= attempts; i++)); do
    if docker exec LibreChat node -e 'const url = process.argv[1]; fetch(url).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));' "$url"; then
      return 0
    fi
    sleep 2
  done

  echo "Timed out waiting for internal ${url}" >&2
  return 1
}

cleanup() {
  local exit_code="$1"

  if [[ "${exit_code}" -ne 0 ]]; then
    mkdir -p "${ARTIFACTS_DIR}"
    log "Smoke failed; collecting diagnostics into ${ARTIFACTS_DIR}"

    {
      printf 'smoke_exit_code=%s\n' "${exit_code}"
      date -u '+timestamp_utc=%Y-%m-%dT%H:%M:%SZ'
    } >"${ARTIFACTS_DIR}/metadata.txt"

    compose \
      --env-file .env \
      "${compose_files[@]}" \
      ps >"${ARTIFACTS_DIR}/compose-ps.txt" 2>&1 || true

    compose \
      --env-file .env \
      "${compose_files[@]}" \
      logs --no-color >"${ARTIFACTS_DIR}/compose-logs.txt" 2>&1 || true

    docker ps -a >"${ARTIFACTS_DIR}/docker-ps-a.txt" 2>&1 || true
  fi

  compose_down || true

  exit "${exit_code}"
}

trap 'cleanup $?' EXIT

log "Validating compose configuration"
prepare_runtime_secrets
compose \
  --env-file .env \
  "${compose_files[@]}" \
  config -q

log "Preparing local Jina reranker image"
./scripts/prepare_jina_reranker_image.sh

log "Ensuring clean compose state"
compose_down || true

log "Starting hardened stack with code interpreter and local search overlays"
compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d

log "Waiting for LibreChat ingress"
wait_http "${INGRESS_URL}/login"

log "Checking ingress exposure model"
if docker port LibreChat 3080 >/dev/null 2>&1; then
  echo "LibreChat container unexpectedly exposes host port 3080" >&2
  exit 1
fi
if ! docker port api-proxy 80/tcp | grep -q '127.0.0.1:3081'; then
  echo "api-proxy is missing host bind 127.0.0.1:3081->80" >&2
  exit 1
fi
if ! docker port api-proxy 81/tcp | grep -q '127.0.0.1:80'; then
  echo "api-proxy is missing host bind 127.0.0.1:80->81 for sandpack ingress" >&2
  exit 1
fi
api_proxy_compose_block="$(
  compose \
    --env-file .env \
    "${compose_files[@]}" \
    config | awk '
      /^  api-proxy:$/ { in_block=1; print; next }
      /^  [^ ]/ && in_block { exit }
      in_block { print }
    '
)"
if grep -q '^    environment:' <<<"${api_proxy_compose_block}"; then
  echo "api-proxy should not have explicit environment proxy wiring in compose config" >&2
  exit 1
fi
if docker port sandpack-bundler 80/tcp >/dev/null 2>&1; then
  echo "sandpack-bundler should not expose host port 80 directly" >&2
  exit 1
fi
sandpack_networks="$(docker inspect sandpack-bundler --format '{{json .NetworkSettings.Networks}}')"
if grep -q '"librechat-stack_wan"' <<<"${sandpack_networks}"; then
  echo "sandpack-bundler should not be attached to librechat-stack_wan" >&2
  exit 1
fi

log "Checking Mongo credential handling"
mongo_env="$(docker inspect chat-mongodb --format '{{json .Config.Env}}')"
if ! grep -q 'MONGO_INITDB_ROOT_USERNAME_FILE=' <<<"${mongo_env}"; then
  echo "MongoDB is missing *_FILE root credential env vars" >&2
  exit 1
fi
if grep -q 'MONGO_INITDB_ROOT_USERNAME=' <<<"${mongo_env}" || grep -q 'MONGO_INITDB_ROOT_PASSWORD=' <<<"${mongo_env}"; then
  echo "MongoDB still has plaintext root credential env vars" >&2
  exit 1
fi

mongo_init_env="$(docker inspect mongo-init --format '{{json .Config.Env}}')"
if grep -q 'MONGO_ROOT_PASSWORD=' <<<"${mongo_init_env}" || grep -q 'MONGO_APP_PASSWORD=' <<<"${mongo_init_env}"; then
  echo "mongo-init still has plaintext credential env vars" >&2
  exit 1
fi

log "Checking local-search and interpreter secret hygiene"
api_env="$(docker inspect LibreChat --format '{{json .Config.Env}}')"
if grep -q 'SEARXNG_API_KEY=' <<<"${api_env}"; then
  if grep -q 'SEARXNG_API_KEY=$' <<<"${api_env}" || \
     grep -q 'SEARXNG_API_KEY=24389_CHANGE_ME' <<<"${api_env}" || \
     grep -q 'SEARXNG_API_KEY=change-me-searxng-api-key' <<<"${api_env}"; then
    echo "SEARXNG_API_KEY is unset or placeholder in LibreChat env" >&2
    exit 1
  fi
fi

code_env="$(docker inspect code-interpreter-api --format '{{json .Config.Env}}')"
if grep -q 'MINIO_ACCESS_KEY=minioadmin' <<<"${code_env}" || grep -q 'MINIO_SECRET_KEY=minioadmin' <<<"${code_env}"; then
  echo "Code interpreter is using insecure default MinIO credentials" >&2
  exit 1
fi

log "Checking egress proxy image pin"
egress_image="$(docker inspect egress-proxy --format '{{.Config.Image}}')"
if [[ "${egress_image}" != *"@sha256:"* ]]; then
  echo "egress-proxy image is not digest-pinned: ${egress_image}" >&2
  exit 1
fi

log "Checking RAG image source and pin"
rag_image="$(docker inspect rag_api --format '{{.Config.Image}}')"
if [[ "${rag_image}" != registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite:* ]] || [[ "${rag_image}" != *"@sha256:"* ]]; then
  echo "Unexpected rag_api image (expect registry.librechat.ai digest pin): ${rag_image}" >&2
  exit 1
fi

log "Checking seccomp/apparmor posture"
for container in \
  LibreChat api-proxy egress-proxy sandpack-bundler rag_api chat-mongodb chat-meilisearch vectordb \
  searxng searxng-auth-proxy searxng-valkey firecrawl-api firecrawl-playwright firecrawl-redis firecrawl-rabbitmq firecrawl-postgres \
  jina-reranker code-interpreter-api code-interpreter-redis code-interpreter-minio; do
  secopts="$(docker inspect "${container}" --format '{{json .HostConfig.SecurityOpt}}')"
  if grep -q 'seccomp=unconfined' <<<"${secopts}"; then
    echo "${container} has seccomp=unconfined" >&2
    exit 1
  fi
  if [[ "${container}" != "code-interpreter-api" ]] && grep -q 'apparmor:unconfined' <<<"${secopts}"; then
    echo "${container} unexpectedly has apparmor:unconfined" >&2
    exit 1
  fi
done

log "Checking code interpreter capability set"
ci_cap_add="$(docker inspect code-interpreter-api --format '{{json .HostConfig.CapAdd}}')"
if ! grep -Eq '^\["(CAP_)?SYS_ADMIN"\]$' <<<"${ci_cap_add}"; then
  echo "Unexpected code-interpreter-api CapAdd: ${ci_cap_add}" >&2
  exit 1
fi

log "Waiting for code interpreter health endpoint inside the stack"
for attempt in $(seq 1 60); do
  if docker exec -i LibreChat node - <<'EOF'
fetch(process.env.LIBRECHAT_CODE_BASEURL + '/health', {
  headers: { 'x-api-key': process.env.LIBRECHAT_CODE_API_KEY },
})
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
EOF
  then
    break
  fi
  sleep 2
  if [[ "${attempt}" == "60" ]]; then
    echo "Timed out waiting for internal code interpreter health endpoint" >&2
    exit 1
  fi
done

log "Waiting for SearXNG and Jina reranker inside the stack"
jina_health_url="$(
  docker exec -e NODE_OPTIONS= LibreChat node -e 'const u = new URL(process.env.JINA_API_URL); u.pathname = "/health"; u.search = ""; console.log(u.toString());'
)"
wait_internal_http "${jina_health_url}"

log "Checking SearX auth proxy enforcement"
searx_auth_ok=false
for attempt in $(seq 1 30); do
  set +e
  searx_auth_result="$(
    docker exec -i LibreChat node - <<'EOF' 2>&1
const base = process.env.SEARXNG_INSTANCE_URL || 'http://searxng-auth:8080';
const key = process.env.SEARXNG_API_KEY || '';
const url = new URL('/search', base);
url.searchParams.set('q', 'librechat');
url.searchParams.set('format', 'json');

async function call(withKey) {
  const headers = withKey ? { 'X-API-Key': key } : {};
  const res = await fetch(url, { headers });
  return res.status;
}

(async () => {
  const denied = await call(false);
  const allowed = await call(true);
  const ok = denied === 401 && allowed === 200;
  console.log(JSON.stringify({ denied, allowed, ok }));
  if (!ok) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
EOF
  )"
  searx_auth_rc=$?
  set -e
  printf '%s\n' "${searx_auth_result}"
  if [[ "${searx_auth_rc}" -eq 0 ]] && grep -q '"ok":true' <<<"${searx_auth_result}"; then
    searx_auth_ok=true
    break
  fi
  sleep 2
done
if [[ "${searx_auth_ok}" != true ]]; then
  echo "SearX auth proxy enforcement check failed" >&2
  exit 1
fi

log "Waiting for Firecrawl API inside the stack"
wait_internal_http "${FIRECRAWL_API_URL:-http://firecrawl-api:3002}"

log "Checking allowlisted egress policy"
set +e
allowed_result="$(
  docker exec -i LibreChat node - <<'EOF' 2>&1
const net = require('net');

function testHost(host) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: 'egress-proxy', port: 3128 }, () => {
      socket.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });

    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n')) {
        socket.destroy();
        resolve(data.split('\r\n')[0]);
      }
    });
    socket.on('error', reject);
  });
}

(async () => {
  const allowed = await testHost('opencode.ai');
  const blocked = await testHost('example.com');
  const ok = / 200 /.test(allowed) && !/ 200 /.test(blocked);
  console.log(JSON.stringify({ allowed, blocked, ok }));
  if (!ok) {
    process.exit(1);
  }
})().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
EOF
)"
allowed_rc=$?
set -e
printf '%s\n' "${allowed_result}"
if [[ "${allowed_rc}" -ne 0 ]]; then
  echo "Allowlisted egress policy check failed" >&2
  exit 1
fi
grep -q '"ok":true' <<<"${allowed_result}"

log "Checking proxy-mediated OpenCode reachability from LibreChat"
models_ok=false
for attempt in $(seq 1 6); do
  set +e
  models_result="$(
    docker exec -i LibreChat node - <<'EOF' 2>&1
fetch('https://opencode.ai/zen/v1/models')
  .then(async (res) => {
    console.log(`STATUS ${res.status}`);
    const body = await res.text();
    console.log(body.slice(0, 200));
  })
  .catch((error) => {
    console.error(error.cause?.stack || error.stack || String(error));
    process.exit(1);
  });
EOF
  )"
  models_rc=$?
  set -e
  printf '%s\n' "${models_result}"
  if [[ "${models_rc}" -eq 0 ]] && grep -Eq '^STATUS (200|401|429)$' <<<"${models_result}"; then
    models_ok=true
    break
  fi
  sleep 5
done
if [[ "${models_ok}" != true ]]; then
  echo "Warning: OpenCode model list was unreachable after retries; continuing CI checks." >&2
fi

log "Checking code interpreter execution from LibreChat container"
set +e
exec_result="$(
  docker exec -i LibreChat node - <<'EOF' 2>&1
const url = process.env.LIBRECHAT_CODE_BASEURL + '/exec';

fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': process.env.LIBRECHAT_CODE_API_KEY,
  },
  body: JSON.stringify({
    lang: 'py',
    code: 'print(2+2)',
    entity_id: 'ci-smoke',
    user_id: 'ci-smoke',
  }),
})
  .then(async (res) => {
    console.log(`STATUS ${res.status}`);
    console.log(await res.text());
  })
  .catch((error) => {
    console.error(error.stack || String(error));
    process.exit(1);
  });
EOF
)"
exec_rc=$?
set -e
printf '%s\n' "${exec_result}"
if [[ "${exec_rc}" -ne 0 ]]; then
  echo "Code interpreter execution probe failed" >&2
  exit 1
fi
grep -q '^STATUS 200$' <<<"${exec_result}"
grep -q '"stdout":"4\\n"' <<<"${exec_result}"

log "Checking local search stack"
./scripts/smoke_local_search.sh

log "Smoke checks passed"
