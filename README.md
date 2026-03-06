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

After the stack is up, create the first admin user:

```bash
docker compose -f docker-compose.yml -f compose.hardening.yml \
  exec api npm run create-user
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

The `api` and `rag_api` containers have no direct internet access. All their outbound HTTP(S) goes through an internal Squid proxy that only allows domains listed in `optional/egress-proxy/allowed_domains.txt`.

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

When the local-search overlay is enabled, SearXNG/Firecrawl egress is routed through Squid with full access logging. By design this path is auditable but not domain-allowlisted, so the stack can scrape arbitrary result domains.

---

## Model Presets

Three presets ship in `librechat.yaml`:

| Preset | Provider | Model | Key |
|--------|----------|-------|-----|
| MiniMax M2.5 Free | OpenCode Zen | `minimax-m2.5-free` | `public` or own |
| Big Pickle | OpenCode Zen | `big-pickle` | `public` or own |
| Trinity Large Free | OpenRouter | `arcee-ai/trinity-large-preview:free` | `OPENROUTER_API_KEY` |

**OpenCode Zen** is the default. Set `OPENAI_API_KEY=public` in `.env` to use the shared free key, or plug in your own for fewer rate limits.

**OpenRouter** needs a separate key:
```bash
OPENROUTER_API_KEY=<your-key>
```
The free tier doesn't require credits but can be rate-limited upstream.

Both providers are always selectable in the UI.

> Make sure `agents` is in `ENDPOINTS` (it is by default) if you want saved Agents and tool-enabled chats.

---

## Optional Overlays

Each overlay adds a `-f` compose file. Enable individually with env flags, or pick a named profile.

### Stack Profiles

```bash
STACK_PROFILE=local-only        ./scripts/start_stack.sh   # base only
STACK_PROFILE=local-code        ./scripts/start_stack.sh   # + code interpreter
STACK_PROFILE=local-search      ./scripts/start_stack.sh   # + web search
STACK_PROFILE=local-search-code ./scripts/start_stack.sh   # both
STACK_PROFILE=full              ./scripts/start_stack.sh   # everything incl. static preview
```

Without `STACK_PROFILE`, the script checks `ENABLE_CODE_INTERPRETER`, `ENABLE_LOCAL_SEARCH`, and `ENABLE_STATIC_PREVIEW` individually.

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

- Pinned to commit `31c1d5e` on the `dev` branch.
- The upstream pre-warmed REPL pool doesn't start reliably under Colima's hardened tmpfs layout, so `REPL_ENABLED` and `SANDBOX_POOL_ENABLED` are off. Python falls back to one-shot nsjail execution (slower, stable).
- The container needs `SYS_ADMIN` for nsjail.
- Interpreter traffic stays on the internal `lan` network — no WAN egress.
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
- Rate limiting uses Valkey with a private-IP allowlist so LibreChat doesn't trip bot detection.
- Firecrawl, its Redis, RabbitMQ, and Postgres sit on a dedicated `search` network. SearXNG + Firecrawl web-fetch traffic is routed through Squid on a dedicated `search_egress` subnet so requests are auditable in proxy logs.
- The Jina compatibility patch makes `batch_size` optional — LibreChat's client omits it.
- A mounted search patch caps scraped text, requests `markdown` + `onlyMainContent`, and strips raw `content` from the artifact returned to the model.
- After editing files under `optional/local-search/jina/`, recreate the container to pick up changes.

</details>

---

### Static Preview (Sandpack)

Local sandpack static bundler for artifact previews. Plain HTTP — no TLS setup needed.

```bash
ENABLE_STATIC_PREVIEW=1 ./scripts/start_stack.sh
```

Preview is at `http://127.0.0.1:4324`.
Set `SANDPACK_STATIC_BUNDLER_URL=http://preview.localhost:4324` in `.env` so relay hostnames like `id-preview.localhost` resolve correctly and keep Service Worker support on HTTP.

> **LAN note:** defaults are localhost-only. If you expose to your network, also update `DOMAIN_CLIENT`, `DOMAIN_SERVER`, and CORS origins.

---

## Autostart on Reboot

```bash
./scripts/install_autostart_launchagent.sh
```

Installs a macOS LaunchAgent that runs `start_stack.sh` at login. Logs: `~/Library/Logs/librechat-stack-autostart.log`.

---

## CI & Dependency Updates

- **Stack Smoke** (`.github/workflows/stack-smoke.yml`) runs on push/PR to `main` and `dev`. Tests egress policy, OpenCode reachability, code interpreter execution, agent tool flow, and local search end-to-end.
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
docker logs -f --tail=200 egress-proxy

# Squid logs all local-search egress (auditable) plus denied requests elsewhere.
# Look for TCP_DENIED/403 when debugging allowlist misses.
docker exec -u proxy egress-proxy sh -lc 'tail -f /var/log/squid/access.log'
```

---

## Backups

See [backup/README.md](backup/README.md).

## Acknowledgements

Compose foundation adapted from [nicedexter](https://github.com/nicedexter).

## TODO

- You tell me
