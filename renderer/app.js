const bar = document.getElementById('bar')
const container = document.getElementById('sessions-container')
const collapsedDots = document.getElementById('collapsed-dots')
const toggleBtn = document.getElementById('toggle-btn')

let collapsed = false
let currentSessions = []
let collapseTimer = null
let expandTimer = null
let autoCollapseTimer = null

function playStatusSound(kind) {
  window.agentLight.playSystemSound(kind)
}

// --- Render sessions ---
function render(sessions) {
  const transitions = detectStatusTransitions(currentSessions, sessions)
  const statusChanged = transitions.changed

  if (transitions.becameRunning) playStatusSound('yellow')
  if (transitions.becameWaiting) playStatusSound('red')
  if (transitions.becameCompleted) playStatusSound('green')

  currentSessions = sessions
  renderCollapsedDots(sessions)
  container.classList.toggle('scrollable', sessions.length > 6)
  container.innerHTML = ''

  if (!sessions.length) {
    const hint = document.createElement('span')
    hint.className = 'empty-hint'
    hint.textContent = 'No active sessions'
    container.appendChild(hint)
    adjustWidth(0)
    return
  }

  for (const s of sessions) {
    const pill = document.createElement('div')
    pill.className = `session-pill ${s.status}`
    pill.dataset.id = s.id
    pill.title = s.cwd || s.id

    const dot = document.createElement('span')
    dot.className = 'dot'

    const lbl = document.createElement('span')
    lbl.className = 'label'
    lbl.textContent = s.label || s.id.slice(0, 8)

    const closeBtn = document.createElement('button')
    closeBtn.className = 'dismiss-btn'
    closeBtn.type = 'button'
    closeBtn.textContent = '×'
    closeBtn.title = 'Remove session'
    closeBtn.setAttribute('aria-label', 'Remove session')

    pill.appendChild(dot)
    pill.appendChild(lbl)
    pill.appendChild(closeBtn)

    pill.addEventListener('click', () => {
      window.agentLight.focusSession(s.id)
    })

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      window.agentLight.dismissSession(s.id)
    })

    container.appendChild(pill)
  }

  adjustWidth(sessions.length)

  if (statusChanged) revealForStatusChange()
  else if (!collapsed && sessions.length > 0) scheduleAutoCollapse()
}

function detectStatusTransitions(previousSessions, nextSessions) {
  const previousStatusById = new Map(previousSessions.map((s) => [s.id, s.status]))
  let changed = false
  let becameRunning = false
  let becameWaiting = false
  let becameCompleted = false

  for (const session of nextSessions) {
    if (!previousStatusById.has(session.id)) {
      if (session.status === 'running') becameRunning = true
      continue
    }
    const previousStatus = previousStatusById.get(session.id)
    if (previousStatus === session.status) continue
    changed = true
    if (session.status === 'running') becameRunning = true
    if (session.status === 'waiting') becameWaiting = true
    if (session.status === 'completed') becameCompleted = true
  }

  return { changed, becameRunning, becameWaiting, becameCompleted }
}

function revealForStatusChange() {
  expand()
  scheduleAutoCollapse(true)
}

function scheduleAutoCollapse(reset = false) {
  if (reset) cancelAutoCollapse()
  if (autoCollapseTimer || collapsed || currentSessions.length === 0) return
  autoCollapseTimer = setTimeout(() => {
    autoCollapseTimer = null
    collapse()
  }, 3000)
}

function cancelAutoCollapse() {
  clearTimeout(autoCollapseTimer)
  autoCollapseTimer = null
}

function renderCollapsedDots(sessions) {
  collapsedDots.innerHTML = ''

  for (const s of sessions.slice(0, 12)) {
    const dot = document.createElement('span')
    dot.className = `collapsed-dot ${s.status}`
    collapsedDots.appendChild(dot)
  }
}

// --- Window sizing ---
function adjustWidth(count) {
  if (collapsed) return
  const pillW = 148
  const gap = 5
  const chrome = 6 + 28 + 12  // drag handle + toggle btn + padding
  const maxWidth = Math.max(190, window.screen.width - 48)
  const visibleCount = Math.min(count, 6)
  const contentW = count > 0
    ? visibleCount * (pillW + gap) - gap
    : 130
  const total = Math.min(maxWidth, Math.max(190, contentW + chrome + 24))
  positionBar(total, 44)
}

function positionBar(width, height) {
  const screenW = window.screen.width
  const x = Math.round((screenW - width) / 2)
  window.agentLight.reposition({ x, y: 0, width, height })
}

// --- Collapse / expand (silky smooth) ---
function collapse() {
  if (collapsed || bar.classList.contains('minimizing')) return
  clearTimeout(collapseTimer)
  clearTimeout(expandTimer)
  cancelAutoCollapse()
  bar.classList.remove('expanding', 'collapsed-pop')
  bar.classList.add('minimizing')
  toggleBtn.textContent = '▼'
  collapseTimer = setTimeout(() => {
    collapsed = true
    bar.classList.remove('minimizing')
    bar.classList.add('collapsed', 'collapsed-pop')
    const screenW = window.screen.width
    window.agentLight.reposition({ x: Math.round((screenW - 164) / 2), y: 0, width: 164, height: 10 })
    expandTimer = setTimeout(() => {
      bar.classList.remove('collapsed-pop')
    }, 320)
  }, 360)
}

function expand() {
  clearTimeout(collapseTimer)
  clearTimeout(expandTimer)
  collapsed = false
  toggleBtn.textContent = '▲'
  adjustWidth(currentSessions.length)
  window.agentLight.resizeWindow(44)
  bar.classList.remove('collapsed', 'minimizing', 'collapsed-pop')
  bar.classList.add('expanding')
  expandTimer = setTimeout(() => {
    bar.classList.remove('expanding')
  }, 360)
  scheduleAutoCollapse()
}

toggleBtn.addEventListener('click', (e) => {
  e.stopPropagation()
  cancelAutoCollapse()
  collapsed ? expand() : collapse()
})

// Hover collapsed bar to expand
bar.addEventListener('mouseenter', () => {
  if (collapsed) expand()
})

container.addEventListener('wheel', (e) => {
  if (container.scrollWidth <= container.clientWidth) return
  e.preventDefault()
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
  container.scrollLeft += delta
}, { passive: false })

// --- Init ---
async function init() {
  const sessions = await window.agentLight.getSessions()
  render(sessions)

  window.agentLight.onSessionsUpdate((sessions) => {
    render(sessions)
  })
}

init()
