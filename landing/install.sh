#!/bin/bash
set -e

# ── Code Auxiliary インストーラー ─────────────────────────────────────────
REPO_URL="https://github.com/d50557770-cyber/code-auxiliary"
INSTALL_DIR="$HOME/code-auxiliary"
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}✦ Code Auxiliary インストーラー${NC}"
echo "────────────────────────────────────"

# Node.js チェック
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js が見つかりません。${NC}"
  echo "  https://nodejs.org からインストールしてください。"
  exit 1
fi

NODE_VER=$(node -v)
echo -e "${GREEN}✓ Node.js ${NODE_VER}${NC}"

# npm チェック
if ! command -v npm &>/dev/null; then
  echo -e "${RED}✗ npm が見つかりません。Node.js を再インストールしてください。${NC}"
  exit 1
fi

# git チェック
if ! command -v git &>/dev/null; then
  echo -e "${RED}✗ git が見つかりません。${NC}"
  echo "  Mac: xcode-select --install を実行してください。"
  exit 1
fi

echo -e "${GREEN}✓ git $(git --version | awk '{print $3}')${NC}"

# 既にインストール済みの場合は更新
if [ -d "$INSTALL_DIR/.git" ]; then
  echo ""
  echo "既存のインストールを更新します: $INSTALL_DIR"
  cd "$INSTALL_DIR"
  git pull
else
  echo ""
  echo "インストール先: $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# 依存パッケージインストール
echo ""
echo "パッケージをインストール中..."
npm install --silent

echo ""
echo -e "${GREEN}────────────────────────────────────${NC}"
echo -e "${GREEN}✦ インストール完了！${NC}"
echo ""
echo "サーバーを起動します..."
echo -e "ブラウザで ${CYAN}http://localhost:3001${NC} を開いてください。"
echo "(停止するには Ctrl+C)"
echo ""
npm start
