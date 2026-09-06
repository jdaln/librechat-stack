# LibreChat Stack

A hardened, self-hosted [LibreChat](https://www.librechat.ai/) deployment for Apple Silicon, with optional code execution, local web search, and egress-controlled networking.

All outbound traffic from the app goes through a Squid allowlist proxy, databases stay on internal-only networks, and every service runs with a read-only rootfs and dropped capabilities. The defaults target a single M-series Mac running [Colima][1].

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

> Every `docker compose` command below assumes the same base flags
> (`--env-file .env -f docker-compose.yml -f compose.hardening.yml`)
> plus any optional `-f` overlays; the helper script adds them for you.
> `compose.hardening.yml` is required — the overlays assume the core
> services run hardened. If you only have the legacy `docker-compose`
> binary (not the V2 plugin), substitute `docker-compose` for
> `docker compose` in every command.

After the stack is up, create the first admin user (`-w /app` is required):

```bash
docker compose -f docker-compose.yml -f compose.hardening.yml \
  exec -w /app api npm run create-user
```

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

The `api` and `rag_api` containers have no direct internet access. All their outbound HTTP(S) goes through an internal Squid proxy that only allows domains listed in `optional/egress-proxy/allowed_domains.txt`. If an LLM prompt injection tries to exfiltrate data to an unknown host, Squid blocks it. Databases sit on networks with no route to the proxy at all. Per-container rules and verification commands: [docs/egress-policy.md](docs/egress-policy.md).

Quick check:

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

To change which domains are permitted, edit the allowlist and restart the proxy.

With the local-search overlay enabled, SearXNG/Firecrawl egress also goes through Squid, but is logged rather than domain-allowlisted so search can scrape arbitrary public sites. Squid still denies local, private, link-local, reserved, and internal-name destinations.

---

## Model Presets

Presets ship in `librechat.yaml`. Upstream model names change over time — if a preset 404s, check `https://opencode.ai/zen/v1/models` and OpenRouter.

| Preset (default ★) | Provider | Model | Key |
|--------|----------|-------|-----|
| ★ Nemotron 3 Ultra Free | OpenCode Zen | `nemotron-3-ultra-free` | `public` (free) |
| DeepSeek V4 Flash Free | OpenCode Zen | `deepseek-v4-flash-free` | `public` (free) |
| Gemma 4 31B Free | OpenRouter | `google/gemma-4-31b-it:free` | `OPENROUTER_API_KEY` (free tier) |
| Claude Fable 5 | OpenCode Zen | `claude-fable-5` | real OpenCode key (paid) |

**OpenCode Zen** is the default. The shared `OPENAI_API_KEY=public` key can list models and run the free `*-free` models out of the box — **but premium models (`claude-*`, `gpt-5*`, `gemini-*`, …) return 401 with `public`**; set your own OpenCode key for those and for higher rate limits.

**OpenRouter** needs its own key (even a free one):
```bash
OPENROUTER_API_KEY=<your-key>
```
With `fetch: true`, a real key auto-populates the full OpenRouter model list in the UI. Free `*:free` models work but are rate-limited upstream (429s) and are weaker at agentic tool-calling.

Both providers are always selectable in the UI.

> Keep `agents` in `ENDPOINTS` (it is by default) if you want saved Agents and tool-enabled chats.

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

**All standard profiles assume Ollama is running on the host** — they enable the `ollama-proxy` bridge by default. If you only use remote inference (OpenCode Zen / OpenRouter / OpenAI / Anthropic / …) and have no host-side Ollama, use **`full-remote-inference`** — the only profile with `ollama` off.

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

`scripts/prepare_code_interpreter_image.sh` clones the upstream repo and caches the build under `~/Library/Caches/librechat-stack/`.

Before enabling:

- Set strong MinIO credentials in `.env` — the template values are placeholders.
- The container needs `SYS_ADMIN` for nsjail (see Known limitations).
- `librechat.yaml` must list `execute_code` in `endpoints.agents.capabilities` (it does by default).

---

### Local Web Search

Runs [SearXNG](https://github.com/searxng/searxng) + [Firecrawl](https://github.com/mendableai/firecrawl) + a [Jina reranker](https://github.com/freshe/librechat-jina-reranker-api) inside the stack. No external search API keys required.

```bash
ENABLE_LOCAL_SEARCH=1 ./scripts/start_stack.sh

# Smoke test
./scripts/smoke_local_search.sh
```

Web search is already wired in `librechat.yaml` — flip the search toggle on any conversation or Agent.

The Jina reranker image is built locally by `scripts/prepare_jina_reranker_image.sh` with the tiny `jina-reranker-v1-tiny-en` model baked in, so the container stays offline after the first build.

Search context is bounded by default (3 results, 2 scraped sources, 2 highlights) to keep model context reasonable. Tune with `LIBRECHAT_WEB_SEARCH_*` env vars.

Before enabling:

- Set a strong `SEARXNG_API_KEY` in `.env` — internal search calls are authenticated with it.
- Optional: set `BRAVE_API_KEY` to retry an empty or failed SearXNG response once via the Brave Search API.

When changing search config:

- After editing files under `optional/local-search/jina/`, recreate the container.
- After editing files under `optional/local-search/librechat-patches/`, rebuild the LibreChat image (`docker compose … build api`) and recreate `api` — the start script does not `--build`.

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

The default model is **`intfloat/multilingual-e5-large`** (1024-dim, multilingual). The first build downloads it from Hugging Face (~2.5GB); after that the container runs offline. CPU inference: ~10–20 docs/sec batch, sub-second per query on M-series. Override with `EMBEDDINGS_MODEL=<fastembed-supported-model>` and rebuild; raise `EMBEDDINGS_MAX_BATCH` (default 64) for large corpora.

With `ENABLE_EMBEDDINGS=1`, `RAG_OPENAI_BASEURL` points at the local container automatically — `.env` needs no embedding-provider config. The container sits on the `lan` network only, like the databases: no WAN egress, no path to Squid.

---

### Ollama bridge (local LLMs on the host)

If you run [Ollama](https://ollama.com/) on the host (e.g. the macOS native build with Metal acceleration), this overlay surfaces every model it has pulled inside LibreChat as the **`Ollama`** custom endpoint.

```bash
# Ensure ollama is running on the host first
ollama list           # should show your models
ENABLE_OLLAMA=1 ./scripts/start_stack.sh
```

The endpoint appears in the model picker; `fetch: true` populates the model list from whatever the host has pulled. The bridge is a small reverse proxy that forwards to the host's Ollama at `host.docker.internal:11434`; it is reachable only from inside the stack, so no API key is needed. The first request to a cold model can take 30s+ while it loads into RAM.

```bash
# Verify end-to-end (LibreChat → ollama-proxy → host → Ollama)
docker exec LibreChat python3 -c "
import urllib.request, json
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
print(json.loads(op.open('http://ollama-proxy:11434/v1/models', timeout=5).read())['data'])
"
```

---

### Static Preview (Sandpack)

Local sandpack static bundler for artifact previews. Plain HTTP — no TLS setup needed.

```bash
ENABLE_STATIC_PREVIEW=1 ./scripts/start_stack.sh
```

Preview is at `http://127.0.0.1:4324`.
Set `SANDPACK_STATIC_BUNDLER_URL=http://preview.localhost:4324` in `.env` so relay hostnames like `id-preview.localhost` resolve correctly and Service Worker support stays on HTTP.
The dynamic Sandpack bundler URL stays `http://127.0.0.1:80`, served through `api-proxy`.

> **LAN note:** defaults are localhost-only. If you expose to your network, also update `DOMAIN_CLIENT`, `DOMAIN_SERVER`, and CORS origins.

---

## Stopping the stack

```bash
./scripts/stop_stack.sh                       # default: full shutdown (containers + Colima VM)
./scripts/stop_stack.sh --pause               # quick pause, VM stays up (fastest restart)
./scripts/stop_stack.sh --keep-colima         # remove containers but keep the VM running
```

**Your data is preserved in every mode** — named volumes (chat history, RAG vectors, uploads, search indexes, runtime secrets) stay on disk and are picked up on the next `start_stack.sh`.

| Mode | Command | What happens | Host RAM | Restart speed |
|---|---|---|---|---|
| **`down` + colima stop** *(default)* | `./scripts/stop_stack.sh` | Containers + networks removed AND Colima VM stopped. | All freed | Full bring-up, ~40-60s |
| **`down`, keep VM** | `./scripts/stop_stack.sh --keep-colima` | Containers + networks removed; Colima VM keeps its allocated RAM. | Most freed | ~30s |
| **`pause`** | `./scripts/stop_stack.sh --pause` | Containers stopped but kept around; VM stays up (implicit). | Mostly held | ~5s |

The script has no volume-wiping flag on purpose. To start fresh:

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
- Local runs of `scripts/ci/smoke.sh` keep volumes by default (`SMOKE_CLEAN_VOLUMES=0`) so chat history persists. Set `SMOKE_CLEAN_VOLUMES=1` for a full data reset.
- **Renovate** ([renovate.json](renovate.json)) runs weekly targeting `dev`. Needs a `RENOVATE_TOKEN` repo secret (`repo` + `workflow` scopes) for real PRs.

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
# The stack disables LibreChat's bundled service worker by default.
# One-time cleanup: clear site data for localhost in the browser and reload.
# Also verify:
#   SANDPACK_BUNDLER_URL=http://127.0.0.1:80
#   SANDPACK_STATIC_BUNDLER_URL=http://preview.localhost:4324
#
# If the console shows a CORS "method not allowed" error for 127.0.0.1:80 or
# preview.localhost:4324, restore "GET, POST, PUT, DELETE, OPTIONS" in
# optional/api-proxy/Caddyfile (:81) and optional/static-preview/Caddyfile,
# then re-run the populate script and restart api-proxy.
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

## Known limitations

- `code-interpreter-api` needs `SYS_ADMIN` + `apparmor:unconfined` for the current nsjail runtime.
- The localhost ingress proxies are attached to a non-internal `ingress` bridge, because host port publishing fails in this Docker/Colima setup when a container sits only on internal networks. The bridge has IP masquerading disabled, so it grants no useful outbound access.
- Search egress is auditable but not domain-allowlisted, to preserve SearXNG/Firecrawl web fetching.

## Acknowledgements

Compose foundation adapted from [nicedexter](https://github.com/nicedexter).

[1]: https://github.com/abiosoft/colima
