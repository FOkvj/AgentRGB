#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const os = require('os')

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const HOOK_SCRIPT = path.join(os.homedir(), 'Documents', 'agent-board', 'hooks', 'claude-hook.sh')
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml')
const CODEX_HOOK_SCRIPT = path.join(os.homedir(), 'Documents', 'agent-board', 'hooks', 'codex-hook.sh')

let settings = {}
try {
  settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
} catch {
  console.log('No existing settings.json, creating new one')
}

if (!settings.hooks) settings.hooks = {}

const hookEvents = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
]

const hookCommand = { type: 'command', command: HOOK_SCRIPT }
const hookEntry = { matcher: '', hooks: [hookCommand] }

function isAgentBoardHookEntry(entry) {
  if (!entry || typeof entry !== 'object') return false
  if (entry.command === HOOK_SCRIPT) return true
  return Array.isArray(entry.hooks) && entry.hooks.some(h => h && h.command === HOOK_SCRIPT)
}

for (const event of hookEvents) {
  const existingEntries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
  settings.hooks[event] = [
    ...existingEntries.filter(entry => !isAgentBoardHookEntry(entry)),
    hookEntry,
  ]
}

// Remove any invalid events that may have been installed previously
const validEvents = new Set(hookEvents)
for (const event of Object.keys(settings.hooks)) {
  if (!validEvents.has(event)) {
    // Remove AgentBoard entries from invalid events
    settings.hooks[event] = settings.hooks[event].filter(entry => !isAgentBoardHookEntry(entry))
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
}

fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2))
console.log('✓ AgentBoard hooks installed:', hookEvents.join(', '))
console.log('  Hook script:', HOOK_SCRIPT)

installCodexHooks()

function installCodexHooks() {
  const startMarker = '# >>> AgentBoard Codex Hooks >>>'
  const endMarker = '# <<< AgentBoard Codex Hooks <<<'
  let config = ''

  try {
    config = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8')
  } catch {
    console.log('No existing Codex config.toml, creating new one')
  }

  const withoutOldBlock = config.replace(
    new RegExp(`\\n?${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`, 'g'),
    '\n'
  ).trimEnd()

  const command = `bash ${JSON.stringify(CODEX_HOOK_SCRIPT)}`
  const codexBlock = [
    startMarker,
    '[hooks]',
    ...hookEvents.flatMap((event) => [
      `${event} = [`,
      `  { hooks = [ { type = "command", command = ${JSON.stringify(command)} } ] },`,
      ']',
    ]),
    endMarker,
    '',
  ].join('\n')

  fs.mkdirSync(path.dirname(CODEX_CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CODEX_CONFIG_PATH, `${withoutOldBlock}\n\n${codexBlock}`)
  fs.chmodSync(CODEX_HOOK_SCRIPT, 0o755)
  console.log('✓ AgentBoard Codex hooks installed:', hookEvents.join(', '))
  console.log('  Hook script:', CODEX_HOOK_SCRIPT)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
