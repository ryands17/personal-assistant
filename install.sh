#!/usr/bin/env bash
set -euo pipefail

# Max installer — Linux VPS
# Usage: curl -fsSL https://raw.githubusercontent.com/ryands17/personal-assistant/main/install.sh | bash

REPO_URL="https://github.com/ryands17/personal-assistant"
INSTALL_DIR="$HOME/max-assistant"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

info()    { echo -e "${BOLD}$1${RESET}"; }
success() { echo -e "${GREEN}$1${RESET}"; }
warn()    { echo -e "${YELLOW}$1${RESET}"; }
error()   { echo -e "${RED}$1${RESET}" >&2; }

echo ""
info "╔══════════════════════════════════════════╗"
info "║         🤖  Max Installer                ║"
info "╚══════════════════════════════════════════╝"
echo ""

# ── Dependency checks ─────────────────────────────────────────────────────────

# Node.js 22+
if ! command -v node &>/dev/null; then
  error "✗ Node.js is required but not installed."
  echo "  Install Node.js 22+ via nvm:"
  echo -e "  ${DIM}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash${RESET}"
  echo -e "  ${DIM}source ~/.bashrc && nvm install 22 && nvm use 22${RESET}"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  error "✗ Node.js v22+ is required (found $(node -v))"
  echo "  Upgrade via nvm:"
  echo -e "  ${DIM}nvm install 22 && nvm use 22${RESET}"
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  error "✗ npm is required but not installed."
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} npm $(npm -v)"

# git
if ! command -v git &>/dev/null; then
  error "✗ git is required but not installed."
  echo "  Install: sudo apt install git"
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} git $(git --version | awk '{print $3}')"

# Copilot CLI (optional)
if command -v copilot &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} Copilot CLI found"
else
  warn "  ⚠ Copilot CLI not found — required before starting Max"
  echo -e "    ${DIM}Install: npm install -g @github/copilot${RESET}"
fi

echo ""

# ── Clone or update repo ───────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  # Abort if there are local modifications — don't silently clobber user changes
  if ! git -C "$INSTALL_DIR" diff --quiet 2>/dev/null || ! git -C "$INSTALL_DIR" diff --cached --quiet 2>/dev/null; then
    error "✗ Local changes detected in $INSTALL_DIR"
    echo "  Stash or reset them before re-running:"
    echo -e "  ${DIM}git -C \"$INSTALL_DIR\" stash  # save changes${RESET}"
    echo -e "  ${DIM}git -C \"$INSTALL_DIR\" reset --hard origin/main  # discard changes${RESET}"
    exit 1
  fi
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning repository..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo ""

# ── Build ──────────────────────────────────────────────────────────────────────

info "Installing dependencies and building..."
cd "$INSTALL_DIR"
npm ci --silent
npm run build --silent
success "  ✓ Build complete"

echo ""

# ── Setup wizard ───────────────────────────────────────────────────────────────

info "Let's configure Max..."
echo ""

# When piped via `curl | bash`, stdin is the pipe — /dev/tty gives us the real terminal.
# If /dev/tty is unavailable (CI, non-interactive) we can't run the wizard.
if [ ! -r /dev/tty ]; then
  error "✗ No interactive terminal available — cannot run setup wizard."
  echo "  Re-run the installer directly (not via a pipe), or configure manually:"
  echo -e "  ${DIM}node $INSTALL_DIR/dist/setup.js${RESET}"
  exit 1
fi
node dist/setup.js < /dev/tty

echo ""

# ── systemd service ────────────────────────────────────────────────────────────

NODE_BIN="$(which node)"
SERVICE_NAME="max-assistant"
SERVICE_FILE="$SERVICE_NAME.service"

SYSTEM_SERVICE_CONTENT="[Unit]
Description=Max personal assistant
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/cli.js start
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target"

# User-mode units use default.target (not the system multi-user.target)
USER_SERVICE_CONTENT="[Unit]
Description=Max personal assistant
After=default.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/cli.js start
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target"

info "Installing systemd service..."

SYSTEM_UNIT_DIR="/etc/systemd/system"
USER_UNIT_DIR="$HOME/.config/systemd/user"

install_system_service() {
  echo "$SYSTEM_SERVICE_CONTENT" | sudo tee "$SYSTEM_UNIT_DIR/$SERVICE_FILE" > /dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
  success "  ✓ Service installed and started (system-wide)"
  echo -e "  ${DIM}Manage: sudo systemctl [start|stop|restart|status] $SERVICE_NAME${RESET}"
  echo -e "  ${DIM}Logs:   sudo journalctl -u $SERVICE_NAME -f${RESET}"
}

install_user_service() {
  mkdir -p "$USER_UNIT_DIR"
  echo "$USER_SERVICE_CONTENT" > "$USER_UNIT_DIR/$SERVICE_FILE"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  # Enable linger so the service starts at boot without requiring a login session
  if command -v loginctl &>/dev/null; then
    if ! loginctl enable-linger "$USER" 2>/dev/null; then
      warn "  ⚠ Could not enable linger for $USER — service may not start at boot."
      echo -e "    ${DIM}Fix with: sudo loginctl enable-linger $USER${RESET}"
    fi
  fi
  success "  ✓ Service installed and started (user-mode)"
  echo -e "  ${DIM}Manage: systemctl --user [start|stop|restart|status] $SERVICE_NAME${RESET}"
  echo -e "  ${DIM}Logs:   journalctl --user -u $SERVICE_NAME -f${RESET}"
}

print_manual_instructions() {
  warn "  ⚠ Could not install systemd service automatically."
  echo "  To install manually, save this to $SYSTEM_UNIT_DIR/$SERVICE_FILE (as root):"
  echo ""
  echo "$SYSTEM_SERVICE_CONTENT"
  echo ""
  echo "  Then run:"
  echo -e "  ${DIM}sudo systemctl daemon-reload && sudo systemctl enable --now $SERVICE_NAME${RESET}"
}

if sudo -n true 2>/dev/null; then
  install_system_service
elif systemctl --user status &>/dev/null 2>&1; then
  install_user_service
else
  print_manual_instructions
fi

echo ""
success "✅ Max is installed and running!"
echo ""


# Max installer — Linux VPS
# Usage: curl -fsSL https://raw.githubusercontent.com/ryands17/personal-assistant/main/install.sh | bash

REPO_URL="https://github.com/ryands17/personal-assistant"
INSTALL_DIR="$HOME/max-assistant"

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
RESET='\033[0m'

info()    { echo -e "${BOLD}$1${RESET}"; }
success() { echo -e "${GREEN}$1${RESET}"; }
warn()    { echo -e "${YELLOW}$1${RESET}"; }
error()   { echo -e "${RED}$1${RESET}" >&2; }

echo ""
info "╔══════════════════════════════════════════╗"
info "║         🤖  Max Installer                ║"
info "╚══════════════════════════════════════════╝"
echo ""

# ── Dependency checks ─────────────────────────────────────────────────────────

# Node.js 22+
if ! command -v node &>/dev/null; then
  error "✗ Node.js is required but not installed."
  echo "  Install Node.js 22+ via nvm:"
  echo -e "  ${DIM}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash${RESET}"
  echo -e "  ${DIM}source ~/.bashrc && nvm install 22 && nvm use 22${RESET}"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
  error "✗ Node.js v22+ is required (found $(node -v))"
  echo "  Upgrade via nvm:"
  echo -e "  ${DIM}nvm install 22 && nvm use 22${RESET}"
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  error "✗ npm is required but not installed."
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} npm $(npm -v)"

# git
if ! command -v git &>/dev/null; then
  error "✗ git is required but not installed."
  echo "  Install: sudo apt install git"
  exit 1
fi
echo -e "  ${GREEN}✓${RESET} git $(git --version | awk '{print $3}')"

# Copilot CLI (optional)
if command -v copilot &>/dev/null; then
  echo -e "  ${GREEN}✓${RESET} Copilot CLI found"
else
  warn "  ⚠ Copilot CLI not found — required before starting Max"
  echo -e "    ${DIM}Install: npm install -g @github/copilot${RESET}"
fi

echo ""

# ── Clone or update repo ───────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing installation..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning repository..."
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

echo ""

# ── Build ──────────────────────────────────────────────────────────────────────

info "Installing dependencies and building..."
cd "$INSTALL_DIR"
npm ci --silent
npm run build --silent
success "  ✓ Build complete"

echo ""

# ── Setup wizard ───────────────────────────────────────────────────────────────

info "Let's configure Max..."
echo ""
node dist/setup.js < /dev/tty

echo ""

# ── systemd service ────────────────────────────────────────────────────────────

NODE_BIN="$(which node)"
SERVICE_NAME="max-assistant"
SERVICE_FILE="$SERVICE_NAME.service"

SERVICE_CONTENT="[Unit]
Description=Max personal assistant
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $INSTALL_DIR/dist/cli.js start
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target"

info "Installing systemd service..."

SYSTEM_UNIT_DIR="/etc/systemd/system"
USER_UNIT_DIR="$HOME/.config/systemd/user"

install_system_service() {
  echo "$SERVICE_CONTENT" | sudo tee "$SYSTEM_UNIT_DIR/$SERVICE_FILE" > /dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$SERVICE_NAME"
  success "  ✓ Service installed and started (system-wide)"
  echo -e "  ${DIM}Manage: sudo systemctl [start|stop|restart|status] $SERVICE_NAME${RESET}"
  echo -e "  ${DIM}Logs:   sudo journalctl -u $SERVICE_NAME -f${RESET}"
}

install_user_service() {
  mkdir -p "$USER_UNIT_DIR"
  echo "$SERVICE_CONTENT" > "$USER_UNIT_DIR/$SERVICE_FILE"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
  # Enable linger so the service starts at boot without login
  if command -v loginctl &>/dev/null; then
    loginctl enable-linger "$USER" 2>/dev/null || true
  fi
  success "  ✓ Service installed and started (user-mode)"
  echo -e "  ${DIM}Manage: systemctl --user [start|stop|restart|status] $SERVICE_NAME${RESET}"
  echo -e "  ${DIM}Logs:   journalctl --user -u $SERVICE_NAME -f${RESET}"
}

print_manual_instructions() {
  warn "  ⚠ Could not install systemd service automatically."
  echo "  To install manually, save this to $SYSTEM_UNIT_DIR/$SERVICE_FILE (as root):"
  echo ""
  echo "$SERVICE_CONTENT"
  echo ""
  echo "  Then run:"
  echo -e "  ${DIM}sudo systemctl daemon-reload && sudo systemctl enable --now $SERVICE_NAME${RESET}"
}

if sudo -n true 2>/dev/null; then
  install_system_service
elif systemctl --user status &>/dev/null 2>&1; then
  install_user_service
else
  print_manual_instructions
fi

echo ""
success "✅ Max is installed and running!"
echo ""

