# Backups and Restore

This directory provides:
- `backup_librechat.sh`: snapshots stack named volumes to tarballs.
- `restore_librechat.sh`: restores a chosen snapshot (or latest per volume).

Backup layout:
- `~/Backups/LibreChatBackups/volumes/<volume>/<volume>-YYYY-MM-DD_HH-MM-SS.tar.gz`
- If you use Colima, keep `BACKUP_ROOT` under your home directory (`/Users/...`) so Docker bind-mounts are visible.

## Install scripts

```bash
mkdir -p ~/.local/bin ~/Library/Logs ~/Library/LaunchAgents
cp backup/backup_librechat.sh ~/.local/bin/backup_librechat.sh
cp backup/restore_librechat.sh ~/.local/bin/restore_librechat.sh
chmod +x ~/.local/bin/backup_librechat.sh ~/.local/bin/restore_librechat.sh
```

## LaunchAgent (daily automatic backup)

Create `~/Library/LaunchAgents/com.YOURUSER.librechat.backup.plist` (replace `YOURUSER`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.YOURUSER.librechat.backup</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>/Users/YOURUSER/.local/bin/backup_librechat.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DOCKER_CONTEXT</key><string>colima-aiarm</string>
    <key>PROJECT_NAME</key><string>librechat-stack</string>
    <key>BACKUP_ROOT</key><string>/Users/YOURUSER/Backups/LibreChatBackups</string>
    <key>RETENTION_DAYS</key><string>30</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>15</integer>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>/Users/YOURUSER</string>
  <key>StandardOutPath</key><string>/Users/YOURUSER/Library/Logs/librechat-backup.log</string>
  <key>StandardErrorPath</key><string>/Users/YOURUSER/Library/Logs/librechat-backup.log</string>
</dict>
</plist>
```

Load/reload:

```bash
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.YOURUSER.librechat.backup.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.YOURUSER.librechat.backup.plist
launchctl enable "gui/$(id -u)/com.YOURUSER.librechat.backup"
launchctl kickstart -k "gui/$(id -u)/com.YOURUSER.librechat.backup"
```

Check backup agent logs:

```bash
tail -n 200 ~/Library/Logs/librechat-backup.log
```

## Manual backup test

```bash
~/.local/bin/backup_librechat.sh
ls -lah "$HOME/Backups/LibreChatBackups/volumes"
```

## Restore runbook

1. Stop the stack first (restore script refuses to run while the compose project is up):

```bash
docker compose --env-file .env \
  -f docker-compose.yml \
  -f compose.hardening.yml \
  -f optional/code-interpreter/compose.yml \
  -f optional/local-search/compose.yml \
  down
```

2. Inspect what would be restored:

```bash
~/.local/bin/restore_librechat.sh --list
```

3. Restore latest per volume:

```bash
~/.local/bin/restore_librechat.sh --yes
```

Or restore a specific timestamp (example):

```bash
~/.local/bin/restore_librechat.sh --snapshot 2026-03-06_03-15-00 --yes
```

4. Start stack again:

```bash
docker compose --env-file .env \
  -f docker-compose.yml \
  -f compose.hardening.yml \
  -f optional/code-interpreter/compose.yml \
  -f optional/local-search/compose.yml \
  up -d
```

5. Verify:
- login works at `http://127.0.0.1:3081`
- previous chats/files are present
- API health: `curl -fsS http://127.0.0.1:3081/login >/dev/null && echo ok`
