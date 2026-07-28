const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')
const { exec } = require('child_process')
const { getInstallStatus, installAll } = require('./scripts/install-hooks')

const PORT = 27420
const APP_ICON = path.join(__dirname, 'assets', 'app-icon.png')
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
  return recents
    .filter(item => item && typeof item.id === 'string')
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
}

function recordRecentSession(session) {
  if (!session || !session.id) return
  const settings = readSettings()
  const recents = Array.isArray(settings.recentSessions) ? settings.recentSessions : []
  const nextSession = {
    id: session.id,
    label: session.label,
    cwd: session.cwd,
    client: session.client,
    status: session.status,
    updatedAt: Number(session.updatedAt || Date.now()),
    terminalPid: session.terminalPid,
    terminalName: session.terminalName,
    termProgram: session.termProgram,
    vscodePid: session.vscodePid,
    cursorPid: session.cursorPid,
    cursorName: session.cursorName,
  }

  const deduped = [nextSession, ...recents.filter(item => item && item.id !== session.id)]
  settings.recentSessions = deduped
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, MAX_RECENT_SESSIONS)

  writeSettings(settings)
}

function clientName(client = '') {
  const normalized = String(client || '').toLowerCase()
  if (normalized === 'codex') return 'Codex'
  if (normalized === 'cursor') return 'Cursor'
  if (normalized === 'claude') return 'Claude'
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : 'Unknown'
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
  if (activeSession) {
    focusSession(activeSession)
    return
  }

  const recentSession = listRecentSessions().find(item => item.id === sessionId)
  if (!recentSession) return
  focusSession(recentSession)
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

  if (!session_id) return

  const eventName = normalizeHookEventName(hook_event_name || hook_event?.event_type)
  const label = event_label || (cwd ? path.basename(cwd) : session_id.slice(0, 8))
  const normalizedClient = client || 'claude'

  const sessionPatch = {
    label,
    cwd,
    client: normalizedClient,
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
    upsertSession(session_id, { ...sessionPatch, status: 'running' })
    return
  }

  // Only update state if session already exists (was created by UserPromptSubmit)
  if (!sessions.has(session_id)) return

  if (eventName === 'Stop') {
    upsertSession(session_id, { ...sessionPatch, status: 'completed' })
    return
  }

  if (eventName === 'PreToolUse') {
    if (isWaitingTool(tool_name)) {
      upsertSession(session_id, { ...sessionPatch, status: 'waiting' })
    } else {
      upsertSession(session_id, { ...sessionPatch, status: 'running' })
    }
    return
  }

  if (eventName === 'PostToolUse') {
    upsertSession(session_id, { ...sessionPatch, status: 'running' })
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
