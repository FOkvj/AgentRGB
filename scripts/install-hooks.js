#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const os = require('os')
const childProcess = require('child_process')
const crypto = require('crypto')

const APP_SUPPORT_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AgentBoard')
const INSTALLED_HOOKS_DIR = path.join(APP_SUPPORT_DIR, 'hooks')
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
const CLAUDE_HOOK_SCRIPT = path.join(INSTALLED_HOOKS_DIR, 'claude-hook.sh')
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml')
const CODEX_HOOK_SCRIPT = path.join(INSTALLED_HOOKS_DIR, 'codex-hook.sh')
const CODEX_MARKETPLACE_PATH = path.join(os.homedir(), 'claude-plugins-user-marketplace')
const CODEX_PLUGIN_NAME = 'agent-board'
const CODEX_PLUGIN_SELECTOR = `${CODEX_PLUGIN_NAME}@user-local-official-plugins`
const CODEX_PLUGIN_PATH = path.join(CODEX_MARKETPLACE_PATH, 'plugins', CODEX_PLUGIN_NAME)
const CURSOR_HOME = path.join(os.homedir(), '.cursor')
const CURSOR_HOOKS_DIR = path.join(CURSOR_HOME, 'hooks')
const CURSOR_HOOKS_PATH = path.join(CURSOR_HOME, 'hooks.json')
const CURSOR_HOOK_SCRIPT = path.join(CURSOR_HOOKS_DIR, 'cursor-hook.sh')
const HOOKS_SOURCE_DIR = path.join(path.resolve(__dirname, '..'), 'hooks')

const hookEvents = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
]

function installAll(options = {}) {
  installHookScripts()

  const results = {
    claudeCode: runInstaller('Claude Code', installClaudeHooks),
    codex: runInstaller('Codex', () => installCodexHooks(options)),
    cursor: runInstaller('Cursor', installCursorHooks),
  }

  return {
    ok: results.claudeCode.ok && results.codex.ok && results.cursor.ok,
    results,
  }
}

function runInstaller(name, install) {
  try {
    install()
    return { ok: true, name }
  } catch (error) {
    return { ok: false, name, error: error.message }
  }
}

function installHookScripts() {
  fs.mkdirSync(INSTALLED_HOOKS_DIR, { recursive: true })

  for (const script of ['claude-hook.sh', 'codex-hook.sh']) {
    const source = path.join(HOOKS_SOURCE_DIR, script)
    const target = path.join(INSTALLED_HOOKS_DIR, script)
    fs.copyFileSync(source, target)
    fs.chmodSync(target, 0o755)
  }
}

function installCursorHooks() {
  fs.mkdirSync(CURSOR_HOOKS_DIR, { recursive: true })

  const source = path.join(HOOKS_SOURCE_DIR, 'cursor-hook.sh')
  fs.copyFileSync(source, CURSOR_HOOK_SCRIPT)
  fs.chmodSync(CURSOR_HOOK_SCRIPT, 0o755)

  let hooksConfig = { version: 1, hooks: {} }
  try {
    hooksConfig = JSON.parse(fs.readFileSync(CURSOR_HOOKS_PATH, 'utf8'))
  } catch {}

  if (!hooksConfig || typeof hooksConfig !== 'object') hooksConfig = { version: 1, hooks: {} }
  if (typeof hooksConfig.version !== 'number') hooksConfig.version = 1
  if (!hooksConfig.hooks || typeof hooksConfig.hooks !== 'object') hooksConfig.hooks = {}

  const cursorEvents = ['beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'stop']
  const hookEntry = { type: 'command', command: `bash ${JSON.stringify(CURSOR_HOOK_SCRIPT)}` }

  for (const event of cursorEvents) {
    const entries = Array.isArray(hooksConfig.hooks[event]) ? hooksConfig.hooks[event] : []
    hooksConfig.hooks[event] = [
      ...entries.filter(entry => !isAgentBoardCursorHookEntry(entry)),
      hookEntry,
    ]
  }

  fs.writeFileSync(CURSOR_HOOKS_PATH, JSON.stringify(hooksConfig, null, 2))
}

function installClaudeHooks() {
  let settings = {}
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {}

  if (!settings.hooks) settings.hooks = {}

  const hookCommand = { type: 'command', command: `bash ${JSON.stringify(CLAUDE_HOOK_SCRIPT)}` }
  const hookEntry = { matcher: '', hooks: [hookCommand] }

  for (const event of hookEvents) {
    const existingEntries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    settings.hooks[event] = [
      ...existingEntries.filter(entry => !isAgentBoardClaudeHookEntry(entry)),
      hookEntry,
    ]
  }

  const validEvents = new Set(hookEvents)
  for (const event of Object.keys(settings.hooks)) {
    if (!validEvents.has(event) && Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = settings.hooks[event].filter(entry => !isAgentBoardClaudeHookEntry(entry))
      if (settings.hooks[event].length === 0) delete settings.hooks[event]
    }
  }

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true })
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2))
}

function installCodexHooks(options = {}) {
  let config = ''
  try {
    config = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8')
  } catch {}

  const withoutOldBlock = config.replace(
    new RegExp(`\\n?${escapeRegExp('# >>> AgentBoard Codex Hooks >>>')}[\\s\\S]*?${escapeRegExp('# <<< AgentBoard Codex Hooks <<<')}\\n?`, 'g'),
    '\n'
  ).trimEnd()
  const withoutOldDirectHooks = removeLegacyCodexHooks(withoutOldBlock)

  fs.mkdirSync(path.dirname(CODEX_CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CODEX_CONFIG_PATH, `${withoutOldDirectHooks.trimEnd()}\n`)

  installCodexPluginFiles()
  childProcess.execFileSync(resolveExecutable('codex'), ['plugin', 'add', CODEX_PLUGIN_SELECTOR], {
    stdio: options.verbose ? 'inherit' : 'pipe',
    timeout: 15000,
  })
  trustCodexPluginHooks()
}

function resolveExecutable(name) {
  const searchDirs = [
    ...String(process.env.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
  ].filter(Boolean)

  for (const dir of searchDirs) {
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }

  return name
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

function getInstallStatus() {
  return {
    claudeCode: isClaudeHookInstalled(),
    codex: isCodexHookInstalled(),
    cursor: isCursorHookInstalled(),
  }
}

function isClaudeHookInstalled() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    return hookEvents.every(event => {
      const entries = Array.isArray(settings.hooks?.[event]) ? settings.hooks[event] : []
      return entries.some(entry => entryCommands(entry).some(isAgentBoardClaudeCommand))
    })
  } catch {
    return false
  }
}

function isCodexHookInstalled() {
  try {
    const hooksJson = path.join(CODEX_PLUGIN_PATH, 'hooks', 'hooks.json')
    const pluginScript = path.join(CODEX_PLUGIN_PATH, 'hooks', 'codex-hook.sh')
    const config = fs.readFileSync(CODEX_CONFIG_PATH, 'utf8')
    return fs.existsSync(hooksJson) &&
      fs.existsSync(pluginScript) &&
      hookEvents.every(event => config.includes(`${CODEX_PLUGIN_SELECTOR}:hooks/hooks.json:${hookEventStateKey(event)}:0:0`))
  } catch {
    return false
  }
}

function isCursorHookInstalled() {
  try {
    const hooksConfig = JSON.parse(fs.readFileSync(CURSOR_HOOKS_PATH, 'utf8'))
    const events = ['beforeSubmitPrompt', 'preToolUse', 'postToolUse', 'stop']
    return fs.existsSync(CURSOR_HOOK_SCRIPT) && events.every(event => {
      const entries = Array.isArray(hooksConfig.hooks?.[event]) ? hooksConfig.hooks[event] : []
      return entries.some(entry => entryCommands(entry).some(isAgentBoardCursorCommand))
    })
  } catch {
    return false
  }
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

function isAgentBoardClaudeHookEntry(entry) {
  return entryCommands(entry).some(isAgentBoardClaudeCommand)
}

function isAgentBoardCursorHookEntry(entry) {
  return entryCommands(entry).some(isAgentBoardCursorCommand)
}

function entryCommands(entry) {
  if (!entry || typeof entry !== 'object') return []
  const commands = []
  if (typeof entry.command === 'string') commands.push(entry.command)
  if (Array.isArray(entry.hooks)) {
    for (const hook of entry.hooks) {
      if (hook && typeof hook.command === 'string') commands.push(hook.command)
    }
  }
  return commands
}

function isAgentBoardClaudeCommand(command) {
  return command === CLAUDE_HOOK_SCRIPT ||
    command === `bash ${JSON.stringify(CLAUDE_HOOK_SCRIPT)}` ||
    /agent[- ]?board|AgentBoard/.test(command) && command.includes('claude-hook.sh')
}

function isAgentBoardCursorCommand(command) {
  return command === CURSOR_HOOK_SCRIPT ||
    command === `bash ${JSON.stringify(CURSOR_HOOK_SCRIPT)}` ||
    /agent[- ]?board|AgentBoard/.test(command) && command.includes('cursor-hook.sh')
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

    if (!block.join('\n').match(/(agent[- ]?board|AgentBoard)[\s\S]*codex-hook\.sh/)) {
      nextLines.push(...block)
    }
  }

  return nextLines.join('\n').replace(/\n{3,}/g, '\n\n')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = {
  APP_SUPPORT_DIR,
  INSTALLED_HOOKS_DIR,
  CLAUDE_HOOK_SCRIPT,
  CODEX_HOOK_SCRIPT,
  CURSOR_HOOK_SCRIPT,
  CODEX_PLUGIN_SELECTOR,
  CODEX_PLUGIN_PATH,
  getInstallStatus,
  installAll,
}

if (require.main === module) {
  const result = installAll({ verbose: true })
  for (const [key, appResult] of Object.entries(result.results)) {
    if (appResult.ok) {
      console.log(`✓ ${appResult.name} hooks installed`)
    } else {
      console.error(`✗ ${appResult.name} hooks failed: ${appResult.error}`)
    }
  }
  process.exit(result.ok ? 0 : 1)
}
