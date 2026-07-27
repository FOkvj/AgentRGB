#!/bin/bash
# Claude Code hook — sends session events to AgentBoard Electron app

INPUT=$(cat)
APP_DIR="$HOME/Documents/agent-board"
LOG="/tmp/agent-board-hook.log"

# Only process supported events
EVENT=$(echo "$INPUT" | node -e "
process.stdin.resume();
let d='';
process.stdin.on('data',c=>d+=c);
process.stdin.on('end',()=>{
  try { process.stdout.write(JSON.parse(d).hook_event_name||'') } catch {}
});
" 2>/dev/null)

case "$EVENT" in
  UserPromptSubmit|PreToolUse|PostToolUse|Stop) ;;
  *) exit 0 ;;
esac

echo "[$(date '+%H:%M:%S')] event=$EVENT PPID=$PPID" >> "$LOG"

# Walk process tree to find terminal app PID
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

_launch_agent_board() {
  local app_path
  for app_path in \
    "/Applications/AgentBoard.app" \
    "$HOME/Applications/AgentBoard.app" \
    "$APP_DIR/dist/AgentBoard-darwin-arm64/AgentBoard.app"; do
    if [ -d "$app_path" ]; then
      open -gj "$app_path" >> /tmp/agent-board.log 2>&1
      sleep 1
      return
    fi
  done

  if [ -f "$APP_DIR/node_modules/.bin/electron" ]; then
    cd "$APP_DIR" || exit 0
    nohup "$APP_DIR/node_modules/.bin/electron" "$APP_DIR" >> /tmp/agent-board.log 2>&1 < /dev/null &
    disown "$!" 2>/dev/null || true
    sleep 1
  fi
}

TERM_INFO=$(_find_terminal_pid)
export AGENT_BOARD_TERM_PID=$(echo "$TERM_INFO" | awk '{print $1}')
export AGENT_BOARD_TERM_NAME=$(echo "$TERM_INFO" | awk '{print $2}')
export AGENT_BOARD_TTY=$(tty 2>/dev/null || true)

echo "[$(date '+%H:%M:%S')] terminal_pid=$AGENT_BOARD_TERM_PID name=$AGENT_BOARD_TERM_NAME" >> "$LOG"

# Build payload
PAYLOAD=$(echo "$INPUT" | node -e "
process.stdin.resume();
let d = '';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const obj = JSON.parse(d);
    obj.term_program  = process.env.TERM_PROGRAM  || '';
    obj.iterm_session = process.env.ITERM_SESSION_ID || '';
    obj.vscode_pid    = process.env.VSCODE_PID    || '';
    obj.tty           = process.env.AGENT_BOARD_TTY || '';
    if (process.env.AGENT_BOARD_TERM_PID) {
      obj.terminal_pid  = parseInt(process.env.AGENT_BOARD_TERM_PID);
      obj.terminal_name = process.env.AGENT_BOARD_TERM_NAME || '';
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

# Wake up AgentBoard if not running
if ! curl -sf --max-time 0.5 "http://127.0.0.1:27420/ping" > /dev/null 2>&1; then
  _launch_agent_board
fi

RESULT=$(curl -sf --max-time 2 \
  -X POST "http://127.0.0.1:27420/event" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1)

echo "[$(date '+%H:%M:%S')] curl=$RESULT" >> "$LOG"
exit 0
