#!/bin/bash
# Cursor hook — sends session events to AgentLight Electron app

INPUT=$(cat)
LOG="/tmp/agent-light-cursor-hook.log"
RAW_LOG="/tmp/agent-light-cursor-hook-raw.log"

printf '%s\n' "$INPUT" >> "$RAW_LOG"

EVENT=$(echo "$INPUT" | node -e "
process.stdin.resume();
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const obj = JSON.parse(d);
    const raw = String(
      obj.hook_event_name ||
      obj.hookEventName ||
      obj.event_name ||
      obj.eventName ||
      obj.event ||
      obj.type || ''
    );
    const map = {
      before_submit_prompt: 'UserPromptSubmit',
      user_prompt_submit: 'UserPromptSubmit',
      pre_tool_use: 'PreToolUse',
      before_shell_execution: 'PreToolUse',
      before_mcp_execution: 'PreToolUse',
      post_tool_use: 'PostToolUse',
      post_tool_use_failure: 'PostToolUse',
      after_shell_execution: 'PostToolUse',
      after_mcp_execution: 'PostToolUse',
      stop: 'Stop',
      session_end: 'Stop',
    };
    process.stdout.write(map[raw] || map[raw.replace(/[A-Z]/g, m => '_' + m.toLowerCase())] || raw);
  } catch {}
});
" 2>/dev/null)

case "$EVENT" in
  UserPromptSubmit|PreToolUse|PostToolUse|Stop) ;;
  *) echo "$INPUT"; exit 0 ;;
esac

echo "[$(date '+%H:%M:%S')] event=$EVENT PPID=$PPID" >> "$LOG"

_find_cursor_pid() {
  local pid=$PPID
  local helper_pid=''
  for i in 1 2 3 4 5 6 7 8; do
    local name
    name=$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')
    local lower
    lower=$(echo "$name" | tr '[:upper:]' '[:lower:]')
    if echo "$lower" | grep -q '/applications/cursor\.app/contents/macos/cursor$'; then
      echo "$pid $name"
      return
    fi
    if echo "$lower" | grep -qE 'cursorhelper|cursor helper'; then
      helper_pid="$pid $name"
    fi
    local ppid
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$ppid" ] || [ "$ppid" -le 1 ] && break
    pid=$ppid
  done

  if [ -n "$helper_pid" ]; then
    echo "$helper_pid"
  fi
}

_launch_agent_light() {
  local app_path
  for app_path in \
    "/Applications/AgentLight.app" \
    "$HOME/Applications/AgentLight.app" \
    "$HOME/Documents/agent-light/dist/AgentLight.app"; do
    if [ -d "$app_path" ]; then
      open -gj "$app_path" >> /tmp/agent-light.log 2>&1
      sleep 1
      return
    fi
  done
}

CURSOR_INFO=$(_find_cursor_pid)
export AGENT_LIGHT_CURSOR_PID=$(echo "$CURSOR_INFO" | awk '{print $1}')
export AGENT_LIGHT_CURSOR_NAME=$(echo "$CURSOR_INFO" | awk '{print $2}')

PAYLOAD=$(echo "$INPUT" | node -e "
const path = require('path');
process.stdin.resume();
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const obj = JSON.parse(d);
    const rawEvent = String(
      obj.hook_event_name ||
      obj.hookEventName ||
      obj.event_name ||
      obj.eventName ||
      obj.event ||
      obj.type ||
      process.env.AGENT_LIGHT_EVENT || ''
    );
    const normalized = rawEvent.replace(/[A-Z]/g, m => '_' + m.toLowerCase()).replace(/^_/, '');
    const eventMap = {
      before_submit_prompt: 'UserPromptSubmit',
      user_prompt_submit: 'UserPromptSubmit',
      pre_tool_use: 'PreToolUse',
      before_shell_execution: 'PreToolUse',
      before_mcp_execution: 'PreToolUse',
      post_tool_use: 'PostToolUse',
      post_tool_use_failure: 'PostToolUse',
      after_shell_execution: 'PostToolUse',
      after_mcp_execution: 'PostToolUse',
      stop: 'Stop',
      session_end: 'Stop',
    };

    const cwd =
      obj.cwd ||
      obj.workspacePath ||
      obj.workspace?.path ||
      obj.workspace?.rootPath ||
      (Array.isArray(obj.workspace_roots) ? obj.workspace_roots[0] : '') ||
      obj.projectPath ||
      obj.project?.path ||
      obj.repoPath ||
      obj.repositoryPath ||
      '';

    const labelFromPayload =
      obj.label ||
      obj.workspaceName ||
      obj.workspace?.name ||
      obj.projectName ||
      obj.project?.name ||
      obj.repoName ||
      obj.repositoryName ||
      '';

    const fallbackLabel = cwd ? path.basename(cwd) : 'cursor';
    const fallbackSessionId = 'cursor-' + (cwd.replace(/[^a-zA-Z0-9_.-]+/g, '-') || 'session');

    const sessionId =
      obj.session_id ||
      obj.sessionId ||
      obj.conversation_id ||
      obj.conversationId ||
      obj.chat_id ||
      obj.chatId ||
      obj.thread_id ||
      obj.threadId ||
      fallbackSessionId;

    const toolName =
      obj.tool_name ||
      obj.toolName ||
      obj.tool?.name ||
      (normalized.includes('shell') ? 'Bash' : '') ||
      (normalized.includes('mcp') ? 'MCP' : '');

    obj.session_id = sessionId;
    obj.hook_event_name = eventMap[normalized] || eventMap[rawEvent] || rawEvent;
    if (cwd) obj.cwd = cwd;
    obj.label = labelFromPayload || fallbackLabel;
    obj.tool_name = obj.tool_name || toolName;
    obj.client = obj.client || 'cursor';
    obj.term_program = process.env.TERM_PROGRAM || obj.term_program || '';
    if (process.env.AGENT_LIGHT_CURSOR_PID) {
      obj.cursor_pid = parseInt(process.env.AGENT_LIGHT_CURSOR_PID);
      obj.cursor_name = process.env.AGENT_LIGHT_CURSOR_NAME || '';
    }
    process.stdout.write(JSON.stringify(obj));
  } catch {
    process.stdout.write(d);
  }
});
" 2>/dev/null)

if [ -z "$PAYLOAD" ]; then
  PAYLOAD="$INPUT"
fi

if ! curl -sf --max-time 0.5 "http://127.0.0.1:27420/ping" > /dev/null 2>&1; then
  _launch_agent_light
fi

RESULT=$(curl -sf --max-time 2 \
  -X POST "http://127.0.0.1:27420/event" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1)

echo "[$(date '+%H:%M:%S')] curl=$RESULT" >> "$LOG"

# Cursor hooks expect passthrough JSON on stdout for some events.
echo "$INPUT"
exit 0
