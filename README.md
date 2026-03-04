# LibreChat Stack Deployment Guide

This guide provides instructions for setting up and running the LibreChat stack locally, with a focus on a more secure deployment on Apple Silicon. At the moment and in this default configuration, this stack uses Google VertexAI subscription in its configuration due to their generous USD 300 credit.

This project is licensed under the Apache 2.0 License. See the [LICENSE](LICENSE) files for details.

## 1. Prerequisites

Before you begin, ensure you have the following installed:
- Docker CLI (`docker` + `docker compose`)
- For macOS users: [Homebrew](https://brew.sh/)
- For macOS on Apple Silicon: [Colima][1]
- Optional (only if you want local HTTPS for preview): `mkcert` and `nss`


## 2. Initial Setup

### a. Secure Setup for Apple Silicon (M-series Macs)

For a secure setup on Apple Silicon, I recommend using Colima with Apple’s Virtualization.framework (`vz`). This allows you to run different Docker stacks on isolated VMs.

1.  **Start Colima with `vz`:**
    This creates a persistent profile running on Apple's native VM layer.

    ```bash
    colima start -p aiarm --vm-type=vz --cpu 4 --memory 8 --disk 50
    docker context ls
    docker context use colima-aiarm
    ```
    *(Note: On macOS ≥13, recent Colima versions support the `--vz` shorthand.)*

2.  **Enable user-namespace remapping:**
    This maps "root in the container" to an unprivileged user in the VM, enhancing security.

    ```bash
    colima ssh -p aiarm
    echo '{ "userns-remap": "default" }' | sudo tee /etc/docker/daemon.json
    echo 'dockremap:165536:65536' | sudo tee -a /etc/subuid /etc/subgid
    sudo systemctl restart docker || sudo service docker restart
    exit
    ```

### b. Environment Configuration

The application stack is configured using an environment file.

1.  **Create the `.env` file:**
    Copy the template to create your local configuration file.
    ```bash
    cp template_dot_env .env
    ```

2.  **Configure variables in `.env`:**
    Open `.env` and set the required variables.  

## 3. Running the Stack

With the configuration in place, you can now start the services.

1.  **Run the helper script (recommended):**
    This starts the Colima profile if needed, switches Docker context, and starts the Compose stack.
    ```bash
    chmod +x ./scripts/start_stack.sh
    ./scripts/start_stack.sh
    ```

2.  **Or run manually: ensure your Docker context is correct:**
    ```bash
    docker context use colima-aiarm
    ```

3.  **Start the services (manual path):**
    ```bash
    docker compose \
      --env-file .env \
      -f docker-compose.yml \
      -f compose.hardening.yml \
      up -d
    ```

4.  **Check running services:**
    To see the published ports for the services:
    ```bash
    docker compose ps --format '{{.Service}} -> {{range .Publishers}}{{.PublishedPort}}{{end}}'
    ```

### Default Egress Hardening (Squid Allowlist)

This stack now includes an internal `egress-proxy` service (`ubuntu/squid`) and routes `api` + `rag_api` outbound HTTP(S) through it.

- Allowlist file: `optional/egress-proxy/allowed_domains.txt`
- Squid policy: `optional/egress-proxy/squid.conf`
- Proxy URL used by app services: `EGRESS_PROXY_URL` (default `http://egress-proxy:3128`)

If a model/tool path tries to call a non-allowlisted external domain, Squid denies it.

### Keep Stack Alive Across macOS Reboots

Install a LaunchAgent so the stack automatically comes back on login/reboot:

```bash
# optional: pick the Colima context/profile the LaunchAgent should use
docker context use colima-<your-profile>

chmod +x ./scripts/install_autostart_launchagent.sh
./scripts/install_autostart_launchagent.sh
```

This runs `scripts/start_stack.sh` at login and writes logs to:

```bash
~/Library/Logs/librechat-stack-autostart.log
```

## 4. Post-Installation

### Create an Admin User

After the stack is running, create the first user, who will have admin privileges.
```bash
docker compose -f docker-compose.yml -f compose.hardening.yml exec api npm run create-user
```

## 5. Advanced Configuration

### OpenRouter Free Search Preset

This stack now exposes an OpenRouter free preset for search-heavy chats without removing the existing OpenCode presets:

1.  **Set your OpenRouter key only in local `.env`:**
    ```bash
    OPENROUTER_API_KEY=<your-openrouter-key>
    ```

2.  **Start the hardened stack:**
    ```bash
    docker compose \
      --env-file .env \
      -f docker-compose.yml \
      -f compose.hardening.yml \
      up -d
    ```

3.  **Open LibreChat and select the preset when you want it:**
    - `Trinity Large Free (OpenRouter)`
    - existing OpenCode presets stay available: `MiniMax M2.5 Free (OpenCode Zen)`, `Big Pickle (OpenCode Zen)`

Notes:
- The OpenRouter endpoint is configured as a LibreChat custom OpenAI-compatible endpoint at `https://openrouter.ai/api/v1`.
- The preset now uses `arcee-ai/trinity-large-preview:free`, which I validated live against your current OpenRouter key on March 4, 2026 with a minimal completion request returning `200`.
- The real OpenRouter key should stay in local `.env` only. Do not commit it.
- Paid OpenRouter models still require credits on that OpenRouter account. This free preset avoids that requirement, but OpenRouter free pools can still be temporarily rate-limited upstream.

### OpenCode Zen Free Test Profiles

If you want to test this stack against OpenCode Zen free models:

1.  **Use the generated local config files:**
    - `.env` (contains OpenAI endpoint wiring for Zen plus optional OpenRouter key)
    - `librechat.yaml` (OpenCode stays the default, with OpenRouter added as a selectable preset)

2.  **Use either a real OpenCode key or `public` in `.env`:**
    ```bash
    OPENAI_API_KEY=public
    ```
    If you have your own Zen key, replace `public` with that key.

3.  **Verify these values in `.env`:**
    ```bash
    ENDPOINTS=openAI,agents
    OPENAI_MODELS=minimax-m2.5-free,big-pickle
    OPENAI_REVERSE_PROXY=https://opencode.ai/zen/v1
    ```

4.  **Start hardened stack:**
    ```bash
    docker compose \
      --env-file .env \
      -f docker-compose.yml \
      -f compose.hardening.yml \
      up -d
    ```

5.  **Open LibreChat and select an OpenCode preset if needed:**
    - `MiniMax M2.5 Free (OpenCode Zen)`
    - `Big Pickle (OpenCode Zen)`

Notes:
- OpenCode documents free models on Zen's OpenAI-compatible endpoint, so in LibreChat we set the base URL to `https://opencode.ai/zen/v1`.
- OpenCode presets remain available, but they are no longer the default because the shared `public` key can be exhausted upstream.
- The shared `public` key can still return provider-side free-tier rate limits. If you hit `Rate limit exceeded. Please try again later.`, switch to your own OpenCode key in `.env` for stable testing.
- `agents` must be present in `ENDPOINTS` if you want saved Agents, tool-enabled agent chats, or LibreCodeInterpreter integration through the Agent builder.

### Optional: Enable LibreCodeInterpreter (`execute_code`)

This stack can run a self-hosted Code Interpreter backend that is compatible with LibreChat's `execute_code` tool. The integration is pinned to the `LibreCodeInterpreter` `dev` branch commit `31c1d5e90f735fb74968a6f61c2dc51c6e76de24`.

On this Colima-based hardened setup, the upstream pre-warmed Python REPL pool does not come up reliably. The overlay therefore disables `REPL_ENABLED` and `SANDBOX_POOL_ENABLED` by default so Python falls back to one-shot nsjail execution, which is slower but stable. The overlay also recreates `/app/ssl` and `/tmp/empty_proc` on startup because upstream nsjail bind mounts still expect those paths to exist, and the hardened tmpfs layout would otherwise remove them.

1.  **Set the local API key in `.env`:**
    ```bash
    LIBRECHAT_CODE_API_KEY=<strong-local-secret>
    ```

2.  **Start the stack with the optional compose overlay:**
    ```bash
    ENABLE_CODE_INTERPRETER=1 ./scripts/start_stack.sh
    ```

3.  **Manual compose path:**
    ```bash
    ./scripts/prepare_code_interpreter_image.sh

    docker-compose \
      --env-file .env \
      -f docker-compose.yml \
      -f compose.hardening.yml \
      -f optional/code-interpreter/compose.yml \
      up -d
    ```

4.  **Check the interpreter directly from macOS:**
    ```bash
    curl -fsS http://127.0.0.1:8001/health
    ```

5.  **Use it from LibreChat:**
    Create or edit an Agent and enable `Code Interpreter`. LibreChat will call the internal backend at `http://code-interpreter-api:8000`.

Notes:
- Saved Agents need `endpoints.agents.capabilities` in `librechat.yaml` to include at least `tools`, `execute_code`, and `artifacts`. If you define an `agents` block without capabilities, LibreChat treats those capabilities as disabled.
- The interpreter container needs `SYS_ADMIN` because `nsjail` creates the execution sandbox.
- The helper script caches the upstream checkout under `~/Library/Caches/librechat-stack/` and strips BuildKit-only cache mounts automatically when `buildx` is unavailable.
- Runtime traffic for the interpreter stays on the internal `lan` network; it is not granted general WAN egress.
- The `api` container intentionally uses `HTTP_PROXY`/`HTTPS_PROXY` without exporting `PROXY`. This keeps OpenCode/Vertex traffic on the Squid allowlist while preventing LibreChat's `execute_code` tool from trying to proxy internal calls to `code-interpreter-api`.
- MinIO's last published container release is pinned here because MinIO community images moved to source-only distribution in late 2025.

### Optional: Enable Local Web Search

This stack can expose LibreChat's built-in web search using:
- official `searxng/searxng`
- an in-stack Firecrawl API pinned to the same image set already validated on this machine
- a local Jina-compatible reranker API based on `freshe/librechat-jina-reranker-api`

1.  **Start the stack with local search enabled:**
    ```bash
    ENABLE_LOCAL_SEARCH=1 ./scripts/start_stack.sh
    ```

2.  **Manual compose path:**
    ```bash
    ./scripts/prepare_jina_reranker_image.sh

    docker-compose \
      --env-file .env \
      -f docker-compose.yml \
      -f compose.hardening.yml \
      -f optional/local-search/compose.yml \
      up -d
    ```

3.  **Run the local smoke test:**
    ```bash
    chmod +x ./scripts/smoke_local_search.sh
    ./scripts/smoke_local_search.sh
    ```

4.  **Use it in LibreChat:**
    Web search is enabled in `librechat.yaml`, so in the UI you only need to turn on the search tool for the conversation/agent that should browse.

Notes:
- Firecrawl now runs inside this stack instead of depending on a separate host service.
- The Firecrawl API is internal-only by default; LibreChat reaches it at `http://firecrawl-api:3002`.
- The local-search overlay keeps `jina-reranker`, `searxng-valkey`, `firecrawl-redis`, `firecrawl-rabbitmq`, and `firecrawl-postgres` off the WAN entirely. Only `searxng`, `firecrawl-api`, and `firecrawl-playwright` keep outbound internet because they need it to fetch search results and pages.
- The Firecrawl API and Playwright scraper are isolated on the dedicated `search` network and tuned down to lower CPU/RAM spikes on this machine.
- `optional/local-search/searxng/settings.yml` enables JSON output, which LibreChat requires for SearXNG integration.
- The SearXNG override removes the noisy `ahmia`, `google`, and `torch` engines and lowers outbound engine timeout to `4s`, which cuts startup noise and reduces wasted retries.
- SearXNG rate limiting is enabled with a local Valkey backend and a small allowlist for local/private source IPs so LibreChat can query it without tripping bot detection.
- The local Jina service includes a compatibility patch so LibreChat's rerank requests work even when `batch_size` is omitted, and defaults to the much smaller `jinaai/jina-reranker-v1-tiny-en` model to avoid the earlier multi-GB footprint.
- The helper bakes the Jina model into the image, and the compose overlay uses a dedicated cache volume so the runtime container can stay off the WAN after the first image build.
- After editing files under `optional/local-search/jina/`, recreate `jina-reranker` so the mounted compatibility patch is reloaded.
- The local-search overlay also mounts a small LibreChat search patch that keeps web-search context bounded by default:
  - scrape `markdown` only
  - request `onlyMainContent`
  - default to `3` search results, `2` scraped sources, and `2` highlights per source
  - cap per-page scraped text before reranking
  - strip bulky raw page `content` from the search artifact returned to the model
- CI now exercises the local-search overlay as part of `.github/workflows/stack-smoke.yml`, including a real search-tool smoke run.
- The size caps can be adjusted with:
  - `LIBRECHAT_WEB_SEARCH_RESULT_COUNT`
  - `LIBRECHAT_WEB_SEARCH_MAX_SOURCES`
  - `LIBRECHAT_WEB_SEARCH_HIGHLIGHT_COUNT`
  - `LIBRECHAT_WEB_SEARCH_SOURCE_CHAR_LIMIT`
  - `LIBRECHAT_WEB_SEARCH_SNIPPET_CHAR_LIMIT`
  - `LIBRECHAT_WEB_SEARCH_HIGHLIGHT_CHAR_LIMIT`

### Explicit Stack Profiles

`scripts/start_stack.sh` now supports named profiles so you do not have to remember each overlay combination.

- `STACK_PROFILE=local-only`: base hardened LibreChat stack only
- `STACK_PROFILE=local-code`: base stack plus LibreCodeInterpreter
- `STACK_PROFILE=local-search`: base stack plus local web search
- `STACK_PROFILE=local-search-code`: base stack plus local web search and LibreCodeInterpreter
- `STACK_PROFILE=full`: base stack plus local web search, LibreCodeInterpreter, and static preview

Examples:

```bash
STACK_PROFILE=local-only ./scripts/start_stack.sh
STACK_PROFILE=local-search ./scripts/start_stack.sh
STACK_PROFILE=local-search-code ./scripts/start_stack.sh
STACK_PROFILE=full ./scripts/start_stack.sh
```

If `STACK_PROFILE` is unset, the script still honors the existing `ENABLE_STATIC_PREVIEW`, `ENABLE_CODE_INTERPRETER`, and `ENABLE_LOCAL_SEARCH` flags.

### Dependency Updates

This repo now includes self-hosted Renovate automation:

- [renovate.json](/Users/flow/librechat-stack-main/renovate.json) targets update PRs at the `dev` branch
- [.github/workflows/renovate.yml](/Users/flow/librechat-stack-main/.github/workflows/renovate.yml) runs weekly and on manual dispatch for real update PRs
- pushes to `dev` that touch the Renovate config/workflow run Renovate in `dry-run` mode so you can test the automation safely on the dev branch
- real update PR creation requires a `RENOVATE_TOKEN` repository secret with `repo` and `workflow` scopes, matching Renovate's GitHub self-hosting guidance

`Stack Smoke` also now triggers on `dev` pushes and PRs in addition to `main`.

### Optional: Enable Static Preview Server

If you need to use the static preview server for artifacts, you can enable it by including its dedicated compose file. The default setup exposes the preview server directly on localhost HTTP, so no local certificate import is required.

1.  **Prerequisites:**
    No extra TLS setup is needed for the default local test path.

2.  **Start the stack with the static preview service:**
    Add the `-f optional/static-preview/compose.yml` flag to your `docker compose up` command:

    ```bash
    docker compose \
      --env-file .env \
      -f docker-compose.yml \
      -f compose.hardening.yml \
      -f optional/static-preview/compose.yml \
      up -d
    ```

3. **(Optional) Override the preview URL explicitly in `.env`:**

   ```bash
   SANDPACK_STATIC_BUNDLER_URL=http://127.0.0.1:4324
   ```

**LAN exposure note:** the current defaults are localhost-only (`127.0.0.1`) for both LibreChat and static preview.
If you expose on your local network, update host bindings and set `SANDPACK_STATIC_BUNDLER_URL`, `DOMAIN_CLIENT`, and `DOMAIN_SERVER`
to your LAN URL/IP (not `127.0.0.1`), and restrict CORS to your intended origin(s).

## 6. Troubleshooting & Verification

### Quick Checks

-   **Verify variables are set in `.env`:**
    ```bash
    grep -E '^(PORT|UID|GID|MEILI_MASTER_KEY|RAG_PORT)=' .env
    ```

-   **Preview the resolved Docker Compose configuration:**
    This helps confirm that your `.env` variables are being loaded correctly. You should not see any warnings about missing variables.
    ```bash
    docker compose --env-file .env config | sed -n '1,60p'
    ```
    If you still see warnings, it means `.env` isn’t being picked up—double-check the path and that you passed `--env-file .env`.

-   **If services look "gone" after reboot:**
    usually the Colima VM is stopped or Docker context changed.
    ```bash
    colima list
    docker context ls
    docker context use colima-aiarm
    ./scripts/start_stack.sh
    ```

-   **Verify egress policy from inside API container:**
    `opencode.ai` should be allowed and `example.com` should be denied.
    ```bash
    docker exec LibreChat node -e "const net=require('net');const test=(h)=>new Promise(r=>{const s=net.createConnection({host:'egress-proxy',port:3128},()=>s.write('CONNECT '+h+':443 HTTP/1.1\\r\\nHost: '+h+':443\\r\\n\\r\\n'));let d='';s.on('data',c=>{d+=c.toString();if(d.includes('\\r\\n')){console.log(h,d.split('\\r\\n')[0]);s.destroy();r();}});});(async()=>{await test('opencode.ai');await test('example.com');})();"
    ```

### Log Debugging

Use these commands when debugging startup, auth, model calls, or egress policy:

```bash
# Stack status
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'

# Main app logs
docker logs -f --tail=200 LibreChat

# RAG API logs
docker logs -f --tail=200 rag_api

# Squid startup/runtime logs
docker logs -f --tail=200 egress-proxy

# Squid allow/deny decisions
docker exec -u proxy egress-proxy sh -lc 'tail -f /var/log/squid/access.log'

# Local search service logs
docker logs -f --tail=200 searxng
docker logs -f --tail=200 searxng-valkey
docker logs -f --tail=200 jina-reranker
docker logs -f --tail=200 firecrawl-api
docker logs -f --tail=200 firecrawl-playwright
```

In Squid access logs:
- `TCP_TUNNEL/200` means allowed
- `TCP_DENIED/403` means blocked by allowlist

## 7. Volume backup procedure.

For backup procedure, see [`backup/README.md`](backup/README.md).

## Acknowledgements

The foundation of this Docker Compose stack was adapted from the work of [nicedexter](https://github.com/nicedexter). His original setup provided a great starting point for this.


## TODO

- Consider adding https://github.com/martvaha/code-interpreter and https://github.com/Fritsl/LibreChatConfigurator
- Renovate and CI

[1]: https://github.com/abiosoft/colima "GitHub - abiosoft/colima: Container runtimes on macOS (and Linux) with minimal setup"
