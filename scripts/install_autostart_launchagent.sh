#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

LABEL="com.${USER}.librechat.stack"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_PATH="${HOME}/Library/Logs/librechat-stack-autostart.log"
UID_NUM="$(id -u)"

CURRENT_CONTEXT="$(docker context show 2>/dev/null || true)"
if [[ "${CURRENT_CONTEXT}" =~ ^colima-(.+)$ ]]; then
  COLIMA_PROFILE_DEFAULT="${BASH_REMATCH[1]}"
  DOCKER_CONTEXT_DEFAULT="${CURRENT_CONTEXT}"
else
  COLIMA_PROFILE_DEFAULT="aiarm"
  DOCKER_CONTEXT_DEFAULT="colima-${COLIMA_PROFILE_DEFAULT}"
fi

mkdir -p "${HOME}/Library/LaunchAgents" "${HOME}/Library/Logs"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>if [ -f "${LOG_PATH}" ]; then tail -c 1048576 "${LOG_PATH}" > "${LOG_PATH}.tmp" 2>/dev/null; mv -f "${LOG_PATH}.tmp" "${LOG_PATH}"; fi; exec "${PROJECT_ROOT}/scripts/start_stack.sh"</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>COLIMA_PROFILE</key>
    <string>${COLIMA_PROFILE_DEFAULT}</string>
    <key>DOCKER_CONTEXT_NAME</key>
    <string>${DOCKER_CONTEXT_DEFAULT}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
EOF

launchctl bootout "gui/${UID_NUM}" "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_NUM}" "${PLIST_PATH}"
launchctl enable "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true

echo "Installed LaunchAgent: ${PLIST_PATH}"
echo "Log file: ${LOG_PATH}"
