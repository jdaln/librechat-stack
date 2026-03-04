# Backups

Create `~/Library/LaunchAgents/com.YOURUSER.librechat.backup.plist` (replace `YOURUSER`).

```
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
    <key>PROJECT_NET</key><string>librechat-stack_lan</string>
    <key>RETENTION_DAYS</key><string>14</string>
  </dict>

  <!-- Run every day at 03:15 local -->
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

Load it:

```
mkdir -p ~/.local/bin ~/Library/Logs ~/Library/LaunchAgents
chmod +x ~/.local/bin/backup_librechat.sh
launchctl unload ~/Library/LaunchAgents/com.YOURUSER.librechat.backup.plist 
launchctl load -w  ~/Library/LaunchAgents/com.YOURUSER.librechat.backup.plist
```

Run it once by hand to verify:

```
~/.local/bin/backup_librechat.sh
open "$HOME/Backups/LibreChatBackups"
```
