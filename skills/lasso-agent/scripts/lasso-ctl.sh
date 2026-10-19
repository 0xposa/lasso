#!/data/data/com.termux/files/usr/bin/bash
# Lasso Agent Process Controller (start / status / stop / restart)

PID_DIR="$HOME/.lasso"
PID_FILE="$PID_DIR/lasso-agent.pid"
SERVER_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/server.js"

mkdir -p "$PID_DIR"

is_running() {
  if [ -f "$PID_FILE" ]; then
    PID=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('$PID_FILE', 'utf8')).pid); } catch(e) { process.exit(1); }")
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

get_port() {
  if [ -f "$PID_FILE" ]; then
    node -e "try { console.log(JSON.parse(require('fs').readFileSync('$PID_FILE', 'utf8')).port || 8080); } catch(e) { console.log(8080); }"
  else
    echo "8080"
  fi
}

case "$1" in
  start)
    if is_running; then
      PORT=$(get_port)
      echo "RUNNING:$PORT"
      exit 0
    fi

    # Start in background
    export LASSO_PROJECT_DIR="${2:-$(pwd)}"
    setsid node "$SERVER_SCRIPT" < /dev/null > "$PID_DIR/lasso-agent.log" 2>&1 &
    
    # Wait up to 5s for PID file
    for i in {1..25}; do
      if is_running; then
        PORT=$(get_port)
        echo "STARTED:$PORT"
        exit 0
      fi
      sleep 0.2
    done

    echo "ERROR:Failed to start server. Check $PID_DIR/lasso-agent.log"
    exit 1
    ;;

  status)
    if is_running; then
      PORT=$(get_port)
      echo "RUNNING:$PORT"
    else
      echo "STOPPED"
    fi
    ;;

  stop)
    if is_running; then
      PID=$(node -e "try { console.log(JSON.parse(require('fs').readFileSync('$PID_FILE', 'utf8')).pid); } catch(e) { process.exit(1); }")
      if [ -n "$PID" ]; then
        kill "$PID" 2>/dev/null || true
        rm -f "$PID_FILE"
      fi
      echo "STOPPED"
    else
      rm -f "$PID_FILE"
      echo "NOT_RUNNING"
    fi
    ;;

  *)
    echo "Usage: $0 {start|status|stop} [project_dir]"
    exit 1
    ;;
esac
