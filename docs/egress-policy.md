# Egress Policy

Which containers can reach the internet, and under what rules. Source of
truth: `optional/egress-proxy/squid.conf` +
`optional/egress-proxy/allowed_domains.txt`.

## Per-container capability

| Container               | Direct WAN | Path to Squid | Squid policy applied                       |
|-------------------------|:----------:|:-------------:|--------------------------------------------|
| `egress-proxy`          | ✅          | n/a           | (it *is* Squid)                            |
| `LibreChat` (api)       | ❌          | ✅ (`api_egress`) | **Allowlist** (LAN policy)              |
| `rag_api`               | ❌          | ✅ (`api_egress`) | **Allowlist** (LAN policy)              |
| `chat-mongodb`          | ❌          | ❌             | Isolated (lan only — no path to proxy)     |
| `chat-meilisearch`      | ❌          | ❌             | Isolated (lan only — no path to proxy)     |
| `vectordb`              | ❌          | ❌             | Isolated (lan only — no path to proxy)     |
| `embeddings`            | ❌          | ❌             | Isolated (lan only; model baked in at build time) |
| `ollama-proxy`          | ✅ (host only) | ❌          | **Bridge to host** — see *Ollama bridge* note below |
| `searxng`               | ❌          | ✅ (`search_egress`) | **Broad** (search_egress policy)     |
| `firecrawl-api`         | ❌          | ✅ (`search_egress`) | **Broad** (search_egress policy)     |
| `firecrawl-playwright`  | ❌          | ✅ (`search_egress`) | **Broad** (search_egress policy)     |
| `api-proxy`             | ❌          | ❌             | Isolated                                   |
| `caddy-static-proxy`    | ❌          | ❌             | Isolated                                   |
| `code-interpreter-api`  | ❌          | ❌             | Isolated                                   |
| `code-interpreter-minio`| ❌          | ❌             | Isolated                                   |
| `code-interpreter-proxy`| ❌          | ❌             | Isolated                                   |
| `code-interpreter-redis`| ❌          | ❌             | Isolated                                   |
| `firecrawl-postgres`    | ❌          | ❌             | Isolated                                   |
| `firecrawl-rabbitmq`    | ❌          | ❌             | Isolated                                   |
| `firecrawl-redis`       | ❌          | ❌             | Isolated                                   |
| `jina-reranker`         | ❌          | ❌             | Isolated                                   |
| `sandpack-bundler`      | ❌          | ❌             | Isolated                                   |
| `sandpack-static`       | ❌          | ❌             | Isolated                                   |
| `searxng-auth-proxy`    | ❌          | ❌             | Isolated                                   |
| `searxng-valkey`        | ❌          | ❌             | Isolated                                   |

"Path to Squid" = the container is on a network that includes `egress-proxy`.

**The proxy is deliberately kept off `lan`.** `egress-proxy` attaches only to
`wan` (its sole internet leg), `api_egress` (where `api` + `rag_api` reach it),
and `search_egress` (the search tier). The data stores — `chat-mongodb`,
`chat-meilisearch`, `vectordb`, `embeddings` — live on `lan` *only*, which has
no path to the proxy. A compromised data store cannot use Squid as an egress
relay: there is no network route to it. This is enforced in CI
(`scripts/ci/smoke.sh` asserts `egress-proxy` is absent from `lan` and that
`api_egress` is `internal`).

## What "Allowlist (LAN policy)" allows

These rules apply to the clients that can reach the proxy on `api_egress` —
`LibreChat` (api) and `rag_api`. They run *after* the universal deny rules
(RFC1918, link-local, multicast, `localhost` / `.local` / `.internal`).

Exact domains in `optional/egress-proxy/allowed_domains.txt`:

| Pattern                                | What it covers                                   |
|----------------------------------------|--------------------------------------------------|
| `.opencode.ai`                         | OpenCode Zen + all subdomains                    |
| `.openai.com`                          | OpenAI API + all subdomains                      |
| `.anthropic.com`                       | Anthropic API + all subdomains                   |
| `.openrouter.ai`                       | OpenRouter + all subdomains                      |
| `aiplatform.googleapis.com`            | Vertex AI global endpoint                        |
| `*-aiplatform.googleapis.com` (regex)  | Vertex AI regional endpoints (e.g. `us-central1-…`) |
| `generativelanguage.googleapis.com`    | Gemini (AI Studio)                               |
| `oauth2.googleapis.com`                | Google OAuth token exchange                      |
| `iamcredentials.googleapis.com`        | GCP service-account credentials                  |
| `sts.googleapis.com`                   | GCP Security Token Service                       |

Anything not in that list is `403 Forbidden`.

## What "Broad (search_egress policy)" allows

Applies to clients on the `search_egress` subnet (`172.31.33.0/24` — i.e.
`searxng`, `firecrawl-api`, `firecrawl-playwright`). Squid rule:

```
acl search_clients src 172.31.33.0/24
http_access allow search_clients
```

Effect: **any public destination is allowed** — by design, so scraping works
against arbitrary result domains. The universal deny rules still apply:

| Denied for everyone, including search_egress                                                          |
|-------------------------------------------------------------------------------------------------------|
| RFC1918 (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`), link-local (`169.254/16`, `fe80::/10`) |
| Carrier-grade NAT (`100.64/10`), TEST-NET (`192.0.2/24`, `198.51.100/24`, `203.0.113/24`)              |
| Multicast (`224/4`), reserved (`240/4`), IPv6 ULA (`fc00::/7`)                                         |
| `localhost`, `.local`, `.internal` (domain ACL)                                                       |
| Non-SSL ports for `CONNECT`; non-Safe ports for everything else                                       |
| Everything logs to stdout — auditable in `docker logs egress-proxy`                                   |

So `searxng` can scrape e.g. `https://news.ycombinator.com`, but cannot use
the proxy to reach `192.168.1.1` or `localhost` on the host.

## Ollama bridge

The `ollama-proxy` container (enabled by `ENABLE_OLLAMA=1`) is the one
exception to "everything internal is on `lan` or isolated". It lives on
two networks:

- **`lan`** — so LibreChat (which never leaves `lan`) can reach it like
  any other in-stack service: `http://ollama-proxy:11434/v1`.
- **`ollama_egress`** (narrow bridge) — gives the container an IP route to
  `host.docker.internal` (the Colima/Docker host gateway) so it can
  reverse-proxy LibreChat's requests to the host's Ollama daemon at
  `127.0.0.1:11434`. NAT/masquerade is enabled on this bridge because
  outbound packets to the host gateway need their source rewritten.

Because masquerade is on, **`ollama-proxy` can technically reach the public
internet**, bypassing Squid. Mitigations:

- Only `ollama-proxy` is on `ollama_egress` (asserted in the smoke test).
- The container is `read_only: true`, `cap_drop: ALL` — no shell, no write target.
- Its Caddyfile has one fixed upstream: `http://host.docker.internal:11434`.

Exfiltrating via this path would require breaking out of the read-only
container and rewriting Caddy's config in memory; this single-container
exception is accepted.

## Verifying live

The GA LibreChat image ships no `bash`/`curl`, but it has `python3`. This
runs a CONNECT through the proxy from the `api` container (which reaches it
via `api_egress`):

```bash
docker exec LibreChat python3 -c '
import socket
def connect(host):
    s = socket.create_connection(("egress-proxy", 3128), timeout=6)
    s.sendall(f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n".encode())
    line = s.recv(120).decode(errors="replace").split("\r\n")[0]; s.close(); return line
for h in ["opencode.ai", "example.com"]:
    print(f"{h} -> {connect(h)}")
'
# Expected: opencode.ai -> HTTP/1.1 200 Connection established
#           example.com -> HTTP/1.1 403 Forbidden
```

To confirm the **isolation** (a data store has no path to the proxy), the
connect should hang/fail rather than reach Squid — `chat-mongodb` has bash:

```bash
docker exec chat-mongodb bash -c \
  'timeout 5 bash -c "exec 3<>/dev/tcp/egress-proxy/3128" && echo REACHABLE || echo BLOCKED'
# Expected: BLOCKED
```

Swap `LibreChat` for `searxng` to see the broad policy: both return `200`.

## Changing the allowlist

Edit `optional/egress-proxy/allowed_domains.txt`, then:

```bash
docker compose -f docker-compose.yml -f compose.hardening.yml \
  restart egress-proxy
```

(No image rebuild needed — Squid reads the file from the secrets volume.)
