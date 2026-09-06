# Running the stack on Linux with rootless Docker

This guide adapts the stack (designed for macOS + Colima) to a **Linux VM
running [rootless Docker](https://docs.docker.com/engine/security/rootless/)**.
Most of it works unchanged; the parts that need attention are all consequences
of "no root": **binding port 80**, **enforcing the memory/CPU limits**, and
**the nsjail code interpreter**. Read [§3](#3-the-port-80-problem-required)
and [§4](#4-resource-limits-cgroup-v2--delegation-do-this) before your first run.

> `scripts/start_stack.sh`, the autostart LaunchAgent, and the backup scripts'
> `DOCKER_CONTEXT` default are **macOS/Colima-specific** — do not run them
> as-is on Linux. This guide gives the Linux equivalents.

---

## TL;DR — the rootless-specific gotchas for *this* stack

| # | Issue | Why it bites here | Fix |
|---|-------|-------------------|-----|
| 1 | Host port **80** can't bind | `api-proxy` publishes `127.0.0.1:80:81` (the Sandpack bundler ingress) | sysctl `net.ipv4.ip_unprivileged_port_start=80`, **or** remap the port + set `SANDPACK_BUNDLER_URL` ([§3](#3-the-port-80-problem-required)) |
| 2 | `mem_limit`/`cpus`/`pids_limit` silently ignored | The stack relies on them to protect a small VM | cgroup v2 + systemd delegation ([§4](#4-resource-limits-cgroup-v2--delegation-do-this)) |
| 3 | Code interpreter (`SYS_ADMIN`/nsjail) | nsjail needs *nested* user namespaces; modern Ubuntu blocks them | host sysctls, or run **without** that overlay ([§6](#6-the-code-interpreter-overlay-the-hard-part)) |
| 4 | `user: 1000/999/101` directives | Mapped through your subuid range | ensure a 65536-wide subuid/subgid range ([§5](#5-uid-mapping-subuidsubgid)) |
| 5 | `userns-remap` in the main README | That's a **rootful** tweak — N/A and conflicting under rootless | skip it ([§9](#9-things-from-the-main-readme-that-change)) |

The host publishes (only one is privileged):

```
api-proxy           127.0.0.1:3081:80   # LibreChat UI            (ok, >1024)
api-proxy           127.0.0.1:80:81     # Sandpack bundler        (PRIVILEGED — issue #1)
caddy-static-proxy  127.0.0.1:4324:80   # static preview overlay  (ok, >1024)
code-interpreter    127.0.0.1:8001:8000 # code interpreter overlay(ok, >1024)
```

---

## 1. Prerequisites

A Linux VM (Ubuntu 22.04/24.04, Debian 12, or Fedora work well) with:

- **A non-root user** you'll run everything as (examples below use `lcuser`).
- **Kernel cgroup v2** (default on the distros above).
- These packages: `uidmap` (provides `newuidmap`/`newgidmap`), `dbus-user-session`,
  `slirp4netns` (or `passt`/`pasta`), `fuse-overlayfs`, `iptables`.

  ```bash
  sudo apt-get update
  sudo apt-get install -y uidmap dbus-user-session slirp4netns fuse-overlayfs iptables
  ```

- **subuid/subgid ranges** for your user (usually created by `adduser`; verify in [§5](#5-uid-mapping-subuidsubgid)).
- Enough RAM/disk for the profile you run. The base stack is light; with local
  search (Firecrawl + Playwright) budget ~6–8 GB RAM.

Do **not** install the rootful Docker engine for this user, and do not add the
user to a `docker` group — that defeats the point.

---

## 2. Install rootless Docker

As `lcuser` (not root):

```bash
# Install Docker, then the rootless setup tool:
curl -fsSL https://get.docker.com | sh        # installs the packages
dockerd-rootless-setuptool.sh install         # sets up the per-user daemon

# Start it now and on boot (linger lets it run with no active login session):
systemctl --user enable --now docker
sudo loginctl enable-linger "$(whoami)"

# Point the CLI at the rootless socket (add to ~/.bashrc):
export PATH=/usr/bin:$PATH
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
```

Verify:

```bash
docker info --format 'rootless={{println .SecurityOptions}}cgroup={{.CgroupVersion}} driver={{.CgroupDriver}}'
# Expect SecurityOptions to include "rootless" and cgroup=2 driver=systemd
docker run --rm hello-world
```

---

## 3. The port 80 problem (required)

Rootless Docker cannot bind host ports below 1024 by default, and `api-proxy`
publishes `127.0.0.1:80:81` for the **dynamic Sandpack bundler** (the artifact
preview). Pick **one** of these:

### Option A (recommended) — allow low ports system-wide

Keeps the stack byte-identical to the documented config (`SANDPACK_BUNDLER_URL`
stays `http://127.0.0.1:80`):

```bash
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-rootless-ports.conf
sudo sysctl --system
```

Trade-off: any unprivileged process on the VM may then bind 80–1023. Nothing
else changes.

### Option B — remap the bundler port (no host change)

Keep ports privileged-free by moving the bundler ingress to `8080` and telling
LibreChat the new browser-facing URL.

1. In `.env`:
   ```ini
   SANDPACK_BUNDLER_URL=http://127.0.0.1:8080
   ```
2. Create `compose.rootless.yml` next to `docker-compose.yml`:
   ```yaml
   # Rootless override: replace the privileged :80 publish with :8080.
   # NOTE: compose merges `ports` ADDITIVELY across -f files, so we must use
   # the `!override` tag to REPLACE the list (needs Docker Compose >= 2.24).
   services:
     api-proxy:
       ports: !override
         - "127.0.0.1:3081:80"
         - "127.0.0.1:8080:81"
   ```
3. Add `-f compose.rootless.yml` to **every** compose command (after
   `compose.hardening.yml`, before the optional overlays).

> Without `!override`, the `:80` mapping stays in place and rootless still
> fails to bind it.

The static-preview overlay (`4324`) and code-interpreter (`8001`) are already
above 1024 — no change needed.

---

## 4. Resource limits: cgroup v2 + delegation (do this)

The stack sets `mem_limit`, `cpus`, and `pids_limit` on every service to keep a
small VM from OOMing. Under rootless these are **only enforced if the
controllers are delegated to your user session**; otherwise Docker logs a
warning and ignores them.

Check:

```bash
docker info 2>&1 | grep -iE 'cgroup|limit'
# A line like "WARNING: No memory limit support" means delegation is missing.
```

Enable delegation (modern systemd delegates `pids`/`memory`/`cpu`/`io` by
default; do this if the warning appears):

```bash
sudo mkdir -p /etc/systemd/system/user@.service.d
sudo tee /etc/systemd/system/user@.service.d/delegate.conf >/dev/null <<'EOF'
[Service]
Delegate=cpu cpuset io memory pids
EOF
sudo systemctl daemon-reload
# log out and back in (or reboot), then restart the rootless daemon:
systemctl --user restart docker
```

Re-run `docker info` — the warnings should be gone. If you *cannot* enable
delegation, the stack still runs but `mem_limit`/`cpus` are advisory only;
lower the Firecrawl concurrency env vars (`FIRECRAWL_*`) to compensate.

---

## 5. UID mapping (subuid/subgid)

The hardened services run as explicit UIDs — `api`/`static-preview` as `1000`,
`vectordb`/`firecrawl-postgres` as `999`, `rag_api` as `101` — and several tmpfs
mounts pin `uid=13/101/1000`. Rootless maps these through your subordinate ID
ranges, so you just need a wide-enough range (the default 65536 covers all of
them):

```bash
grep "^$(whoami):" /etc/subuid /etc/subgid
# Expect e.g.  lcuser:100000:65536  in both files. If missing:
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$(whoami)"
systemctl --user restart docker
```

No changes to the compose files are needed — container UID 1000 simply maps to
host UID 101000, etc. Named volumes live under
`~/.local/share/docker/volumes/` owned by those mapped IDs.

---

## 6. The code interpreter overlay (the hard part)

`code-interpreter-api` runs untrusted code in **nsjail**, which needs
`SYS_ADMIN` + `apparmor:unconfined` and creates its own user/mount/PID
namespaces. Under rootless Docker the container is *already* in a user
namespace, so nsjail needs **nested** unprivileged user namespaces — which
modern distros restrict.

This overlay is the **least likely to work rootless.** Recommended order:

1. **Run without it first.** Use a profile that excludes code interpreter
   (base, `local-search`, and/or `static-preview`). Everything else is
   well-behaved rootless.
2. **If you need it**, on the host enable unprivileged user namespaces:
   ```bash
   # Debian (and older Ubuntu):
   echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/99-userns.conf

   # Ubuntu 23.10+/24.04 also restricts userns via AppArmor — relax it:
   echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/99-userns-apparmor.conf

   sudo sysctl --system
   ```
   Then test just that overlay and watch the logs:
   ```bash
   docker compose ... -f optional/code-interpreter/compose.yml up -d code-interpreter-api
   docker logs -f code-interpreter-api   # look for nsjail "Launching child process failed"
   ```
   If nsjail still fails to launch, the interpreter cannot run under your
   rootless/host combination without further host changes (or a rootful daemon
   for that one service) — run without this overlay.

`apparmor:unconfined` itself may be rejected by some rootless setups; if the
container refuses to start, the host won't grant what nsjail needs.

---

## 7. Bringing the stack up (Linux)

`start_stack.sh` is Colima-only. Run the pieces it orchestrates directly. Set
the overlay flags you want, then:

```bash
cd /path/to/librechat-stack
cp template_dot_env .env
$EDITOR .env          # replace every 24389_CHANGE_ME; set a real model key if you want premium models

# --- build local images for the overlays you enable ---
# Jina reranker (local-search): override the macOS cache path on Linux:
JINA_RERANKER_CACHE_ROOT="$HOME/.cache/librechat-stack" ./scripts/prepare_jina_reranker_image.sh
# Code interpreter (only if you got §6 working): uses ~/.cache already:
./scripts/prepare_code_interpreter_image.sh

# --- build + populate the secrets volume (validates secrets, fails on placeholders) ---
# Pass the same ENABLE_* flags so overlay secrets are validated too:
ENABLE_LOCAL_SEARCH=1 ./scripts/populate_stack_secrets_volume.sh

# --- compose file set (add compose.rootless.yml here if you used Option B) ---
COMPOSE=(-f docker-compose.yml -f compose.hardening.yml)
# COMPOSE+=(-f compose.rootless.yml)                       # Option B only
# COMPOSE+=(-f optional/local-search/compose.yml)
# COMPOSE+=(-f optional/static-preview/compose.yml)
# COMPOSE+=(-f optional/code-interpreter/compose.yml)      # only if §6 works

# --- bootstrap Mongo, then bring everything up ---
docker compose --env-file .env "${COMPOSE[@]}" up -d mongodb mongo-init
docker compose --env-file .env "${COMPOSE[@]}" up -d
docker compose --env-file .env "${COMPOSE[@]}" ps
```

Open `http://localhost:3081`. Create the first admin user:

```bash
docker compose --env-file .env "${COMPOSE[@]}" exec api npm run create-user
```

> `populate_stack_secrets_volume.sh` and the `prepare_*.sh` scripts use
> `docker cp`/`docker exec`/`docker build`, which all work rootless. They honor
> `$DOCKER_HOST`, so no `docker context` juggling is needed.

---

## 8. Autostart with systemd (replaces the LaunchAgent)

With linger enabled ([§2](#2-install-rootless-docker)), a **user** systemd unit
starts the stack on boot. Create `~/.config/systemd/user/librechat-stack.service`:

```ini
[Unit]
Description=LibreChat stack (rootless)
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=%h/librechat-stack
Environment=DOCKER_HOST=unix:///run/user/%U/docker.sock
# Mirror your chosen overlay set here:
ExecStartPre=/usr/bin/env ENABLE_LOCAL_SEARCH=1 %h/librechat-stack/scripts/populate_stack_secrets_volume.sh
ExecStart=/usr/bin/docker compose --env-file .env -f docker-compose.yml -f compose.hardening.yml -f optional/local-search/compose.yml up -d
ExecStop=/usr/bin/docker compose --env-file .env -f docker-compose.yml -f compose.hardening.yml -f optional/local-search/compose.yml down

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now librechat-stack.service
journalctl --user -u librechat-stack -f      # logs
```

---

## 9. Things from the main README that change

- **`userns-remap` daemon.json tweak** (README "user-namespace remapping"):
  rootful-only. Rootless already runs in a user namespace — skip it.
- **`scripts/start_stack.sh`**: Colima-only — use [§7](#7-bringing-the-stack-up-linux).
- **`scripts/install_autostart_launchagent.sh`**: macOS LaunchAgent — use the
  systemd user unit in [§8](#8-autostart-with-systemd-replaces-the-launchagent).
- **Backups** (`backup/*.sh`): the logic works, but they default
  `DOCKER_CONTEXT=colima-aiarm`, which on Linux points at a nonexistent context
  and **overrides `DOCKER_HOST`**. Always pass `DOCKER_CONTEXT=default`:
  ```bash
  DOCKER_CONTEXT=default BACKUP_ROOT="$HOME/Backups/LibreChatBackups" \
    ./backup/backup_librechat.sh
  ```
  Schedule with a systemd `--user` timer or the host user's cron.
- **Jina reranker build cache**: set `JINA_RERANKER_CACHE_ROOT=$HOME/.cache/librechat-stack`
  (the script defaults to a macOS path). The code-interpreter prepare script
  already uses `$XDG_CACHE_HOME`/`~/.cache`.

---

## 10. Verify

```bash
# All services healthy:
docker compose --env-file .env "${COMPOSE[@]}" ps

# Egress allowlist still enforced (should print 200 for opencode.ai, 403 for example.com):
docker exec LibreChat node -e "\
const net=require('net');\
const test=(h)=>new Promise(r=>{const s=net.createConnection({host:'egress-proxy',port:3128},\
()=>s.write('CONNECT '+h+':443 HTTP/1.1\r\nHost: '+h+':443\r\n\r\n'));let d='';\
s.on('data',c=>{d+=c.toString();if(d.includes('\r\n')){console.log(h,d.split('\r\n')[0]);s.destroy();r();}});});\
(async()=>{await test('opencode.ai');await test('example.com');})();"
```

The CI smoke test (`scripts/ci/smoke.sh`) also runs against a rootless daemon
(it only uses `docker`/`docker compose` and honors `$DOCKER_HOST`). **But** it
brings up *every* overlay including the code interpreter, so it will fail at
that stage if you didn't get [§6](#6-the-code-interpreter-overlay-the-hard-part)
working. For a rootless deployment without the interpreter, verify with the
commands above plus a login + chat in the browser rather than the full smoke.

---

## 11. Troubleshooting (rootless-specific)

| Symptom | Cause | Fix |
|---------|-------|-----|
| `api-proxy` fails: `bind: permission denied` on `:80` | privileged port | [§3](#3-the-port-80-problem-required) |
| Artifact preview blank, bundler URL unreachable | used Option B but didn't set `SANDPACK_BUNDLER_URL` | match the env to the remapped port |
| `docker info` warns "No memory limit support"; containers OOM the VM | cgroup controllers not delegated | [§4](#4-resource-limits-cgroup-v2--delegation-do-this) |
| `code-interpreter-api`: `nsjail ... Launching child process failed` | nested userns blocked | [§6](#6-the-code-interpreter-overlay-the-hard-part); or drop the overlay |
| A service can't write its data dir / volume | subuid range too small or missing | [§5](#5-uid-mapping-subuidsubgid) |
| Stack doesn't start after reboot | linger not enabled, or unit not enabled | `loginctl enable-linger`; `systemctl --user enable` |
| Backups hang or hit the wrong daemon | `DOCKER_CONTEXT=colima-aiarm` default | run with `DOCKER_CONTEXT=default` |
| Outbound TLS from containers stalls | slirp4netns MTU | try `passt`/`pasta` driver, or lower MTU on the bridge |

---

## What is unchanged from the macOS/Colima setup

The egress-proxy allowlist, the internal-network isolation and fixed subnets
(`172.31.x`), the per-service secrets-volume subpaths, read-only rootfs +
dropped capabilities, healthchecks, image digest pins, and the model presets
all behave identically. The differences above are entirely about not having
root on the host.
