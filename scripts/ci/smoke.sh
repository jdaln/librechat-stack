#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

INGRESS_URL="${INGRESS_URL:-http://127.0.0.1:3081}"

compose_files=(
  -f docker-compose.yml
  -f compose.hardening.yml
  -f optional/code-interpreter/compose.yml
  -f optional/local-search/compose.yml
)

compose() {
  docker compose "$@"
}

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
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

cleanup() {
  compose \
    --env-file .env \
    "${compose_files[@]}" \
    down -v
}

trap cleanup EXIT

log "Validating compose configuration"
compose \
  --env-file .env \
  "${compose_files[@]}" \
  config -q

log "Preparing local Jina reranker image"
# Export the image name from .env so the build script tags with the same
# (possibly GHCR-prefixed) name that compose will reference.
export JINA_RERANKER_IMAGE
JINA_RERANKER_IMAGE="$(grep '^[[:space:]]*JINA_RERANKER_IMAGE=' .env | tail -1 | cut -d= -f2-)"
./scripts/prepare_jina_reranker_image.sh

log "Starting hardened stack with code interpreter and local search overlays"
compose \
  --env-file .env \
  "${compose_files[@]}" \
  up -d

log "Waiting for LibreChat ingress"
wait_http "${INGRESS_URL}/login"

log "Waiting for code interpreter health endpoint"
wait_http "http://127.0.0.1:8001/health"

log "Waiting for SearXNG and Jina reranker"
wait_http "http://127.0.0.1:8080/"
wait_http "http://127.0.0.1:8787/health"

log "Waiting for Firecrawl API inside the stack"
for attempt in $(seq 1 60); do
  if docker exec LibreChat node -e 'fetch(process.env.FIRECRAWL_API_URL).then((r)=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))'; then
    break
  fi
  sleep 2
  if [[ "${attempt}" == "60" ]]; then
    echo "Timed out waiting for Firecrawl API" >&2
    exit 1
  fi
done

log "Checking allowlisted egress policy"
allowed_result="$(
  docker exec LibreChat node - <<'EOF'
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
  console.log(await testHost('opencode.ai'));
  console.log(await testHost('example.com'));
})().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
EOF
)"
printf '%s\n' "${allowed_result}"
grep -q '200 Connection established' <<<"${allowed_result}"
grep -q '403 Forbidden' <<<"${allowed_result}"

log "Checking proxy-mediated OpenCode reachability from LibreChat"
models_result="$(
  docker exec LibreChat node - <<'EOF'
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
printf '%s\n' "${models_result}"
grep -q '^STATUS 200$' <<<"${models_result}"

log "Checking code interpreter execution from LibreChat container"
exec_result="$(
  docker exec LibreChat node - <<'EOF'
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
printf '%s\n' "${exec_result}"
grep -q '^STATUS 200$' <<<"${exec_result}"
grep -q '"stdout":"4\\n"' <<<"${exec_result}"

log "Checking agent execute_code flow through OpenCode"
agent_exec_result="$(
  docker exec LibreChat node - <<'EOF'
const { Run, Providers, createCodeExecutionTool } = require('@librechat/agents');
const { HumanMessage } = require('@langchain/core/messages');

(async () => {
  const tool = createCodeExecutionTool({ apiKey: process.env.LIBRECHAT_CODE_API_KEY });
  const run = await Run.create({
    runId: 'ci-agent-exec-smoke',
    graphConfig: {
      type: 'standard',
      signal: new AbortController().signal,
      agents: [
        {
          agentId: 'ci-agent',
          provider: Providers.OPENAI,
          name: 'CI Agent',
          instructions: 'Use execute_code whenever arithmetic is requested.',
          tools: [tool],
          clientOptions: {
            model: 'big-pickle',
            apiKey: process.env.OPENAI_API_KEY,
            configuration: {
              baseURL: process.env.OPENAI_REVERSE_PROXY,
            },
            temperature: 0.2,
            streaming: true,
          },
        },
      ],
    },
  });

  await Promise.race([
    run.processStream(
      { messages: [new HumanMessage('What is 2+2? Use execute_code.')] },
      {
        version: 'v2',
        configurable: {
          thread_id: 'ci-agent-thread',
          user_id: 'ci-agent-user',
          requestBody: {
            messageId: 'ci-agent-message',
            conversationId: 'ci-agent-thread',
            parentMessageId: 'ci-agent-parent',
          },
          user: { id: 'ci-agent-user' },
        },
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 45000)),
  ]);

  const messages = run.getRunMessages() || [];
  const finalMessage = messages.at(-1);
  const text = typeof finalMessage?.content === 'string' ? finalMessage.content : '';

  if (!text.includes('4')) {
    console.error(JSON.stringify({ ok: false, text, count: messages.length }));
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, text, count: messages.length }));
})().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
EOF
)"
printf '%s\n' "${agent_exec_result}"
grep -q '"ok":true' <<<"${agent_exec_result}"

log "Checking local search stack"
./scripts/smoke_local_search.sh

log "Smoke checks passed"
