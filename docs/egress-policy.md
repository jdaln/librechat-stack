# Egress Policy (live state)

Concise, live-verified summary of which containers can reach the internet and
under what rules. Source of truth: `optional/egress-proxy/squid.conf` +
`optional/egress-proxy/allowed_domains.txt`.

## Per-container capability

| Container               | Direct WAN | Path to Squid | Squid policy applied                       |
|-------------------------|:----------:|:-------------:|--------------------------------------------|
| `egress-proxy`          | ✅          | n/a           | (it *is* Squid)                            |
| `LibreChat` (api)       | ❌          | ✅             | **Allowlist** (LAN policy)                 |
| `rag_api`               | ❌          | ✅             | **Allowlist** (LAN policy)                 |
| `chat-mongodb`          | ❌          | ✅             | **Allowlist** (LAN policy) — unused        |
| `chat-meilisearch`      | ❌          | ✅             | **Allowlist** (LAN policy) — unused        |
| `vectordb`              | ❌          | ✅             | **Allowlist** (LAN policy) — unused        |
| `embeddings`            | ❌          | ✅             | **Allowlist** (LAN policy) — unused, model is baked into the image at build time |
| `ollama-proxy`          | ✅ (host only) | ✅          | **Bridge to host** — see *Ollama bridge* note below |
| `searxng`               | ❌          | ✅             | **Broad** (search_egress policy)           |
| `firecrawl-api`         | ❌          | ✅             | **Broad** (search_egress policy)           |
| `firecrawl-playwright`  | ❌          | ✅             | **Broad** (search_egress policy)           |
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
"unused" means the database containers *could* reach Squid by network topology
but don't initiate outbound traffic in normal operation.

## What "Allowlist (LAN policy)" allows

These rules apply to every client on `lan` (the LibreChat app, rag_api, the
databases). They run *after* the universal deny rules (RFC1918, link-local,
multicast, `localhost` / `.local` / `.internal`).

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
- **`ollama_egress`** (new, narrow bridge) — gives the container an IP
  route to `host.docker.internal` (the Colima/Docker host gateway) so it
  can reverse-proxy LibreChat's request to the host's Ollama daemon at
  `127.0.0.1:11434`. NAT/masquerade is enabled on this bridge because
  outbound packets to the host gateway need their source rewritten.

This means **`ollama-proxy` can technically reach the public internet**
(masquerade is on), bypassing Squid. Three mitigations preserve the
overall posture:

1. **Only `ollama-proxy` is on `ollama_egress`** — asserted in the
   smoke. No other container ever sees this bridge.
2. **`ollama-proxy` is `read_only: true`, `cap_drop: ALL`** — same
   hardening as every other proxy in the stack. There's no shell or
   write target inside.
3. **The Caddyfile has one upstream** — `http://host.docker.internal:11434`.
   No dynamic destinations, no path that fans out elsewhere.

Net: a compromised LibreChat or `ollama-proxy` would have to break out
of the read-only container AND rewrite Caddy's config in memory to
exfiltrate via this path. The cost-to-benefit of keeping ollama-proxy
on a wide-open bridge is high (every other path remains as before), so
we accept this single-container exception.

## Verifying live

From any container with `bash` (uses `/dev/tcp` builtin):

```bash
docker exec LibreChat bash -c '
  for h in opencode.ai example.com; do
    exec 3<>/dev/tcp/egress-proxy/3128
    printf "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n" "$h" "$h" >&3
    read -t 5 line <&3
    echo "$h -> $line"
    exec 3<&- 3>&-
  done
'
# Expected: opencode.ai -> 200 Connection established
#           example.com -> 403 Forbidden
```

Swap `LibreChat` for `searxng` to see the broad policy: both return `200`.

## Changing the allowlist

Edit `optional/egress-proxy/allowed_domains.txt`, then:

```bash
docker-compose -f docker-compose.yml -f compose.hardening.yml \
  restart egress-proxy
```

(No image rebuild needed — Squid reads the file from the secrets volume.)
