#!/bin/bash
# Codex hook — sends session events to AgentLight Electron app

INPUT=$(cat)
APP_DIR="$HOME/Documents/agent-light"
LOG="/tmp/agent-light-codex-hook.log"

EVENT=$(echo "$INPUT" | node -e "
process.stdin.resume();
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const obj = JSON.parse(d);
    const raw = obj.hook_event_name || obj.hookEventName || obj.event_name || obj.eventName || obj.hook_event?.event_type || obj.hookEvent?.eventType || '';
    const map = {
      user_prompt_submit: 'UserPromptSubmit',
      pre_tool_use: 'PreToolUse',
      post_tool_use: 'PostToolUse',
      stop: 'Stop',
      session_end: 'Stop'
    };
    process.stdout.write(map[raw] || raw);
  } catch {}
});
" 2>/dev/null)

case "$EVENT" in
  UserPromptSubmit|PreToolUse|PostToolUse|Stop) ;;
  *) exit 0 ;;
esac

echo "[$(date '+%H:%M:%S')] event=$EVENT PPID=$PPID" >> "$LOG"

_find_terminal_pid() {
  local pid=$PPID
  for i in 1 2 3 4 5 6 7 8; do
    local name
    name=$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')
    if echo "$name" | grep -qiE 'ghostty|iterm|Terminal|warp|alacritty|kitty|wezterm|hyper|tabby'; then
      echo "$pid $name"
      return
    fi
    local ppid
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$ppid" ] || [ "$ppid" -le 1 ] && break
    pid=$ppid
  done
}

_launch_agent_light() {
  local app_path
  for app_path in \
    "/Applications/AgentLight.app" \
    "$HOME/Applications/AgentLight.app" \
    "$APP_DIR/dist/AgentLight-darwin-arm64/AgentLight.app"; do
    if [ -d "$app_path" ]; then
      open -gj "$app_path" >> /tmp/agent-light.log 2>&1
      sleep 1
      return
    fi
  done

  if [ -f "$APP_DIR/node_modules/.bin/electron" ]; then
    cd "$APP_DIR" || exit 0
    nohup "$APP_DIR/node_modules/.bin/electron" "$APP_DIR" >> /tmp/agent-light.log 2>&1 < /dev/null &
    disown "$!" 2>/dev/null || true
    sleep 1
  fi
}

TERM_INFO=$(_find_terminal_pid)
export AGENT_LIGHT_TERM_PID=$(echo "$TERM_INFO" | awk '{print $1}')
export AGENT_LIGHT_TERM_NAME=$(echo "$TERM_INFO" | awk '{print $2}')
export AGENT_LIGHT_TTY=$(tty 2>/dev/null || true)
export AGENT_LIGHT_EVENT="$EVENT"

PAYLOAD=$(echo "$INPUT" | node -e "
process.stdin.resume();
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const obj = JSON.parse(d);
    const rawEvent = obj.hook_event_name || obj.hookEventName || obj.event_name || obj.eventName || obj.hook_event?.event_type || obj.hookEvent?.eventType || process.env.AGENT_LIGHT_EVENT || '';
    const eventMap = {
      user_prompt_submit: 'UserPromptSubmit',
      pre_tool_use: 'PreToolUse',
      post_tool_use: 'PostToolUse',
      stop: 'Stop',
      session_end: 'Stop'
    };
    const sessionId = obj.session_id || obj.sessionId || obj.thread_id || obj.threadId || obj.conversation_id || obj.conversationId || '';
    obj.session_id = sessionId || 'codex-' + (process.env.PWD || '').replace(/[^a-zA-Z0-9_.-]+/g, '-');
    obj.hook_event_name = eventMap[rawEvent] || rawEvent;
    obj.cwd = obj.cwd || process.env.PWD || '';
    obj.label = obj.label || (obj.cwd ? obj.cwd.split('/').filter(Boolean).pop() : 'codex');
    obj.client = obj.client || 'codex';
    obj.term_program  = process.env.TERM_PROGRAM  || '';
    obj.iterm_session = process.env.ITERM_SESSION_ID || '';
    obj.vscode_pid    = process.env.VSCODE_PID    || '';
    obj.tty           = process.env.AGENT_LIGHT_TTY || '';
    if (process.env.AGENT_LIGHT_TERM_PID) {
      obj.terminal_pid  = parseInt(process.env.AGENT_LIGHT_TERM_PID);
      obj.terminal_name = process.env.AGENT_LIGHT_TERM_NAME || '';
    }
    process.stdout.write(JSON.stringify(obj));
  } catch(e) {
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
exit 0
