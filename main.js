const { app, BrowserWindow, ipcMain, screen } = require('electron')
const http = require('http')
const path = require('path')
const fs = require('fs')
const { exec } = require('child_process')

const PORT = 27420
const SESSIONS_FILE = path.join(__dirname, 'sessions.json')

// --- Session state store ---
const sessions = new Map()

function loadSessions() {
  sessions.clear()
  saveSessions()
}

function saveSessions() {
  const obj = {}
  for (const [id, s] of sessions) obj[id] = s
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2))
}

function upsertSession(id, patch) {
  const existing = sessions.get(id) || {}
  sessions.set(id, { ...existing, id, ...patch })
  saveSessions()
  broadcastSessions()
}

function removeSession(id) {
  sessions.delete(id)
  saveSessions()
  broadcastSessions()
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
        fs.writeFileSync('/tmp/agent-board-render.png', png)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ saved: '/tmp/agent-board-render.png', bytes: png.length, bounds: win.getBounds() }))
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
  } = event

  if (!session_id) return

  const eventName = normalizeHookEventName(hook_event_name || hook_event?.event_type)
  const label = event_label || (cwd ? path.basename(cwd) : session_id.slice(0, 8))

  const sessionPatch = {
    label,
    cwd,
    client,
    termProgram: term_program,
    itermSession: iterm_session,
    vscodePid: vscode_pid,
    tty,
    terminalPid: terminal_pid,
    terminalName: terminal_name,
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
    if (tool_name === 'AskUserQuestion') {
      upsertSession(session_id, { ...sessionPatch, status: 'waiting' })
    } else {
      const existing = sessions.get(session_id)
      if (existing && existing.status !== 'waiting') {
        upsertSession(session_id, { ...sessionPatch, status: 'running' })
      }
    }
    return
  }

  if (eventName === 'PostToolUse') {
    const existing = sessions.get(session_id)
    if (existing && existing.status === 'waiting') return
    upsertSession(session_id, { ...sessionPatch, status: 'running' })
  }
}

function normalizeHookEventName(name = '') {
  return {
    user_prompt_submit: 'UserPromptSubmit',
    pre_tool_use: 'PreToolUse',
    post_tool_use: 'PostToolUse',
    stop: 'Stop',
    session_end: 'Stop',
  }[name] || name
}

// --- Focus session window ---
function focusSession(session) {
  const { terminalPid, vscodePid, cwd } = session

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

// --- App lifecycle ---
app.dock.hide()
app.setLoginItemSettings({ openAtLogin: true })

app.whenReady().then(() => {
  loadSessions()
  startHttpServer()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Keep running on macOS
})
