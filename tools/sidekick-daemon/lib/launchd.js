import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'

const LABEL = 'com.sidekick.daemon'
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`)

function buildPlist(daemonScript, backupDir, port) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${daemonScript}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BACKUP_DIR</key>
    <string>${backupDir}</string>
    <key>BACKUP_PORT</key>
    <string>${port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${join(backupDir, 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${join(backupDir, 'daemon.log')}</string>
</dict>
</plist>`
}

export function install(daemonScript, backupDir, port) {
  // Unload first if already installed
  if (existsSync(PLIST_PATH)) {
    try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' }) } catch { /* ok */ }
  }

  const plist = buildPlist(daemonScript, backupDir, port)
  writeFileSync(PLIST_PATH, plist)
  execSync(`launchctl load "${PLIST_PATH}"`)
  console.log(`Installed: ${PLIST_PATH}`)
  console.log(`Daemon will start on login and auto-restart on crash.`)
}

export function uninstall() {
  if (!existsSync(PLIST_PATH)) {
    console.log('Not installed.')
    return
  }
  try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' }) } catch { /* ok */ }
  unlinkSync(PLIST_PATH)
  console.log(`Uninstalled: ${PLIST_PATH}`)
}

export function start() {
  try {
    execSync(`launchctl start ${LABEL}`)
    console.log('Started.')
  } catch (e) {
    console.error(`Failed to start: ${e.message}`)
    console.error('Run "install" first if not yet installed.')
  }
}

export function stop() {
  try {
    execSync(`launchctl stop ${LABEL}`)
    console.log('Stopped.')
  } catch (e) {
    console.error(`Failed to stop: ${e.message}`)
  }
}
