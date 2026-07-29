const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { exec, execFile } = require('child_process')
const { getInstallStatus, installAll } = require('./scripts/install-hooks')

const PORT = 27420
const APP_ICON = path.join(__dirname, 'assets', 'app-icon.png')
const FOCUS_LOG_PATH = '/tmp/agent-board-focus.log'
const SYSTEM_SOUND_FILES = {
  yellow: '/System/Library/Sounds/Bottle.aiff',
  green: '/System/Library/Sounds/Glass.aiff',
  red: '/System/Library/Sounds/Basso.aiff',
}

let lastHookInstallResult = null
let tray = null
const MAX_RECENT_SESSIONS = 20

function getBooleanSetting(settings, key, defaultValue) {
  if (typeof settings[key] === 'boolean') return settings[key]
  return defaultValue
}

function sessionsFile() {
  return path.join(app.getPath('userData'), 'sessions.json')
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2))
}

function patchSettings(patch) {
  const settings = readSettings()
  const next = { ...settings, ...patch }
  writeSettings(next)
  return next
}

function listRecentSessions() {
  const settings = readSettings()
  const recents = Array.isArray(settings.recentSessions) ? settings.recentSessions : []
  const normalized = recents
    .filter(item => item && typeof item.id === 'string')
    .map(item => ({
      ...item,
      id: normalizeSessionId(item.id),
      client: normalizeClient(item.client),
    }))
    .filter(item => item.id)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))

  const seen = new Set()
  const deduped = []
  for (const item of normalized) {
    const key = recentSessionKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }

  return deduped
}

function recordRecentSession(session) {
  if (!session) return
  const sessionId = normalizeSessionId(session.id)
  if (!sessionId) return
  const settings = readSettings()
  const recents = Array.isArray(settings.recentSessions) ? settings.recentSessions : []
  const nextSession = {
    id: sessionId,
    label: session.label,
    cwd: session.cwd,
    client: normalizeClient(session.client),
    sourceType: session.sourceType,
    status: session.status,
    updatedAt: Number(session.updatedAt || Date.now()),
    terminalPid: session.terminalPid,
    terminalName: session.terminalName,
    termProgram: session.termProgram,
    vscodePid: session.vscodePid,
    cursorPid: session.cursorPid,
    cursorName: session.cursorName,
  }

  const nextKey = recentSessionKey(nextSession)
  const deduped = [nextSession, ...recents.filter(item => item && recentSessionKey(item) !== nextKey)]
  settings.recentSessions = deduped
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, MAX_RECENT_SESSIONS)

  writeSettings(settings)
}

function clientName(client = '') {
  const normalized = normalizeClient(client)
  if (normalized === 'codex') return 'Codex'
  if (normalized === 'cursor') return 'Cursor'
  if (normalized === 'claude') return 'Claude'
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Unknown'
}

function normalizeClient(client = '') {
  return String(client || '').trim().toLowerCase()
}

function normalizeSessionId(sessionId = '') {
  return String(sessionId || '').trim()
}

function recentSessionKey(session = {}) {
  return `${normalizeClient(session.client)}::${normalizeSessionId(session.id)}`
}

function formatRecentSessionLabel(session) {
  const prefix = `[${clientName(session.client)}]`
  const name = session.label || (session.cwd ? path.basename(session.cwd) : String(session.id).slice(0, 8))
  return `${prefix} ${name}`
}

function formatRecentSessionPath(session) {
  return session.cwd || 'Path unavailable'
}

function openRecentSession(sessionId) {
  const activeSession = sessions.get(sessionId)
  const recentSession = listRecentSessions().find(item => item.id === sessionId)
  const targetSession = recentSession || activeSession
  if (!targetSession) return

  const client = String(targetSession.client || '').toLowerCase()

  if (client === 'claude') {
    if (activeSession && canFocusExistingClaudeHost(activeSession)) {
      appendFocusLog(`claude recent focus-existing id=${targetSession.id} sourceType=${activeSession.sourceType || ''} terminalPid=${activeSession.terminalPid || ''} vscodePid=${activeSession.vscodePid || ''}`)
      focusSession(activeSession)
      return
    }

    if (getClaudeSourceType(targetSession) === 'vscode') {
      appendFocusLog(`claude recent restore-vscode id=${targetSession.id} cwd=${targetSession.cwd || ''}`)
      launchClaudeResumeInVSCode(targetSession)
      return
    }

    appendFocusLog(`claude recent resume-needed id=${targetSession.id} active=${!!activeSession} status=${targetSession.status || ''}`)
    launchClaudeResumeSession(targetSession)
    return
  }

  if (activeSession) {
    focusSession(activeSession)
    return
  }

  focusSession(targetSession)
}

function launchClaudeResumeSession(session) {
  const sessionId = String(session.id || '').trim()
  if (!sessionId) return

  const cwd = String(session.cwd || '').trim() || app.getPath('home')
  const shellCommand = buildClaudeResumeCommand(sessionId, cwd)
  appendFocusLog(`claude resume start id=${sessionId} cwd=${cwd} exe=${resolveExecutable('claude')}`)

  launchInGhostty(shellCommand, sessionId, ghosttyErr => {
    appendFocusLog(`claude resume ghostty failed id=${sessionId} err=${ghosttyErr?.message || ghosttyErr || 'unknown'}`)
    launchInTerminal(shellCommand, sessionId)
  })
}

function launchClaudeResumeInVSCode(session) {
  const sessionId = String(session.id || '').trim()
  if (!sessionId) return

  const cwd = String(session.cwd || '').trim() || app.getPath('home')
  const escapedCwd = shellEscapeForDoubleQuotedShell(cwd)

  exec(`open -a "Visual Studio Code" "${escapedCwd}"`, openErr => {
    if (openErr) {
      appendFocusLog(`claude vscode open failed id=${sessionId} err=${openErr.message || openErr}`)
      launchClaudeResumeSession(session)
      return
    }

    appendFocusLog(`claude vscode reopen ok id=${sessionId} cwd=${cwd}`)

    runAppleScript([
      'tell application "Visual Studio Code" to activate',
    ], err => {
      if (err) {
        appendFocusLog(`claude vscode activate failed id=${sessionId} err=${err.message || err}`)
      }
    })
  })
}

function buildClaudeResumeCommand(sessionId, cwd) {
  const escapedCwd = shellEscapeForSingleQuotes(cwd)
  const escapedSessionId = shellEscapeForSingleQuotes(sessionId)
  const claudeExec = shellEscapeForSingleQuotes(resolveExecutable('claude'))
  return `cd '${escapedCwd}' && ('${claudeExec}' --dangerously-skip-permissions --resume '${escapedSessionId}' || '${claudeExec}' --dangerously-skip-permissions --continue)`
}

function shellEscapeForSingleQuotes(input = '') {
  return String(input).replace(/'/g, `'\\''`)
}

function shellEscapeForDoubleQuotedShell(input = '') {
  return String(input).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeForAppleScript(input = '') {
  return String(input).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function launchInGhostty(command, sessionId, fallback) {
  execFile('open', ['-na', 'Ghostty', '--args', '-e', '/bin/zsh', '-lc', command], err => {
    if (err) {
      if (typeof fallback === 'function') fallback(err)
      return
    }

    appendFocusLog(`claude resume ghostty dispatched id=${sessionId}`)
  })
}

function launchInTerminal(command, sessionId) {
  const appleScriptCommand = escapeForAppleScript(command)
  runAppleScript([
    'tell application "Terminal" to activate',
    `tell application "Terminal" to do script "${appleScriptCommand}"`,
  ], (err, stdout, stderr) => {
    if (err) {
      appendFocusLog(`claude resume terminal failed id=${sessionId} err=${err.message || err} stderr=${String(stderr || '').trim()}`)
      exec('open -a "Terminal"')
      return
    }

    appendFocusLog(`claude resume terminal dispatched id=${sessionId} stdout=${String(stdout || '').trim()}`)
  })
}

function runAppleScript(lines, callback) {
  const args = []
  for (const line of lines) {
    args.push('-e', line)
  }
  execFile('osascript', args, callback)
}

function appendFocusLog(message) {
  fs.appendFile(FOCUS_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, () => {})
}

function resolveExecutable(name) {
  const shellResolved = resolveExecutableFromShell(name)
  if (shellResolved) return shellResolved

  const searchDirs = [
    ...String(process.env.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(app.getPath('home'), '.local', 'bin'),
  ]

  for (const dir of searchDirs) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }

  const nvmResolved = resolveExecutableFromNvm(name)
  if (nvmResolved) return nvmResolved

  return name
}

function resolveExecutableFromShell(name) {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const result = require('child_process')
      .execFileSync(shell, ['-lic', `command -v ${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()

    if (!result) return ''
    fs.accessSync(result, fs.constants.X_OK)
    return result
  } catch {
    return ''
  }
}

function resolveExecutableFromNvm(name) {
  try {
    const binDir = path.join(os.homedir(), '.nvm', 'versions', 'node')
    const versionDirs = fs.readdirSync(binDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))

    for (const version of versionDirs) {
      const candidate = path.join(binDir, version, 'bin', name)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch {}
    }
  } catch {}

  return ''
}

function canFocusExistingClaudeHost(session) {
  if (!session) return false

  const terminalPid = Number(session.terminalPid)
  if (Number.isFinite(terminalPid) && terminalPid > 1 && isProcessAlive(terminalPid)) {
    return true
  }

  const vscodePid = Number(session.vscodePid)
  if (Number.isFinite(vscodePid) && vscodePid > 1 && isProcessAlive(vscodePid)) {
    return true
  }

  return false
}

function getClaudeSourceType(session) {
  if (!session || String(session.client || '').toLowerCase() !== 'claude') return ''
  if (session.sourceType) return String(session.sourceType)

  const hasVSCodePid = Number(session.vscodePid) > 1
  const hasTerminalPid = Number(session.terminalPid) > 1
  const termProgram = String(session.termProgram || '').toLowerCase()

  if (hasVSCodePid && !hasTerminalPid) return 'vscode'
  if (hasTerminalPid) return 'tui'
  if (termProgram.includes('vscode') || termProgram.includes('code')) return 'vscode'
  if (termProgram) return 'tui'
  return 'unknown'
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// --- Session state store ---
const sessions = new Map()

function loadSessions() {
  sessions.clear()
  saveSessions()
}

function saveSessions() {
  const obj = {}
  for (const [id, s] of sessions) obj[id] = s
  fs.writeFileSync(sessionsFile(), JSON.stringify(obj, null, 2))
}

function upsertSession(id, patch) {
  const existing = sessions.get(id) || {}
  const next = { ...existing, id, ...patch }
  sessions.set(id, next)
  recordRecentSession(next)
  saveSessions()
  broadcastSessions()
  if (app.isReady()) buildApplicationMenu()
}

function removeSession(id) {
  sessions.delete(id)
  saveSessions()
  broadcastSessions()
  if (app.isReady()) buildApplicationMenu()
}

// --- BrowserWindow ---
let win = null

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize

  win = new BrowserWindow({
    width: 600,
    height: 44,
    x: Math.round((width - 600) / 2),
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  win.webContents.once('did-finish-load', syncWindowVisibility)
}

function broadcastSessions() {
  if (!win) return
  const list = Array.from(sessions.values())
  syncWindowVisibility(list)
  win.webContents.send('sessions-update', list)
}

function syncWindowVisibility(list = Array.from(sessions.values())) {
  if (!win) return
  if (list.length > 0) {
    if (!win.isVisible()) win.showInactive()
  } else if (win.isVisible()) {
    win.hide()
  }
}

// --- HTTP server for hooks ---
function startHttpServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200)
      res.end('ok')
      return
    }

    if (req.method === 'POST' && req.url === '/event') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const event = JSON.parse(body)
          handleHookEvent(event)
        } catch {}
        res.writeHead(200)
        res.end('ok')
      })
      return
    }

    // Dump current sessions (read-only, used for verification)
    if (req.method === 'GET' && req.url === '/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(Array.from(sessions.values())))
      return
    }

    if (req.method === 'GET' && req.url === '/window-state') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        hasWindow: !!win,
        isVisible: !!win && win.isVisible(),
        bounds: win ? win.getBounds() : null,
        sessionCount: sessions.size,
      }))
      return
    }

    // Execute JS in renderer then capture (for collapse/expand testing)
    if (req.method === 'POST' && req.url === '/exec') {
      let body = ''
      req.on('data', c => { body += c })
      req.on('end', () => {
        win.webContents.executeJavaScript(body).then(result => {
          res.writeHead(200)
          res.end(JSON.stringify({ result }))
        }).catch(e => { res.writeHead(500); res.end(e.message) })
      })
      return
    }

    // Capture renderer screenshot from inside Electron (bypasses screencapture Space limitation)
    if (req.method === 'GET' && req.url === '/screenshot') {
      if (!win) { res.writeHead(503); res.end('no window'); return }
      win.webContents.capturePage().then(img => {
        const png = img.toPNG()
        fs.writeFileSync('/tmp/agent-rgb-render.png', png)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ saved: '/tmp/agent-rgb-render.png', bytes: png.length, bounds: win.getBounds() }))
      }).catch(e => { res.writeHead(500); res.end(e.message) })
      return
    }

    res.writeHead(404)
    res.end()
  })

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Hook server listening on http://127.0.0.1:${PORT}`)
  })
}

function handleHookEvent(event) {
  const {
    session_id,
    hook_event_name,
    hook_event,
    tool_name,
    cwd,
    label: event_label,
    client,
    term_program,
    iterm_session,
    vscode_pid,
    tty,
    terminal_pid,
    terminal_name,
    cursor_pid,
    cursor_name,
  } = event

  const normalizedSessionId = normalizeSessionId(session_id)
  if (!normalizedSessionId) return

  const eventName = normalizeHookEventName(hook_event_name || hook_event?.event_type)
  const label = event_label || (cwd ? path.basename(cwd) : normalizedSessionId.slice(0, 8))
  const normalizedClient = normalizeClient(client || 'claude')

  const sessionPatch = {
    label,
    cwd,
    client: normalizedClient,
    sourceType: deriveSessionSourceType({
      client: normalizedClient,
      termProgram: term_program,
      vscodePid: vscode_pid,
      terminalPid: terminal_pid,
    }),
    termProgram: term_program,
    itermSession: iterm_session,
    vscodePid: vscode_pid,
    tty,
    terminalPid: terminal_pid,
    terminalName: terminal_name,
    cursorPid: cursor_pid,
    cursorName: cursor_name,
    updatedAt: Date.now(),
  }

  // A new user prompt means this session is active again, even if it had completed.
  if (eventName === 'UserPromptSubmit') {
    upsertSession(normalizedSessionId, { ...sessionPatch, status: 'running' })
    return
  }

  // Only update state if session already exists (was created by UserPromptSubmit)
  if (!sessions.has(normalizedSessionId)) return

  if (eventName === 'Stop') {
    upsertSession(normalizedSessionId, { ...sessionPatch, status: 'completed' })
    return
  }

  if (eventName === 'PreToolUse') {
    if (isWaitingTool(tool_name)) {
      upsertSession(normalizedSessionId, { ...sessionPatch, status: 'waiting' })
    } else {
      upsertSession(normalizedSessionId, { ...sessionPatch, status: 'running' })
    }
    return
  }

  if (eventName === 'PostToolUse') {
    upsertSession(normalizedSessionId, { ...sessionPatch, status: 'running' })
  }
}

function isWaitingTool(toolName = '') {
  const name = String(toolName || '').toLowerCase()
  return [
    'askuserquestion',
    'ask_user_question',
    'elicitation',
    'askquestion',
    'ask_question',
  ].some(keyword => name.includes(keyword))
}

function normalizeHookEventName(name = '') {
  return {
    before_submit_prompt: 'UserPromptSubmit',
    pre_tool_use: 'PreToolUse',
    post_tool_use_failure: 'PostToolUse',
    before_shell_execution: 'PreToolUse',
    after_shell_execution: 'PostToolUse',
    before_mcp_execution: 'PreToolUse',
    after_mcp_execution: 'PostToolUse',
    user_prompt_submit: 'UserPromptSubmit',
    post_tool_use: 'PostToolUse',
    stop: 'Stop',
    session_end: 'Stop',
  }[name] || name
}

function deriveSessionSourceType({ client, termProgram, vscodePid, terminalPid }) {
  const normalizedClient = String(client || '').toLowerCase()
  if (normalizedClient !== 'claude') return ''

  const hasVSCodePid = Number(vscodePid) > 1
  const hasTerminalPid = Number(terminalPid) > 1
  const normalizedTermProgram = String(termProgram || '').toLowerCase()

  if (hasVSCodePid && !hasTerminalPid) return 'vscode'
  if (hasTerminalPid) return 'tui'
  if (normalizedTermProgram.includes('vscode') || normalizedTermProgram.includes('code')) return 'vscode'
  if (normalizedTermProgram) return 'tui'
  return 'unknown'
}

// --- Focus session window ---
function focusSession(session) {
  const { terminalPid, vscodePid, cwd } = session

  if (isCodexSession(session)) {
    focusCodexThread(session)
    return
  }

  if (isCursorSession(session)) {
    focusCursorWindow(session)
    return
  }

  const focusByPid = (pid, fallback) => {
    const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`
    exec(`osascript -e '${script}'`, err => {
      if (err && typeof fallback === 'function') fallback()
    })
  }

  const focusTerminalApp = () => {
    const name = (session.terminalName || session.termProgram || '').toLowerCase()
    if (name.includes('ghostty')) exec('open -a "Ghostty"')
    else if (name.includes('iterm')) exec('open -a "iTerm"')
    else if (name.includes('warp')) exec('open -a "Warp"')
    else if (name.includes('wezterm')) exec('open -a "WezTerm"')
    else if (name.includes('alacritty')) exec('open -a "Alacritty"')
    else if (name.includes('kitty')) exec('open -a "kitty"')
    else if (name.includes('hyper')) exec('open -a "Hyper"')
    else if (name.includes('tabby')) exec('open -a "Tabby"')
    else exec('open -a "Terminal"')
  }

  const focusVSCodeApp = () => {
    if (cwd) exec(`open -a "Visual Studio Code" "${cwd}"`)
    else exec('open -a "Visual Studio Code"')
  }

  // VS Code: activate by PID
  if (vscodePid) {
    focusByPid(vscodePid, focusVSCodeApp)
    return
  }

  // Any terminal: activate the terminal process by PID (works for Ghostty, iTerm2, Terminal, Warp, etc.)
  if (terminalPid) {
    focusByPid(terminalPid, focusTerminalApp)
    return
  }

  // Last resort fallback for sessions started inside VS Code terminal
  const termName = (session.terminalName || session.termProgram || '').toLowerCase()
  if (termName.includes('vscode') || termName.includes('code')) {
    focusVSCodeApp()
    return
  }

  focusTerminalApp()
}

function isCodexSession(session) {
  return String(session.client || '').toLowerCase() === 'codex'
}

function isCursorSession(session) {
  return String(session.client || '').toLowerCase() === 'cursor'
}

function focusCodexThread(session) {
  const threadId = encodeURIComponent(session.id)
  exec(`open "codex://threads/${threadId}"`, err => {
    if (err) exec('open -a "ChatGPT"')
  })
}

function focusCursorWindow(session) {
  const focusLog = '/tmp/agent-rgb-focus.log'
  const log = message => fs.appendFile(focusLog, `[${new Date().toISOString()}] ${message}\n`, () => {})

  const activateCursorApp = (fallback = () => {}) => {
    exec('osascript -e \"tell application \\\"Cursor\\\" to activate\"', err => {
      if (err) {
        log(`cursor activate failed: ${err.message || err}`)
        fallback()
      } else {
        log('cursor activate ok')
      }
    })
  }

  const openCursorByCwd = (fallback = () => {}) => {
    const cwd = session.cwd || ''
    if (!cwd) {
      fallback()
      return
    }
    exec(`open -a "Cursor" "${cwd}"`, err => {
      if (err) {
        log(`open cursor by cwd failed: ${cwd} ${err.message || err}`)
        fallback()
      } else {
        log(`open cursor by cwd ok: ${cwd}`)
        activateCursorApp(fallback)
      }
    })
  }

  log(`focus cursor start id=${session.id} cwd=${session.cwd || ''} cursorPid=${session.cursorPid || ''}`)

  if (session.cwd) {
    openCursorByCwd(() => {
      const cursorPidFromSession = Number(session.cursorPid)
      if (Number.isFinite(cursorPidFromSession) && cursorPidFromSession > 1) {
        const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${cursorPidFromSession}) to true`
        exec(`osascript -e '${script}'`, err => {
          if (err) {
            log(`focus cursor pid failed after cwd open: pid=${cursorPidFromSession} ${err.message || err}`)
            activateCursorApp(() => exec('open -a "Cursor"'))
          } else {
            log(`focus cursor pid ok after cwd open: pid=${cursorPidFromSession}`)
            activateCursorApp(() => exec('open -a "Cursor"'))
          }
        })
        return
      }

      activateCursorApp(() => exec('open -a "Cursor"'))
    })
    return
  }

  const cursorPid = Number(session.cursorPid)
  if (Number.isFinite(cursorPid) && cursorPid > 1) {
    const script = `tell application "System Events" to set frontmost of (first process whose unix id is ${cursorPid}) to true`
    exec(`osascript -e '${script}'`, err => {
      if (err) {
        log(`focus cursor pid failed: pid=${cursorPid} ${err.message || err}`)
        openCursorByCwd(() => activateCursorApp(() => exec('open -a "Cursor"')))
      } else {
        log(`focus cursor pid ok: pid=${cursorPid}`)
        activateCursorApp(() => exec('open -a "Cursor"'))
      }
    })
    return
  }

  openCursorByCwd(() => activateCursorApp(() => exec('open -a "Cursor"')))
}

// --- IPC handlers ---
ipcMain.on('focus-session', (_, sessionId) => {
  const session = sessions.get(sessionId)
  if (!session) return
  focusSession(session)
  if (session.status === 'completed') {
    removeSession(sessionId)
  }
})

ipcMain.on('dismiss-session', (_, sessionId) => {
  removeSession(sessionId)
})

ipcMain.on('play-system-sound', (_, kind) => {
  const settings = readSettings()
  if (!getBooleanSetting(settings, 'soundEnabled', true)) return

  const soundFile = SYSTEM_SOUND_FILES[kind]
  if (!soundFile || !fs.existsSync(soundFile)) return
  exec(`afplay ${JSON.stringify(soundFile)} >/dev/null 2>&1 &`)
})

ipcMain.on('resize-window', (_, height) => {
  if (!win) return
  const { width } = screen.getPrimaryDisplay().workAreaSize
  const currentBounds = win.getBounds()
  win.setBounds({ x: currentBounds.x, y: currentBounds.y, width: currentBounds.width, height })
})

ipcMain.on('reposition', (_, { x, y, width, height }) => {
  if (!win) return
  win.setBounds({ x, y, width, height })
})

ipcMain.handle('get-sessions', () => Array.from(sessions.values()))

// --- macOS menu ---
function buildControlMenuItems() {
  const hookStatus = getInstallStatus()
  const settings = readSettings()
  const autoLaunchEnabled = getBooleanSetting(settings, 'autoLaunchEnabled', true)
  const soundEnabled = getBooleanSetting(settings, 'soundEnabled', true)
  const hookSummary = lastHookInstallResult
    ? Object.values(lastHookInstallResult.results)
      .map(result => `${result.name}: ${result.ok ? '已安装' : '失败'}`)
      .join('，')
    : '首次启动会自动安装'

  const recentSessions = listRecentSessions().slice(0, 8)
  const recentItems = recentSessions.length > 0
    ? recentSessions.map(session => ({
      label: formatRecentSessionLabel(session),
      submenu: [
        {
          label: '打开该会话',
          click: () => openRecentSession(session.id),
        },
        {
          label: `路径：${formatRecentSessionPath(session)}`,
          enabled: false,
        },
      ],
    }))
    : [{ label: '暂无会话', enabled: false }]

  return [
    {
      label: '开机自启',
      type: 'checkbox',
      checked: autoLaunchEnabled,
      click: menuItem => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked })
        patchSettings({ autoLaunchEnabled: menuItem.checked })
        buildApplicationMenu()
      },
    },
    {
      label: '音效',
      type: 'checkbox',
      checked: soundEnabled,
      click: menuItem => {
        patchSettings({ soundEnabled: menuItem.checked })
        buildApplicationMenu()
      },
    },
    { type: 'separator' },
    {
      label: '支持的 App',
      submenu: [
        { label: `Claude Code ${hookStatus.claudeCode ? '✓ Hook 已安装' : 'Hook 未安装'}`, enabled: false },
        { label: `Codex ${hookStatus.codex ? '✓ Hook 已安装' : 'Hook 未安装'}`, enabled: false },
        { label: `Cursor ${hookStatus.cursor ? '✓ Hook 已安装' : 'Hook 未安装'}`, enabled: false },
      ],
    },
    {
      label: '最近会话（按操作时间）',
      submenu: recentItems,
    },
    { label: `Hook 状态：${hookSummary}`, enabled: false },
    {
      label: '重新安装 Hooks',
      click: () => {
        installHooksAndRefreshMenu(true)
      },
    },
    { type: 'separator' },
    { label: '退出 AgentRGB', role: 'quit' },
  ]
}

function ensureTrayMenu() {
  if (!tray) {
    const trayIcon = nativeImage.createFromPath(APP_ICON).resize({ width: 18, height: 18 })
    tray = new Tray(trayIcon)
    tray.setToolTip('AgentRGB')
  }

  tray.setContextMenu(Menu.buildFromTemplate(buildControlMenuItems()))
}

function buildApplicationMenu() {
  const controlItems = buildControlMenuItems()

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'AgentRGB',
      submenu: controlItems,
    },
  ]))

  ensureTrayMenu()
}

function installHooksAndRefreshMenu(force = false) {
  setImmediate(() => {
    const settings = readSettings()
    const hookStatus = getInstallStatus()
    const installedForVersion = settings.hooksInstalledForVersion === app.getVersion()
    if (!force && installedForVersion && hookStatus.claudeCode && hookStatus.codex && hookStatus.cursor) return

    lastHookInstallResult = installAll()
    if (lastHookInstallResult.ok) {
      writeSettings({ ...settings, hooksInstalledForVersion: app.getVersion() })
    }
    buildApplicationMenu()
  })
}

// --- App lifecycle ---
app.dock.hide()

app.whenReady().then(() => {
  const settings = readSettings()
  const autoLaunchEnabled = getBooleanSetting(settings, 'autoLaunchEnabled', true)
  const soundEnabled = getBooleanSetting(settings, 'soundEnabled', true)
  patchSettings({ autoLaunchEnabled, soundEnabled })
  app.setLoginItemSettings({ openAtLogin: autoLaunchEnabled })

  if (process.platform === 'darwin' && fs.existsSync(APP_ICON)) {
    app.dock.setIcon(APP_ICON)
  }
  buildApplicationMenu()
  loadSessions()
  startHttpServer()
  createWindow()
  installHooksAndRefreshMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep running on macOS
})
