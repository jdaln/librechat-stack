# LibreChat Stack

A hardened, self-hosted [LibreChat](https://www.librechat.ai/) deployment for Apple Silicon — with optional code execution, local web search, and egress-controlled networking.

All outbound traffic from the app goes through a Squid allowlist proxy, databases stay on an internal-only network, and everything runs under read-only rootfs with dropped caps. The defaults target a single M-series Mac running [Colima][1].

Licensed under [Apache 2.0](LICENSE).

---

## Prerequisites

- Docker CLI (`docker` + `docker compose`)
- [Homebrew](https://brew.sh/) (macOS)
- [Colima][1] (Apple Silicon)

## Quick Start

```bash
# 1. Create the Colima VM (once)
colima start -p aiarm --vm-type=vz --cpu 4 --memory 8 --disk 50

# 2. Copy and edit the env template
cp template_dot_env .env
$EDITOR .env              # set API keys, secrets, etc.

# 3. Start the stack
./scripts/start_stack.sh  # handles context switch + compose up
```

The helper script starts Colima if needed, switches Docker context, enforces secret file modes, generates runtime Mongo secret files under `secrets/runtime-*.txt`, and runs `docker compose up -d`. To start manually instead:

```bash
docker context use colima-aiarm
docker compose --env-file .env \
  -f docker-compose.yml -f compose.hardening.yml up -d
```

Open the app at `http://localhost:3081` (through `api-proxy`).

> Every `docker compose` invocation below assumes the same base flags
> (`--env-file .env -f docker-compose.yml -f compose.hardening.yml`)
> plus any optional `-f` overlays. The helper script handles this for you.
> Treat `compose.hardening.yml` as required, not optional — the overlay
> stacks assume the core services run hardened.
> If you only have the legacy `docker-compose` binary (not the V2 plugin),
> substitute `docker-compose` for `docker compose` in every command below.

After the stack is up, create the first admin user:

```bash
docker compose -f docker-compose.yml -f compose.hardening.yml \
  exec -w /app api npm run create-user
```

(`-w /app` is needed because the script is registered in the root
`package.json`; the `api` workspace has a stale entry pointing at the wrong
path.)

### Optional: user-namespace remapping

For an extra security layer, map "root in the container" to an unprivileged user inside the VM:

```bash
colima ssh -p aiarm
echo '{ "userns-remap": "default" }' | sudo tee /etc/docker/daemon.json
echo 'dockremap:165536:65536' | sudo tee -a /etc/subuid /etc/subgid
sudo systemctl restart docker || sudo service docker restart
exit
```

---

## How Egress Hardening Works

The `api` and `rag_api` containers have no direct internet access. All their outbound HTTP(S) goes through an internal Squid proxy that only allows domains listed in `optional/egress-proxy/allowed_domains.txt`.
The `sandpack` container is isolated on a separate internal frontend network; browser access on `http://127.0.0.1:80` is proxied through `api-proxy`.
`api-proxy` stays on the two internal frontend networks plus `ingress` because Docker host port publishing on this stack breaks when the proxy is attached only to an `internal: true` network. The `ingress` bridge has IP masquerading disabled, so it supports localhost-published ports without giving the proxy useful outbound internet access.
`rag_api` is pinned to an official digest (`registry.librechat.ai/...@sha256:...`) to avoid silent image drift.

If an LLM prompt injection tries to exfiltrate data to an unknown host, Squid blocks it. Quick verification:

```bash
# Should print "200 Connection established" for opencode.ai,
# and "403 Forbidden" for example.com
docker exec LibreChat node -e "\
const net=require('net');\
const test=(h)=>new Promise(r=>{\
  const s=net.createConnection({host:'egress-proxy',port:3128},\
    ()=>s.write('CONNECT '+h+':443 HTTP/1.1\r\nHost: '+h+':443\r\n\r\n'));\
  let d='';\
  s.on('data',c=>{d+=c.toString();\
    if(d.includes('\r\n')){console.log(h,d.split('\r\n')[0]);s.destroy();r();}});\
});\
(async()=>{await test('opencode.ai');await test('example.com');})();"
```

Edit the allowlist and restart the proxy to change which domains are permitted.

When the local-search overlay is enabled, SearXNG/Firecrawl egress is routed through Squid with full access logging. By design this path is auditable but not domain-allowlisted, so the stack can scrape arbitrary public result domains. Squid still denies local, private, link-local, reserved, and internal-name destinations to avoid turning search scraping into a private-network SSRF path.

---

## Model Presets

Presets ship in `librechat.yaml`. The model names upstream change over time —
verify against `https://opencode.ai/zen/v1/models` and OpenRouter if a preset 404s.

| Preset (default ★) | Provider | Model | Key |
|--------|----------|-------|-----|
| ★ Nemotron 3 Ultra Free | OpenCode Zen | `nemotron-3-ultra-free` | `public` (free) |
| DeepSeek V4 Flash Free | OpenCode Zen | `deepseek-v4-flash-free` | `public` (free) |
| Gemma 4 31B Free | OpenRouter | `google/gemma-4-31b-it:free` | `OPENROUTER_API_KEY` (free tier) |
| Claude Fable 5 | OpenCode Zen | `claude-fable-5` | real OpenCode key (paid) |

**OpenCode Zen** is the default. The shared `OPENAI_API_KEY=public` key can
list models and run the free `*-free` models out of the box — **but premium
models (`claude-*`, `gpt-5*`, `gemini-*`, …) return 401 with `public`**; set
your own OpenCode key for those and for higher rate limits.

**OpenRouter** needs a separate key (even a free one):
```bash
OPENROUTER_API_KEY=<your-key>
```
With `fetch: true`, a real key auto-populates the full OpenRouter model list in
the UI. Free `*:free` models work but are rate-limited upstream (429s) and are
weaker at agentic tool-calling (e.g. web search).

> Upstream availability drifts: OpenCode Zen dropped `minimax-m2.5-free` /
> `big-pickle`-era free models and OpenRouter retired `trinity-large-preview`.
> The presets above were verified live; refresh them if a model disappears.

Both providers are always selectable in the UI.

> Make sure `agents` is in `ENDPOINTS` (it is by default) if you want saved Agents and tool-enabled chats.

---

## Optional Overlays

Each overlay adds a `-f` compose file. Enable individually with env flags, or pick a named profile.

### Stack Profiles

```bash
STACK_PROFILE=local-only             ./scripts/start_stack.sh   # base + ollama bridge
STACK_PROFILE=local-code             ./scripts/start_stack.sh   # + code interpreter
STACK_PROFILE=local-search           ./scripts/start_stack.sh   # + web search
STACK_PROFILE=local-search-code      ./scripts/start_stack.sh   # both above
STACK_PROFILE=local-rag              ./scripts/start_stack.sh   # + local embeddings for RAG
STACK_PROFILE=full                   ./scripts/start_stack.sh   # everything incl. static preview
STACK_PROFILE=full-remote-inference  ./scripts/start_stack.sh   # `full` minus the Ollama bridge
```

**All standard profiles assume Ollama is running on the host** — they enable the `ollama-proxy` bridge by default. If you only use remote inference (OpenCode Zen / OpenRouter / OpenAI / Anthropic / …) and have no host-side Ollama, use **`full-remote-inference`** — it's the only profile with `ollama` explicitly off.

Without `STACK_PROFILE`, the script checks `ENABLE_CODE_INTERPRETER`, `ENABLE_LOCAL_SEARCH`, `ENABLE_EMBEDDINGS`, `ENABLE_OLLAMA`, and `ENABLE_STATIC_PREVIEW` individually.

---

### Code Interpreter (`execute_code`)

Self-hosted [LibreCodeInterpreter](https://github.com/usnavy13/LibreCodeInterpreter) — lets Agents run Python/JS inside sandboxed nsjail containers.

```bash
# Set a local API key
echo 'LIBRECHAT_CODE_API_KEY=some-strong-secret' >> .env

# Start
ENABLE_CODE_INTERPRETER=1 ./scripts/start_stack.sh

# Verify
curl -fsS http://127.0.0.1:8001/health
```

In the UI, create an Agent and enable the **Code Interpreter** tool. LibreChat reaches the backend internally at `http://code-interpreter-api:8000`.

The helper script (`scripts/prepare_code_interpreter_image.sh`) clones the upstream repo, strips BuildKit-only syntax when `buildx` is absent, and caches everything under `~/Library/Caches/librechat-stack/`.

<details>
<summary>Implementation notes</summary>

- Pinned to commit `170194f` on the `dev` branch.
- The upstream pre-warmed REPL pool doesn't start reliably under Colima's hardened tmpfs layout, so `REPL_ENABLED` and `SANDBOX_POOL_ENABLED` are off. Python falls back to one-shot nsjail execution (slower, stable).
- The container needs `SYS_ADMIN` for nsjail.
- The interpreter backend, Redis, and MinIO live on a dedicated internal `code_interpreter` network. LibreChat reaches the backend across a separate internal `code_gateway` network through `code-interpreter-proxy`, which preserves the `code-interpreter-api` DNS alias for existing `.env` files.
- Interpreter traffic has no WAN egress and no shared network path to MongoDB, RAG, Meilisearch, or Squid.
- `api` sets `HTTP_PROXY`/`HTTPS_PROXY` but not `PROXY`, so `execute_code` calls reach the interpreter directly without Squid.
- MinIO is pinned to `RELEASE.2025-09-07` (later images went source-only).
- MinIO credentials in `template_dot_env` are intentionally non-default placeholders. Set strong values before enabling this overlay.
- `librechat.yaml` must list `execute_code` in `endpoints.agents.capabilities` (it does by default).

</details>

---

### Local Web Search

Runs [SearXNG](https://github.com/searxng/searxng) + [Firecrawl](https://github.com/mendableai/firecrawl) + a [Jina reranker](https://github.com/freshe/librechat-jina-reranker-api) inside the stack. No external search API keys required.

```bash
ENABLE_LOCAL_SEARCH=1 ./scripts/start_stack.sh

# Smoke test
./scripts/smoke_local_search.sh
```

Web search is already wired in `librechat.yaml` — just flip the search toggle on any conversation or Agent.

The Jina reranker image is built locally by `scripts/prepare_jina_reranker_image.sh` with the tiny `jina-reranker-v1-tiny-en` model baked in, so the container stays offline after the first build.

Search context is bounded by default (3 results, 2 scraped sources, 2 highlights) to keep model context reasonable. Tune with `LIBRECHAT_WEB_SEARCH_*` env vars.

<details>
<summary>Implementation notes</summary>

- SearXNG config (`optional/local-search/searxng/settings.yml`): JSON output enabled (LibreChat requires it), noisy engines removed, timeout lowered to 4 s.
- DDG header-order patch (`optional/local-search/searxng/patch_ddg_header_order.py`, applied at image build): DuckDuckGo fingerprints HTTP header order since ~2026-08-30 ([searxng#6596](https://github.com/searxng/searxng/issues/6596)) and answers stock SearXNG with an HTTP 202 challenge regardless of IP (verified: identical request passes with `User-Agent` after `Accept-Language`, fails with it early; TLS cipher shuffle is not a factor). Two edits, both needed because httpx keeps an existing header key's wire position on merge: drop the client-level default `User-Agent` in `searx/network/client.py`, and re-insert `User-Agent` after `Accept-Language` in the DDG engine. Drop when upstream ships [#6620](https://github.com/searxng/searxng/pull/6620)/[#5476](https://github.com/searxng/searxng/pull/5476) and the `SEARXNG_IMAGE` pin moves past the fix.
- SearXNG requests from LibreChat now flow through `searxng-auth-proxy`, which enforces `X-API-Key` using `SEARXNG_API_KEY`. The raw SearXNG service is isolated on a private `searx_internal` network.
- Rate limiting uses Valkey with a private-IP allowlist so LibreChat doesn't trip bot detection.
- LibreChat reaches SearXNG auth, Firecrawl API, and Jina on `search_gateway`; Firecrawl backing services stay on a separate `search` network. SearXNG + Firecrawl web-fetch traffic is routed through Squid on a dedicated `search_egress` subnet so requests are auditable in proxy logs.
- The Jina compatibility patch makes `batch_size` optional — LibreChat's client omits it.
- A mounted search patch caps scraped text, requests `markdown` + `onlyMainContent`, and strips raw `content` from the artifact returned to the model.
- Per-run scrape cache + duplicate-results note: small models loop on near-identical searches within one reply, re-scraping the same top-ranked pages. Raw scrape responses are cached per tool instance (= per agent run, max 40 URLs), so repeats skip Firecrawl while highlights are still reranked against the current query; when a search mostly re-returns already-shown pages, the model output gets an explicit `[Note: X of Y results were already returned …]` nudge. Results are never filtered — citation anchors and the UI source list are unaffected.
- Search requests are paced per provider (`LIBRECHAT_SEARXNG_MIN_INTERVAL_MS`, default 1000 ms between request starts, plus a random `LIBRECHAT_SEARXNG_JITTER_MS`, default 0–1000 ms, so the cadence doesn't look mechanical to bot detection): upstream engines suspend under bursts from one egress IP (DDG CAPTCHA, Brave 429, Qwant access denied), which surfaced as silent zero-result searches when the model fired parallel `web_search` calls.
- A search that still ends with zero sources gets a synthetic placeholder entry injected into the **UI artifact only** (`No results — "<query>"` / `Search failed — …`, linking to the same query on DuckDuckGo), so the "Searched the web" label stays expandable instead of rendering as a dead label. The model output and citation references are untouched.
- Optional Brave fallback: with `BRAVE_API_KEY` set (and no provider override), an empty or failed SearXNG response is retried once via the Brave Search API. Logs never include the query — only the fallback reason and HTTP status.
- After editing files under `optional/local-search/jina/`, recreate the container to pick up changes.
- After editing files under `optional/local-search/librechat-patches/`, rebuild the LibreChat image (`docker compose … build api`) and recreate `api` — the start script does not `--build`.
- Set a strong `SEARXNG_API_KEY` in `.env` (don’t leave placeholders) so internal search calls are authenticated.

</details>

---

### Local Embeddings (RAG)

Self-hosted OpenAI-compatible embeddings server backed by [fastembed](https://github.com/qdrant/fastembed) (ONNX runtime). Lets `rag_api` index uploaded files without an external API key.

```bash
ENABLE_EMBEDDINGS=1 ./scripts/start_stack.sh

# Verify
docker exec LibreChat sh -c 'curl -sS http://rag_api:8000/health'
docker exec LibreChat sh -c 'curl -sS -X POST http://embeddings:8000/v1/embeddings \
  -H "content-type: application/json" \
  -d "{\"input\":\"hello\",\"model\":\"intfloat/multilingual-e5-large\"}" | head -c 200'
```

The default model is **`intfloat/multilingual-e5-large`** (1024-dim, multilingual, baked into the image at build time — ~2.5GB). CPU inference: ~10–20 docs/sec batch, sub-second per query on M-series. Override with `EMBEDDINGS_MODEL=<fastembed-supported-model>` and rebuild.

The overlay also rewires `rag_api`: when `ENABLE_EMBEDDINGS=1`, `RAG_OPENAI_BASEURL` points at the local container automatically — `.env` doesn't need any embedding-provider config.

<details>
<summary>Implementation notes</summary>

- The container is built locally from `optional/embeddings/Dockerfile`. First build downloads the model from Hugging Face (~2.5GB); subsequent runs are offline (`HF_HUB_OFFLINE=1`).
- Attached only to the `lan` network — same posture as `vectordb` and the databases. No WAN egress, no path to Squid. Verifiable via `docs/egress-policy.md`.
- Hardened identically to other stack services: `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, runs as UID 10001.
- Exposes OpenAI's `/v1/embeddings` shape; `rag_api` (which uses the OpenAI client) talks to it without code changes.
- `MAX_BATCH_SIZE=64` by default — increase via `EMBEDDINGS_MAX_BATCH` if you index large corpora.

</details>

---

### Ollama bridge (local LLMs on the host)

If you're already running [Ollama](https://ollama.com/) on the host (macOS native build with Metal acceleration, or wherever), this overlay surfaces every model it has pulled inside LibreChat as the **`Ollama`** custom endpoint.

```bash
# Ensure ollama is running on the host first
ollama list           # should show your models
ENABLE_OLLAMA=1 ./scripts/start_stack.sh
```

In LibreChat the new endpoint will appear in the model picker; `fetch: true` populates the model list automatically from whatever the host has pulled.

```bash
# Verify end-to-end (LibreChat → ollama-proxy → host → Ollama)
docker exec LibreChat python3 -c "
import urllib.request, json
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
print(json.loads(op.open('http://ollama-proxy:11434/v1/models', timeout=5).read())['data'])
"
```

<details>
<summary>Implementation notes</summary>

- `ollama-proxy` is a tiny Caddy reverse-proxy container — same pattern as `code-interpreter-proxy`. It listens on `:11434` and forwards to `host.docker.internal:11434`.
- LibreChat (and every other in-stack service) sits on `internal: true` networks, so there's no IP route to the host bridge gateway from `lan`. The proxy is on two networks: `lan` (to face LibreChat) plus a dedicated narrow bridge `ollama_egress` (to face the host). Only `ollama-proxy` lives on `ollama_egress` — asserted in the smoke. See `docs/egress-policy.md` for the threat model.
- The Caddyfile rewrites `Host` to `127.0.0.1:11434` because Ollama's built-in host-allowlist (DNS-rebinding defense) silently 403s any other Host header.
- No API key required — Ollama doesn't enforce auth, and the proxy is reachable only from inside the stack.
- Models are loaded into RAM lazily on first use. The first request to a cold model can take 30s+ on consumer hardware; subsequent calls are warm.

</details>

---

### Static Preview (Sandpack)

Local sandpack static bundler for artifact previews. Plain HTTP — no TLS setup needed.

```bash
ENABLE_STATIC_PREVIEW=1 ./scripts/start_stack.sh
```

Preview is at `http://127.0.0.1:4324`.
Set `SANDPACK_STATIC_BUNDLER_URL=http://preview.localhost:4324` in `.env` so relay hostnames like `id-preview.localhost` resolve correctly and keep Service Worker support on HTTP.
The dynamic Sandpack bundler URL remains `http://127.0.0.1:80`, but that ingress is now provided by `api-proxy` (the `sandpack` container is no longer host-published directly).

> **LAN note:** defaults are localhost-only. If you expose to your network, also update `DOMAIN_CLIENT`, `DOMAIN_SERVER`, and CORS origins.

---

## Stopping the stack

```bash
./scripts/stop_stack.sh                       # default: full shutdown (containers + Colima VM)
./scripts/stop_stack.sh --pause               # quick pause, VM stays up (fastest restart)
./scripts/stop_stack.sh --keep-colima         # remove containers but keep the VM running
```

**Your data is preserved in every mode** — `docker volume rm` is not invoked. The 15 named volumes that hold state (chat history in `mongo_data`, RAG vectors in `pgdata2`, uploaded files in `lbc_api_uploads`, the Jina model cache, conversation search indexes in `meili_data`, code-interpreter sandboxes, runtime secrets, etc.) stay on disk and are picked up automatically on the next `start_stack.sh`.

Stop modes:

| Mode | Command | What happens | Host RAM | Restart speed |
|---|---|---|---|---|
| **`down` + colima stop** *(default)* | `./scripts/stop_stack.sh` | Containers + networks removed AND Colima VM stopped. | All freed | Full bring-up, ~40-60s |
| **`down`, keep VM** | `./scripts/stop_stack.sh --keep-colima` | Containers + networks removed; Colima VM keeps its allocated RAM. | Most freed | ~30s |
| **`pause`** | `./scripts/stop_stack.sh --pause` | Containers stopped but kept around; VM stays up (implicit). | Mostly held | ~5s |

The script doesn't accept a `-v` / `--remove-volumes` flag on purpose — wiping state should be a deliberate two-step process, not a tab-complete away. To start fresh:

```bash
./scripts/stop_stack.sh
docker volume rm $(docker volume ls -q --filter name=librechat-stack_)
```

## Autostart on Reboot

```bash
./scripts/install_autostart_launchagent.sh
```

Installs a macOS LaunchAgent that runs `start_stack.sh` at login. Logs: `~/Library/Logs/librechat-stack-autostart.log`.

---

## CI & Dependency Updates

- **Stack Smoke** (`.github/workflows/stack-smoke.yml`) runs on push/PR to `main` and `dev`. Tests egress policy, OpenCode reachability, code interpreter execution, agent tool flow, and local search end-to-end.
- Local smoke behavior: `scripts/ci/smoke.sh` keeps volumes by default (`SMOKE_CLEAN_VOLUMES=0`) so chat history persists on your machine. Set `SMOKE_CLEAN_VOLUMES=1` when you intentionally want a full data reset.
- **Renovate** ([renovate.json](renovate.json)) runs weekly targeting `dev`, with dry-run validation on config pushes. Needs a `RENOVATE_TOKEN` repo secret (`repo` + `workflow` scopes) for real PRs.

---

## Troubleshooting

**Services missing after reboot?** The Colima VM probably stopped:
```bash
colima list && docker context use colima-aiarm && ./scripts/start_stack.sh
```

**Env warnings in compose config?**
```bash
docker compose --env-file .env config | head -60
```

**Compose says `secrets/runtime-mongo-*.txt` missing?**
```bash
# Regenerate runtime secret files from .env and start stack
./scripts/start_stack.sh
```

**Can’t reach `http://localhost:3080`?**
```bash
# Direct api port exposure is intentionally disabled.
open http://localhost:3081
```

**Artifact preview is blank / `non-precached-url` in console?**
```bash
# Stack now disables LibreChat's bundled service worker by default.
# Do one-time cleanup in browser: clear site data for localhost and reload.
# Also verify:
#   SANDPACK_BUNDLER_URL=http://127.0.0.1:80
#   SANDPACK_STATIC_BUNDLER_URL=http://preview.localhost:4324
#
# If you see a CORS error (method not allowed) for 127.0.0.1:80 or
# preview.localhost:4324, the narrowed CORS methods are the cause (see TODO):
# restore "GET, POST, PUT, DELETE, OPTIONS" in optional/api-proxy/Caddyfile (:81)
# and optional/static-preview/Caddyfile, then re-run populate + restart api-proxy.
```

**Reduce log volume further (or loosen it):**
```bash
# defaults in template_dot_env
DOCKER_LOG_MAX_SIZE=10m
DOCKER_LOG_MAX_FILE=3
MEILI_LOG_LEVEL=WARN
CODE_INTERPRETER_LOG_LEVEL=WARNING
FIRECRAWL_LOG_LEVEL=warn
JINA_RERANKER_LOG_LEVEL=WARNING
DO_NOT_TRACK=1
FIRECRAWL_NO_TELEMETRY=1
HF_HUB_DISABLE_TELEMETRY=1
```

**Useful log commands:**
```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
docker logs -f --tail=200 LibreChat

# Squid logs all local-search egress (auditable) plus denied requests elsewhere
# to stdout, so it lands in `docker logs` with the standard rotation.
# Look for TCP_DENIED/403 when debugging allowlist misses.
docker logs -f --tail=200 egress-proxy
```

---

## Backups

See [backup/README.md](backup/README.md).

## Running on Linux with rootless Docker

The defaults target macOS + Colima (Docker as root inside the VM). To run on a
Linux VM with **rootless Docker** instead, see
[docs/rootless-linux.md](docs/rootless-linux.md) — it covers the port-80 publish,
cgroup limit delegation, the nsjail code interpreter, UID mapping, and systemd
autostart (the Colima/LaunchAgent tooling is macOS-only).

## Acknowledgements

Compose foundation adapted from [nicedexter](https://github.com/nicedexter).

## TODO

- ⚠️ **UNVERIFIED: Sandpack artifact-preview CORS.** The CORS allow-methods on
  the Sandpack bundler ingress (`optional/api-proxy/Caddyfile` `:81`) and the
  static preview (`optional/static-preview/Caddyfile`) were narrowed from
  `GET, POST, PUT, DELETE, OPTIONS` to `GET, POST, OPTIONS`. This was **not**
  verified against a live browser artifact render (the dev session couldn't
  reach the loopback preview URLs). Low risk — the bundler is GET + `postMessage`
  — but **confirm by rendering a code artifact in the browser**. If the preview
  panel is blank with a CORS error in the console, restore `PUT, DELETE` on both
  Caddyfiles (one line each). See the troubleshooting note above.
- Remaining known constraints (accepted for now):
  - `code-interpreter-api` still needs `SYS_ADMIN` + `apparmor:unconfined` for current nsjail runtime.
  - Localhost ingress proxies remain dual-homed with `ingress` because host port publishing fails when attached only to internal networks in this Docker/Colima setup.
  - Search egress is intentionally auditable-not-allowlisted (to preserve SearX/Firecrawl web fetch behavior).
