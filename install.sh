#!/bin/sh
# Re-exec with bash if not already running under bash
if [ -z "$BASH_VERSION" ]; then
  if command -v bash >/dev/null 2>&1; then
    exec bash "$0" "$@"
  fi
fi
# One-line installer for Lasso Agent Skill (Antigravity)
# Author: @0xposa (https://x.com/0xposa)
set -e

echo -e "\033[1;34m========================================================\033[0m"
echo -e "\033[1;32m           Installing Lasso Agent for Antigravity        \033[0m"
echo -e "         Author: \033[1;36m@0xposa\033[0m (https://x.com/0xposa)          "
echo -e "\033[1;34m========================================================\033[0m"

# 1. Check prerequisites
if ! command -v node >/dev/null 2>&1; then
  echo -e "\033[1;31m[!] Node.js is required but not installed.\033[0m"
  if [ -n "$PREFIX" ] && [ -d "$PREFIX" ]; then
    echo "    Run: pkg install nodejs"
  else
    echo "    Please install Node.js (>= 18) and re-run this script."
  fi
  exit 1
fi

if ! command -v agy >/dev/null 2>&1; then
  echo -e "\033[1;33m[*] Notice: Antigravity CLI ('agy') not found in PATH.\033[0m"
  echo "    Lasso Agent will install, but Antigravity CLI is recommended to run AI tasks."
fi

# 2. Determine source files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
CLEANUP_TEMP=0

if [ -z "$SCRIPT_DIR" ] || [ ! -d "$SCRIPT_DIR/skills/lasso-agent" ]; then
  TEMP_DIR="$(mktemp -d)"
  CLEANUP_TEMP=1
  echo -e "📥 Downloading Lasso Agent skill from GitHub..."
  git clone --depth=1 https://github.com/0xposa/lasso.git "$TEMP_DIR"
  SCRIPT_DIR="$TEMP_DIR"
fi

# 3. Target Skill Directories for Antigravity
for skill in lasso-agent lasso-agent-off; do
  if [ -d "$SCRIPT_DIR/skills/$skill" ]; then
    echo -e "📁 Installing $skill to Antigravity directory..."
    mkdir -p "$HOME/.gemini/config/skills/$skill"
    cp -r "$SCRIPT_DIR/skills/$skill/"* "$HOME/.gemini/config/skills/$skill/"

    if [ -d "$HOME/.agents/skills" ]; then
      mkdir -p "$HOME/.agents/skills/$skill"
      cp -r "$SCRIPT_DIR/skills/$skill/"* "$HOME/.agents/skills/$skill/"
    fi

    if [ -d "$HOME/.gemini/antigravity-cli/skills" ]; then
      mkdir -p "$HOME/.gemini/antigravity-cli/skills/$skill"
      cp -r "$SCRIPT_DIR/skills/$skill/"* "$HOME/.gemini/antigravity-cli/skills/$skill/"
    fi
  fi
done

# 4. Make scripts executable and fix shebangs for Termux / Linux
chmod +x "$SKILLS_DIR_GLOBAL/scripts/server.js" "$SKILLS_DIR_GLOBAL/scripts/lasso-ctl.sh" 2>/dev/null || true

if command -v termux-fix-shebang >/dev/null 2>&1; then
  echo -e "🔧 Fixing shebangs for Termux environment..."
  termux-fix-shebang "$SKILLS_DIR_GLOBAL/scripts/lasso-ctl.sh" "$SKILLS_DIR_GLOBAL/scripts/server.js" 2>/dev/null || true
fi

# 5. Optional CLI shortcut
BIN_DIR=""
if [ -n "$PREFIX" ] && [ -d "$PREFIX/bin" ]; then
  BIN_DIR="$PREFIX/bin"
elif [ -d "$HOME/.local/bin" ]; then
  BIN_DIR="$HOME/.local/bin"
elif [ -d "$HOME/.gemini/antigravity-cli/bin" ]; then
  BIN_DIR="$HOME/.gemini/antigravity-cli/bin"
fi

if [ -n "$BIN_DIR" ]; then
  ln -sf "$SKILLS_DIR_GLOBAL/scripts/lasso-ctl.sh" "$BIN_DIR/lasso-agent"
  chmod +x "$BIN_DIR/lasso-agent" 2>/dev/null || true
  echo -e "⚡ CLI shortcut registered: \033[1;36mlasso-agent\033[0m -> $BIN_DIR/lasso-agent"
fi

# 6. Cleanup
if [ "$CLEANUP_TEMP" -eq 1 ] && [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
  rm -rf "$TEMP_DIR"
fi

echo -e "\n\033[1;32m✅ Lasso Agent successfully installed!\033[0m"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "🎯 \033[1;37mHow to use in Antigravity:\033[0m"
echo -e "   Type \033[1;33m/lasso-agent\033[0m     - Launch local server & overlay on http://127.0.0.1:8080"
echo -e "   Type \033[1;33m/lasso-agent-off\033[0m - Shut down the local server completely"
echo -e ""
echo -e "💻 \033[1;37mTerminal CLI commands (optional):\033[0m"
echo -e "   \033[1;36mlasso-agent start\033[0m   - Start server in background"
echo -e "   \033[1;36mlasso-agent status\033[0m  - Check server status"
echo -e "   \033[1;36mlasso-agent stop\033[0m    - Stop server"
echo -e "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "Follow creator on X: \033[1;36mhttps://x.com/0xposa\033[0m\n"
