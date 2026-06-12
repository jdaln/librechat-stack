# Improvement Suggestions — librechat-stack

Full project review, 2026-06-12. Scope: root compose files, hardening overlay, `optional/` overlays,
`scripts/` (start, secrets, prepare, smoke), `.github/workflows/`, `renovate.json`, backup tooling, docs.

> **Status (2026-06-12): all findings below have been implemented and verified** on a live stack
> (commits `7459575..3f81882` on `dev`). Notable deltas discovered during implementation:
> the code interpreter additionally needs `SETPCAP` (nsjail child capability drop); squid cannot
> write to `/dev/stdout` after dropping privileges, so the audit log reaches `docker logs` via an
> entrypoint-owned fifo; and the web-search config assertion requires an authenticated
> `/api/config` request. This document is kept as the review record.

Findings are grouped by theme and tagged **[HIGH]** / **[MED]** by value (impact × likelihood, weighted by
how cheap the fix is). A suggested execution order is at the end.

**What's already done well** (verified, no action needed): the no-masquerade `ingress` bridge pattern,
Squid SSRF protections (private/link-local/reserved ACLs evaluated before the search allow), the
searxng auth-proxy isolating unauthenticated SearXNG, Mongo credentials via secret files instead of
compose env, digest pinning for the core images, and the overall read-only-rootfs/cap-drop posture.

---

## 1. Secrets & Container Security

### 1.1 [HIGH] `env_file: .env` injects every stack secret into containers that don't need them
**Where:** [docker-compose.yml:147](docker-compose.yml#L147) (api), [docker-compose.yml:299](docker-compose.yml#L299) (meilisearch), [docker-compose.yml:319](docker-compose.yml#L319) (vectordb), [docker-compose.yml:349](docker-compose.yml#L349) (rag_api), [optional/code-interpreter/compose.yml:142](optional/code-interpreter/compose.yml#L142), [optional/local-search/compose.yml:417](optional/local-search/compose.yml#L417)

Six services load the *entire* `.env` — Mongo root/app passwords, `JWT_SECRET`/`JWT_REFRESH_SECRET`,
`MEILI_MASTER_KEY`, Postgres credentials, provider API keys — into their process environment.
Meilisearch only needs its master key; vectordb only the `POSTGRES_*` trio; the Jina reranker and
code interpreter (third-party images, the latter executing untrusted LLM-generated code) need nothing
from `.env` that isn't already in their explicit `environment:` blocks. Anything that can read
`/proc/1/environ` or `docker inspect` in one container gets the whole secret set.

**Fix:** Remove `env_file:` from `jina-reranker` and `code-interpreter-api` outright (compose already
interpolates the variables they use). For meilisearch/vectordb, replace with explicit `environment:`
keys. For `api`/`rag_api`, split `.env` into the app-facing subset vs. infrastructure secrets, or list
the needed variables explicitly.

### 1.2 [HIGH] One shared `stack_secrets` volume, all files chmod 444, mounted into 6 services
**Where:** [scripts/populate_stack_secrets_volume.sh:117](scripts/populate_stack_secrets_volume.sh#L117), mounts in [docker-compose.yml:97](docker-compose.yml#L97),121,178,226,256,370

Every secret (Mongo **root** password, `gcp_sa` service-account key, app credentials, all configs) is
world-readable inside one volume mounted into egress-proxy, api-proxy, api, mongodb, mongo-init, and
rag_api. The most exposed service (`api`, running as uid 1000) can read the Mongo root password and the
GCP key — defeating the root/app user split that `mongo-init` carefully sets up.

**Fix:** Populate per-service subdirectories (e.g. `/run/secrets/api/`, `/run/secrets/mongo/`) and mount
only the relevant subpath into each service (`volumes: - stack_secrets:/run/secrets:ro` →
`- type: volume / source: stack_secrets / volume: { subpath: api }` or separate volumes). At minimum,
stop copying `mongo_root_*` and `gcp_sa` where they aren't consumed.

### 1.3 [HIGH] Code interpreter is the least-confined container in the stack
**Where:** [optional/code-interpreter/compose.yml:131-137](optional/code-interpreter/compose.yml#L131)

The one container executing untrusted code runs with Docker's **full default capability set plus
`SYS_ADMIN`** (no `cap_drop: ["ALL"]`), `apparmor:unconfined`, and a writable rootfs — while trivial
caddy proxies in the same repo drop ALL caps. An nsjail escape lands in a container holding
`SYS_ADMIN`, `NET_RAW`, `DAC_OVERRIDE`, `SETUID`, etc.

**Fix:** Add `cap_drop: ["ALL"]` and re-add the minimum nsjail needs (start with
`SYS_ADMIN, SETUID, SETGID, CHOWN, DAC_OVERRIDE`, trim empirically — CI smoke exercises this path).
Attempt `read_only: true`; `/app/data`, `/tmp`, `/run` are already tmpfs.

### 1.4 [HIGH] Firecrawl datastores are completely unhardened and unbounded
**Where:** [optional/local-search/compose.yml:346-403](optional/local-search/compose.yml#L346) (redis, rabbitmq, postgres)

Uniquely in this stack: no `cap_drop`, no `no-new-privileges`, no `read_only`, no `pids_limit`, and
**no memory/CPU limits**. RabbitMQ and Postgres are exactly the services that balloon under crawl
load; on the default 8 GB Colima VM an unbounded RabbitMQ can OOM the whole stack. They also share the
`search` network with `firecrawl-playwright`, which renders untrusted web content.

**Fix:** Apply the proven pattern from `searxng-valkey`/root `mongodb` hardening: drop ALL, re-add
`SETUID/SETGID/CHOWN/DAC_OVERRIDE` where entrypoints need it, add limits (e.g. rabbitmq 1g/1.0,
postgres 1g/1.0, redis 256m/0.5). Consider moving postgres/rabbitmq to a network playwright isn't on —
only `firecrawl-api` needs them. Also replace the hardcoded `postgres:postgres` credentials
([compose.yml:230,389](optional/local-search/compose.yml#L230)) with a `${FIRECRAWL_POSTGRES_PASSWORD:?}` variable.

### 1.5 [HIGH] No guard against placeholder/default secrets; code-exec endpoint published with a default key
**Where:** [scripts/start_stack.sh:251-261](scripts/start_stack.sh#L251), [optional/code-interpreter/compose.yml:42,67,145](optional/code-interpreter/compose.yml#L42), template defaults throughout [template_dot_env](template_dot_env)

`start_stack.sh` only *warns* about two placeholder values (MinIO, SearXNG) and never checks
`JWT_SECRET`, `MEILI_MASTER_KEY`, or the Mongo credentials against `24389_CHANGE_ME`. The compose
overlays add `:-change-me` fallbacks of their own — notably `LIBRECHAT_CODE_API_KEY` defaulting to
`local-code-interpreter-key-change-me` on a service published at `127.0.0.1:8001`: any local process
(or browser page, since there's no origin check) gets code execution with the default key.

**Fix:** Two cheap layers: (a) in `ensure_secret_permissions`, refuse to start when any required secret
equals `24389_CHANGE_ME` or is empty; (b) in compose, use fail-fast interpolation for security-relevant
values: `${LIBRECHAT_CODE_API_KEY:?set in .env}`, `${SEARXNG_API_KEY:?}`, etc. Also reconsider whether
`code-interpreter-proxy` needs a host `ports:` mapping at all — LibreChat reaches it internally.

### 1.6 [HIGH] Unpinned `git clone` in the static-preview image build
**Where:** [optional/static-preview/Dockerfile.sandpack-static:7](optional/static-preview/Dockerfile.sandpack-static#L7)

`git clone --depth=1` of `static-browser-server` HEAD is the only unpinned source in a repo that
otherwise pins everything (digests in compose, commit SHAs in both prepare scripts). Builds are
non-reproducible and a compromised upstream branch flows directly into a browser-facing container.
The runtime stage also copies the full build tree (`.git`, dev `node_modules`) into the final image.

**Fix:** `ARG STATIC_SERVER_REF=<sha>` + `git fetch --depth=1 origin ${STATIC_SERVER_REF} && git checkout FETCH_HEAD`,
mirroring the prepare scripts (and add a Renovate git-refs manager for it). Copy only `out/` + needed
runtime files into the final stage.

### 1.7 [MED] Wildcard CORS with write methods on localhost-published proxies
**Where:** [optional/static-preview/Caddyfile:10-15](optional/static-preview/Caddyfile#L10), [optional/api-proxy/Caddyfile:15-20](optional/api-proxy/Caddyfile#L15)

Both browser-facing proxies send `Access-Control-Allow-Origin: *` allowing `POST, PUT, DELETE`. Any
page in the user's browser can read responses from these localhost services cross-origin.

**Fix:** Restrict to `GET, OPTIONS` (the bundler/static server is read-only) and echo a validated
`Origin` for the `*.localhost` preview hosts instead of `*`.

### 1.8 [MED] Host-side runtime Mongo secrets end up world-readable, with two scripts fighting over modes
**Where:** [scripts/start_stack.sh:242-245](scripts/start_stack.sh#L242) (chmod 600), [scripts/populate_stack_secrets_volume.sh:84](scripts/populate_stack_secrets_volume.sh#L84) (chmod 444), [scripts/ci/smoke.sh:92-98](scripts/ci/smoke.sh#L92)

`start_stack.sh` writes `secrets/runtime-mongo-*.txt` mode 600, then immediately calls the populate
script which rewrites them and chmods 444 — so the root DB password is world-readable on the host
after every start. The 444 is a CI-portability workaround that leaks into local runs.

**Fix:** Default to 400 locally; loosen to 444 only when `CI=true`. Pick one script as the single
writer (see 4.2).

---

## 2. Reliability & Correctness

### 2.1 [HIGH] `smoke.sh` retry helpers always return success after exhausting attempts (verified bug)
**Where:** [scripts/ci/smoke.sh:197-214](scripts/ci/smoke.sh#L197) (`start_container`), [scripts/ci/smoke.sh:227-247](scripts/ci/smoke.sh#L227) (`compose_with_retry`)

Both helpers do `if cmd; then return 0; fi; rc="$?"` — but an `if` whose condition fails exits 0, so
`rc` is always 0 and the final `return "${rc}"` reports success after every attempt failed. Verified
with a minimal repro. A `docker start` or `compose up` that fails all retries is silently swallowed;
for containers without a follow-up health wait (egress-proxy, meilisearch, searxng, firecrawl-api) the
failure surfaces only as a confusing downstream error — or never.

**Fix:** `if cmd; then return 0; else rc="$?"; fi` in both helpers.

### 2.2 [HIGH] Backups snapshot live MongoDB/Postgres data files — restore may be corrupt
**Where:** [backup/backup_librechat.sh:44-58](backup/backup_librechat.sh#L44)

`backup_volume` tars `mongo_data` and `pgdata2` while the stack is running. WiredTiger and Postgres
data directories copied mid-write are not guaranteed consistent; the corruption only shows up at
restore time — the worst possible moment. (The restore script correctly requires the stack stopped;
the backup script has no equivalent guard or quiesce step.)

**Fix:** Either (a) dump logically: `docker exec chat-mongodb mongodump --archive --gzip` and
`docker exec vectordb pg_dump -Fc` for those two volumes, keeping file-level tar for uploads/logs; or
(b) stop the stack (or `db.fsyncLock()` / pg backup mode) around the tar. Also add a post-backup
`tar -tzf` integrity check, and back up `.env` + `secrets/` (encrypted) — restored volumes are useless
without matching credentials.

### 2.3 [HIGH] MinIO init sidecar masks failures with unconditional `exit 0`
**Where:** [optional/code-interpreter/compose.yml:256-261](optional/code-interpreter/compose.yml#L256)

The entrypoint chains `mc alias set ...; mc mb ...; exit 0;` — it always exits successfully even when
bucket creation fails, so `code-interpreter-api`'s `service_completed_successfully` gate is
meaningless and upload failures appear much later with confusing errors.

**Fix:** Use `/bin/sh -ec` and drop the trailing `exit 0` so each command's failure propagates.

### 2.4 [MED-HIGH] Egress proxy — the single chokepoint — has no healthcheck; dnsmasq is unsupervised
**Where:** [docker-compose.yml:84-99](docker-compose.yml#L84), [optional/egress-proxy/entrypoint.sh:24-27](optional/egress-proxy/entrypoint.sh#L24)

All egress flows through Squid, yet dependents gate on `service_started` only. A bad `squid.conf`
(live-copied into the secrets volume) yields a wedged proxy nothing detects. dnsmasq is backgrounded
with `&` and never supervised — if it dies, `firecrawl-playwright` (whose `dns:` points at it)
silently loses DNS while the container stays "up".

**Fix:** Add a healthcheck (TCP 3128 + `pgrep dnsmasq` when DNS is enabled), supervise both processes
in the entrypoint (`wait -n`, exit non-zero when either dies), and upgrade dependents to
`condition: service_healthy`.

### 2.5 [MED] Healthcheck gaps: meilisearch, searxng, api
**Where:** [docker-compose.yml:296-310](docker-compose.yml#L296) (meilisearch — none), [optional/local-search/compose.yml:82-122](optional/local-search/compose.yml#L82) (searxng — none, no `read_only` either), [docker-compose.yml:107-109](docker-compose.yml#L107) (api-proxy gates on api `service_started`)

Meilisearch has no healthcheck at all (`/health` endpoint exists); searxng — the service talking to
the open internet with the broadest Squid allowance — has neither a healthcheck nor `read_only: true`
despite its writable paths already being covered; `api` exposes `/health` but isn't checked, so
`restart: always` recovery and dependency ordering are blind.

**Fix:** Add the three healthchecks, add `read_only: true` to searxng, and upgrade dependents to
`service_healthy` where ordering matters.

### 2.6 [MED] Blind source-patching in prepare scripts silently no-ops when upstream changes
**Where:** [scripts/prepare_jina_reranker_image.sh:44-56](scripts/prepare_jina_reranker_image.sh#L44), [scripts/prepare_code_interpreter_image.sh:44](scripts/prepare_code_interpreter_image.sh#L44), [optional/local-search/firecrawl-postgres/Dockerfile:10-16](optional/local-search/firecrawl-postgres/Dockerfile#L10)

Three places patch upstream sources with `perl`/`awk` substitutions and never verify the pattern
matched. Pinned refs make this latent today, but the first ref bump that reshapes those lines produces
a successfully-built, subtly broken image (reranker 422s, postgres init aborting on pg_cron).

**Fix:** Assert post-conditions after each patch (`grep -q <expected> || exit 1`).

### 2.7 [MED] Unencoded credentials interpolated into `MONGO_URI`
**Where:** [docker-compose.yml:172](docker-compose.yml#L172)

`mongodb://${MONGO_APP_USER}:${MONGO_APP_PASSWORD}@...` breaks if the password contains `@ : / %`.
The secret files elsewhere handle raw values fine, so this is a trap for one specific path.

**Fix:** Document the URL-safe charset requirement in `template_dot_env` next to the Mongo
credentials, or have the startup check reject unsafe characters.

---

## 3. CI & Testing

### 3.1 [HIGH] Renovate PRs never run the smoke test when using the fallback token
**Where:** [.github/workflows/renovate.yml:42-68](.github/workflows/renovate.yml#L42)

When `RENOVATE_TOKEN` is unset, Renovate falls back to `github.token` — and PRs created by
`GITHUB_TOKEN` do **not** trigger `pull_request` workflows (GitHub's recursion guard). Every dependency
PR then shows zero checks, in a repo whose entire safety net is the smoke run.

**Fix:** Fail the job hard when `RENOVATE_TOKEN` is absent, or switch to a GitHub App token via
`actions/create-github-app-token`.

### 3.2 [HIGH] CI runs a mutable third-party image with `SYS_ADMIN`; workflows lack `permissions` blocks
**Where:** [.github/workflows/stack-smoke.yml:77](.github/workflows/stack-smoke.yml#L77), [.github/workflows/stack-smoke.yml:1-17](.github/workflows/stack-smoke.yml#L1), [.github/workflows/renovate.yml:14-16](.github/workflows/renovate.yml#L14)

CI pulls `ghcr.io/usnavy13/librecodeinterpreter:dev` — a mutable tag from a third-party account — and
runs it with `SYS_ADMIN` on a runner holding `GITHUB_TOKEN` with default (potentially write)
permissions, since `stack-smoke.yml` declares no `permissions:` block. It's also inconsistent: the
same smoke script *enforces* digest pins for egress-proxy and rag_api. `renovate.yml` grants
`contents: write` to the validate job that only does a dry run.

**Fix:** Pin the interpreter image by digest in the CI heredoc (+ Renovate regex manager + a smoke
assertion mirroring the existing pin checks). Add `permissions: { contents: read, packages: read }` to
`stack-smoke.yml`; scope renovate.yml's write permissions to the renovate job only.

### 3.3 [HIGH] Worst-case wait budgets exceed the job timeout — and timeout kills all diagnostics
**Where:** [scripts/ci/smoke.sh:642](scripts/ci/smoke.sh#L642) (firecrawl wait ≈ 2 h), [scripts/ci/smoke.sh:322-347](scripts/ci/smoke.sh#L322), [.github/workflows/stack-smoke.yml:17,133-140](.github/workflows/stack-smoke.yml#L17)

Several `wait_*` loops can run for hours against a 40-minute `timeout-minutes`. When GitHub cancels,
the conclusion is `cancelled`, so the `if: failure()` artifact upload never fires and the EXIT trap's
log collection is killed — the most common bad outcome (something never becomes healthy) produces
**zero artifacts**.

**Fix:** Enforce an internal overall deadline in `smoke.sh` (< 30 min) so cleanup always runs; change
the upload step to `if: ${{ failure() || cancelled() }}`; make `wait_container_healthy` fail fast on
exit-looping containers (it already reads the status and ignores it).

### 3.4 [MED] False-pass paths in the smoke suite
**Where:** [scripts/ci/smoke.sh:331-341](scripts/ci/smoke.sh#L331), [scripts/smoke_local_search.sh:43-57](scripts/smoke_local_search.sh#L43), [scripts/ci/smoke.sh:529-540](scripts/ci/smoke.sh#L529)

Three ways the suite can go green while the stack is broken: (a) `wait_http` silently falls back to
in-container `docker exec` probes, masking broken host ingress (the thing the whole
`ingress`-network design exists for); (b) the web-search config assertion only `console.warn`s on
mismatch — a broken `librechat.yaml` passes the local-search smoke; (c) nothing exercises the Mongo
*app-user write path* or Meilisearch at all, despite recent history being dominated by Mongo
credential fixes.

**Fix:** Add `SMOKE_REQUIRE_HOST_INGRESS=1` in CI to disable the exec fallback; make the web-search
config check a hard failure; add a register/login probe through the ingress and a Meili `/health`
probe.

### 3.5 [MED] Egress allowlist check hard-fails on a single attempt against an external domain
**Where:** [scripts/ci/smoke.sh:1052-1076](scripts/ci/smoke.sh#L1052)

One transient DNS blip or opencode.ai outage fails a ~30-minute run. The other opencode.ai check
retries 6× and merely warns.

**Fix:** Retry the "allowed" half (or degrade it to a warning); keep the "blocked example.com" half a
hard assertion — that's the security property and needs no external availability.

### 3.6 [MED] No build caching and no concurrency control — every run rebuilds everything twice over
**Where:** [scripts/ci/smoke.sh:491-495](scripts/ci/smoke.sh#L491), [.github/workflows/stack-smoke.yml:3-12](.github/workflows/stack-smoke.yml#L3)

Each run clones + builds the Jina reranker (pip + HF model download), egress-proxy, LibreChat runtime,
and static-preview images uncached; push + PR triggers with no `concurrency` group means dev→main PRs
run twice and stacked pushes queue full runs.

**Fix:** Prebuild heavy images to GHCR keyed on ref (the prepare scripts already short-circuit on
`docker image inspect`) or use buildx `cache-from/to: type=gha`. Add a
`concurrency: { group: smoke-${{ github.ref }}, cancel-in-progress: ... }` block.

### 3.7 [MED] 1,194-line smoke monolith aborts on first failure across ~50 independent assertions
**Where:** [scripts/ci/smoke.sh:644-1012](scripts/ci/smoke.sh#L644), dead helper at [scripts/ci/smoke.sh:174-189](scripts/ci/smoke.sh#L174), stale lock at [scripts/ci/smoke.sh:253-259](scripts/ci/smoke.sh#L253)

Each violated posture invariant costs a full ~30-minute stack boot to discover the next one. The file
mixes orchestration, assertions, and e2e probes; `run_with_stdin_timeout` is dead code; and the
`mkdir`-based lock permanently blocks local runs after a crash (exit 75 until manually removed).

**Fix:** Add a tiny `check "desc" cmd` harness that accumulates failures and reports at phase end;
split into sourced phase files; delete the dead helper; make the lock stale-aware (write the PID,
`kill -0` it) or use `flock`.

---

## 4. Dependency Management & Drift

### 4.1 [MED] Renovate is silently not tracking several pinned images
**Where:** [renovate.json:203-211](renovate.json#L203), [docker-compose.yml:89,133](docker-compose.yml#L89), [template_dot_env:208-209](template_dot_env#L208)

Verified: the `FIRECRAWL_POSTGRES_IMAGE=` regex matches nothing — the variable was renamed to
`FIRECRAWL_POSTGRES_BASE_IMAGE` / `FIRECRAWL_POSTGRES_SCHEMA_IMAGE`, so both Postgres pins are
untracked. The digest pins living in compose **build args** (`EGRESS_PROXY_IMAGE`, `LIBRECHAT_IMAGE`)
are also invisible to the docker-compose manager, which only reads `image:` keys.

**Fix:** Update the two Postgres regex managers; add custom managers for the build-arg pins. Consider
a CI lint that fails when a `@sha256:` pin in the repo isn't matched by any Renovate manager — this
class of drift is silent by nature.

### 4.2 [MED] Duplicated `.env` parsing with *different* semantics between scripts
**Where:** [scripts/start_stack.sh:214-217](scripts/start_stack.sh#L214), [scripts/populate_stack_secrets_volume.sh:13-24](scripts/populate_stack_secrets_volume.sh#L13)

Both define `read_env_var`, but only the populate version strips trailing comments and whitespace — a
value like `MONGO_APP_PASSWORD=foo  # prod` is read *differently* by the two scripts. They also both
write the same `runtime-mongo-*.txt` files (600 vs 444, see 1.8).

**Fix:** Make `populate_stack_secrets_volume.sh` the single owner of env parsing + secret-file
writing; have `start_stack.sh` only validate and delegate (it already calls populate at the end).

### 4.3 [MED] `librechat.yaml` and `template_librechat.yaml` have already drifted
**Where:** [librechat.yaml](librechat.yaml) vs [template_librechat.yaml](template_librechat.yaml)

The template carries the `google` provider and a Gemini/Vertex preset the live file lacks; nothing
documents which is canonical or syncs them. Same risk applies to `template_dot_env` vs `.env` keys.
Note also that `librechat.yaml` edits only take effect after re-running the populate script + restart
(it's served from the secrets volume) — worth a comment at the top of the file.

**Fix:** Keep only the template in git and generate/diff the live file, or add a CI check that the
live file is a strict subset of the template. Document the populate-to-apply workflow in both files.

### 4.4 [MED] Image pinning inconsistencies across overlays
**Where:** `redis:8.6.3-alpine` digest-pinned in [optional/local-search/compose.yml:347](optional/local-search/compose.yml#L347) but tag-only in [optional/code-interpreter/compose.yml:189](optional/code-interpreter/compose.yml#L189); `caddy:2.11.3-alpine` tag-only in all four uses; valkey, both MinIO images, and `node:26.1.0-alpine` ([Dockerfile.sandpack-static:2,19](optional/static-preview/Dockerfile.sandpack-static#L2)) tag-only; [optional/egress-proxy/Dockerfile:1](optional/egress-proxy/Dockerfile#L1) defaults to `ubuntu/squid:latest` when built outside compose

**Fix:** Pin all by `tag@sha256:...` to match the repo's stated policy; give MinIO images `${VAR:-...}`
overrides like their siblings. Separately, the core api image pins a digest of the moving
`librechat-dev-api:latest` — consider tracking a release tag instead so Renovate diffs are meaningful.

### 4.5 [MED] Hardening is baked into overlays but optional for the core stack; anchor copy-pasted 4×
**Where:** [compose.hardening.yml:7-16](compose.hardening.yml#L7) and identical anchors in the three overlay compose files

`docker compose -f docker-compose.yml -f optional/code-interpreter/compose.yml up` yields hardened
add-ons next to an **unhardened** Mongo/API. And the 10-line `x-harden` anchor exists in four files
(no drift yet, but every future tweak must be replicated by hand — YAML anchors can't cross files).

**Fix:** Fold per-service hardening into `docker-compose.yml` (the overlays prove it works
day-to-day), keeping `compose.hardening.yml` only if an opt-out path is wanted; or have
`start_stack.sh`/docs refuse to run without the hardening file.

---

## 5. Operations & Smaller Items

### 5.1 [MED] Squid audit logs land on a 64 MB tmpfs nobody reads
**Where:** [optional/egress-proxy/squid.conf:67-68](optional/egress-proxy/squid.conf#L67), [compose.hardening.yml:32](compose.hardening.yml#L32)

The "all search egress is audited" promise depends on a log that's invisible to `docker logs`,
unrotated, and lost on restart; sustained crawling can fill the tmpfs and break Squid's log writes.

**Fix:** `access_log stdio:/dev/stdout squid` so audit lines flow through the json-file driver with
the existing 10m×3 rotation. Update the README troubleshooting section accordingly.

### 5.2 [MED] Scripts mutate the user's global Docker context
**Where:** [scripts/start_stack.sh:274](scripts/start_stack.sh#L274), [backup/backup_librechat.sh:25](backup/backup_librechat.sh#L25), [backup/restore_librechat.sh:68](backup/restore_librechat.sh#L68)

`docker context use` changes state for every other terminal the user has open; the nightly backup
LaunchAgent silently flips it at 3am.

**Fix:** Export `DOCKER_CONTEXT="${DOCKER_CONTEXT:-colima-aiarm}"` (the CLI honors it per-process)
instead of `docker context use`.

### 5.3 [LOW] Proxy env block duplicated between `api` and `rag_api`
**Where:** [docker-compose.yml:161-170](docker-compose.yml#L161) vs [docker-compose.yml:358-364](docker-compose.yml#L358)

The five proxy vars + two NO_PROXY lists are repeated verbatim (and the NO_PROXY default appears again
in `template_dot_env`). One `x-proxy-env: &proxy_env` extension field removes the drift risk.

### 5.4 [LOW] `.gitignore` protects `secrets/` by extension allowlist only
**Where:** [.gitignore](.gitignore)

`secrets/*.json|crt|key` + `runtime-*.txt` — a stray `gcp-sa.json.bak` or `notes.txt` in `secrets/`
would be committed. Ignore `secrets/*` wholesale (with `!secrets/.gitkeep` if needed).

### 5.5 [LOW] Autostart LaunchAgent log grows unbounded
**Where:** [scripts/install_autostart_launchagent.sh:54-57](scripts/install_autostart_launchagent.sh#L54)

`librechat-stack-autostart.log` is appended on every login with no rotation. Pipe through
`/usr/bin/newsyslog`-friendly paths or truncate at script start.

---

## Suggested execution order

1. **One-line/low-risk correctness fixes first:** 2.1 (retry helper bug), 2.3 (minio-init), 3.5
   (flaky egress check), 4.1 (dead Renovate regexes) — each is minutes of work and removes a silent
   failure mode.
2. **Secret exposure batch:** 1.1 (drop `env_file` where unneeded), 1.5 (placeholder guard +
   `:?` interpolation), 1.8 (file modes) — mostly deletions, immediately shrinks blast radius.
3. **CI trustworthiness:** 3.1 (Renovate token), 3.2 (pin + permissions), 3.3 (deadline +
   artifact-on-cancel) — after this, green CI actually means something.
4. **Container hardening parity:** 1.3 (code interpreter), 1.4 (Firecrawl datastores), 1.6 (pin the
   static-preview clone), 2.4/2.5 (healthchecks) — validate each against the smoke suite.
5. **Backup safety (2.2)** — needs a small design decision (logical dumps vs stop-the-world).
6. **Structural cleanups when convenient:** 3.6/3.7 (CI speed + smoke split), 4.2–4.5 (dedupe/drift),
   section 5.
