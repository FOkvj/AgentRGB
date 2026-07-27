#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const os = require('os')
const childProcess = require('child_process')
const crypto = require('crypto')

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const HOOK_SCRIPT = path.join(os.homedir(), 'Documents', 'agent-board', 'hooks', 'claude-hook.sh')
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml')
const CODEX_HOOK_SCRIPT = path.join(os.homedir(), 'Documents', 'agent-board', 'hooks', 'codex-hook.sh')
const CODEX_MARKETPLACE_PATH = path.join(os.homedir(), 'claude-plugins-user-marketplace')
const CODEX_PLUGIN_NAME = 'agent-board'
const CODEX_PLUGIN_SELECTOR = `${CODEX_PLUGIN_NAME}@user-local-official-plugins`
const CODEX_PLUGIN_PATH = path.join(CODEX_MARKETPLACE_PATH, 'plugins', CODEX_PLUGIN_NAME)

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
  const withoutOldDirectHooks = removeLegacyCodexHooks(withoutOldBlock)

  fs.mkdirSync(path.dirname(CODEX_CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CODEX_CONFIG_PATH, `${withoutOldDirectHooks.trimEnd()}\n`)
  fs.chmodSync(CODEX_HOOK_SCRIPT, 0o755)

  installCodexPluginFiles()
  childProcess.execFileSync('codex', ['plugin', 'add', CODEX_PLUGIN_SELECTOR], { stdio: 'inherit' })
  trustCodexPluginHooks()

  console.log('✓ AgentBoard Codex hooks installed:', hookEvents.join(', '))
  console.log('  Codex plugin:', CODEX_PLUGIN_SELECTOR)
  console.log('  Plugin path:', CODEX_PLUGIN_PATH)
}

function installCodexPluginFiles() {
  const pluginMetaDir = path.join(CODEX_PLUGIN_PATH, '.claude-plugin')
  const pluginHooksDir = path.join(CODEX_PLUGIN_PATH, 'hooks')

  fs.mkdirSync(pluginMetaDir, { recursive: true })
  fs.mkdirSync(pluginHooksDir, { recursive: true })
  fs.mkdirSync(path.join(CODEX_MARKETPLACE_PATH, '.claude-plugin'), { recursive: true })

  fs.writeFileSync(path.join(pluginMetaDir, 'plugin.json'), JSON.stringify({
    name: CODEX_PLUGIN_NAME,
    version: '1.0.0',
    description: 'Event-driven AgentBoard integration for Codex sessions.',
    author: { name: 'AgentBoard' },
  }, null, 2))

  const pluginHookScript = path.join(pluginHooksDir, 'codex-hook.sh')
  fs.copyFileSync(CODEX_HOOK_SCRIPT, pluginHookScript)
  fs.chmodSync(pluginHookScript, 0o755)

  const pluginHookCommand = 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/codex-hook.sh"'
  const hooks = Object.fromEntries(hookEvents.map(event => [
    event,
    [{ hooks: [{ type: 'command', command: pluginHookCommand }] }],
  ]))
  fs.writeFileSync(path.join(pluginHooksDir, 'hooks.json'), JSON.stringify({ hooks }, null, 2))

  const marketplacePath = path.join(CODEX_MARKETPLACE_PATH, '.claude-plugin', 'marketplace.json')
  let marketplace = { name: 'user-local-official-plugins', owner: { name: 'Local' }, plugins: [] }
  try {
    marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'))
  } catch {}

  const pluginEntry = {
    name: CODEX_PLUGIN_NAME,
    description: 'Event-driven AgentBoard integration for Codex sessions.',
    author: { name: 'AgentBoard' },
    source: './plugins/agent-board',
    category: 'productivity',
  }
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : []
  marketplace.plugins = [
    ...plugins.filter(plugin => plugin && plugin.name !== CODEX_PLUGIN_NAME),
    pluginEntry,
  ]
  fs.writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2))
}

function trustCodexPluginHooks() {
  let config = ''
  try {
    config = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8')
  } catch {
    return
  }

  const command = 'bash "${CLAUDE_PLUGIN_ROOT}/hooks/codex-hook.sh"'
  for (const event of hookEvents) {
    const key = `${CODEX_PLUGIN_SELECTOR}:hooks/hooks.json:${hookEventStateKey(event)}:0:0`
    const trustedHash = commandHookHash(hookEventStateKey(event), command)
    config = upsertTrustedHash(config, key, trustedHash)
  }
  fs.writeFileSync(CODEX_CONFIG_PATH, config.trimEnd() + '\n')
}

function hookEventStateKey(event) {
  return event.replace(/[A-Z]/g, (letter, index) => `${index === 0 ? '' : '_'}${letter.toLowerCase()}`)
}

function commandHookHash(eventName, command) {
  const identity = {
    event_name: eventName,
    hooks: [{
      async: false,
      command,
      timeout: 600,
      type: 'command',
    }],
  }
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalJson(identity)))
    .digest('hex')}`
}

function canonicalJson(input) {
  if (Array.isArray(input)) return input.map(canonicalJson)
  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.keys(input).sort().map(key => [key, canonicalJson(input[key])])
    )
  }
  return input
}

function upsertTrustedHash(config, key, trustedHash) {
  const header = `[hooks.state.${JSON.stringify(key)}]`
  const lines = config.split('\n')
  const start = lines.findIndex(line => line === header)

  if (start === -1) {
    return `${config.trimEnd()}\n\n${header}\ntrusted_hash = ${JSON.stringify(trustedHash)}\n`
  }

  let end = start + 1
  while (end < lines.length && !lines[end].startsWith('[')) end += 1

  const block = lines.slice(start, end)
  const hashLine = `trusted_hash = ${JSON.stringify(trustedHash)}`
  const hashIndex = block.findIndex(line => line.trimStart().startsWith('trusted_hash'))
  if (hashIndex === -1) {
    block.push(hashLine)
  } else {
    block[hashIndex] = hashLine
  }

  return [
    ...lines.slice(0, start),
    ...block,
    ...lines.slice(end),
  ].join('\n')
}

function removeLegacyCodexHooks(config) {
  const lines = config.split('\n')
  const nextLines = []
  let index = 0

  while (index < lines.length) {
    const event = hookEvents.find(name => lines[index] === `[[hooks.${name}]]`)
    if (!event) {
      nextLines.push(lines[index])
      index += 1
      continue
    }

    const block = []
    while (index < lines.length) {
      const line = lines[index]
      const isNextHook = line.startsWith('[[hooks.') &&
        line !== `[[hooks.${event}]]` &&
        line !== `[[hooks.${event}.hooks]]`
      const isNextSection = line.startsWith('[') && !line.startsWith('[[hooks.')
      if (block.length > 0 && (isNextHook || isNextSection)) break
      block.push(line)
      index += 1
    }

    if (!block.join('\n').includes(CODEX_HOOK_SCRIPT)) {
      nextLines.push(...block)
    }
  }

  return nextLines.join('\n').replace(/\n{3,}/g, '\n\n')
}


function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
