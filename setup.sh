#!/bin/bash
set -e

# 色の定義
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BLUE}🔍 Code Explainer セットアップ${NC}"
echo "=================================="
echo ""

# 1. プロジェクトのディレクトリを確認
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 2. npm パッケージのインストール
echo -e "${YELLOW}📦 パッケージをインストール中...${NC}"
npm install
echo -e "${GREEN}✅ パッケージのインストール完了${NC}"
echo ""

# 3. ログディレクトリの作成
LOG_DIR="$HOME/.code-explainer/logs"
echo -e "${YELLOW}📁 ログディレクトリを作成中...${NC}"
mkdir -p "$LOG_DIR"
echo -e "${GREEN}✅ $LOG_DIR を作成しました${NC}"
echo ""

# 4. Claude Code の hooks.json にフックを登録
CLAUDE_DIR="$HOME/.claude"
HOOKS_FILE="$CLAUDE_DIR/hooks.json"
HANDLER_PATH="$SCRIPT_DIR/hooks/log-action.js"

echo -e "${YELLOW}🔗 Claude Code フックを登録中...${NC}"

mkdir -p "$CLAUDE_DIR"

# フックのエントリ
HOOK_COMMAND="node $HANDLER_PATH"

if [ -f "$HOOKS_FILE" ]; then
  # 既存の hooks.json がある場合
  # 既にこのフックが登録されていないかチェック
  if grep -q "$HANDLER_PATH" "$HOOKS_FILE" 2>/dev/null; then
    echo -e "${GREEN}✅ フックは既に登録されています${NC}"
  else
    # node で既存の hooks.json にマージ
    node -e "
      const fs = require('fs');
      const existing = JSON.parse(fs.readFileSync('$HOOKS_FILE', 'utf-8'));

      if (!existing.hooks) existing.hooks = {};
      if (!existing.hooks.PostToolUse) existing.hooks.PostToolUse = [];

      existing.hooks.PostToolUse.push({
        matcher: 'Write|Edit|Bash',
        hooks: [{ type: 'command', command: '$HOOK_COMMAND' }]
      });

      fs.writeFileSync('$HOOKS_FILE', JSON.stringify(existing, null, 2));
    "
    echo -e "${GREEN}✅ 既存の hooks.json にフックを追加しました${NC}"
  fi
else
  # 新規作成
  cat > "$HOOKS_FILE" << HOOKEOF
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$HOOK_COMMAND"
          }
        ]
      }
    ]
  }
}
HOOKEOF
  echo -e "${GREEN}✅ hooks.json を新規作成しました${NC}"
fi

echo ""

# 5. .env ファイルの作成
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo -e "${YELLOW}📝 .env ファイルを作成中...${NC}"
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo -e "${GREEN}✅ .env ファイルを作成しました${NC}"
  echo -e "${RED}⚠️  .env ファイルに ANTHROPIC_API_KEY を設定してください${NC}"
else
  echo -e "${GREEN}✅ .env ファイルは既に存在します${NC}"
fi

echo ""
echo "=================================="
echo -e "${GREEN}🎉 セットアップ完了！${NC}"
echo ""
echo "次のステップ:"
echo "  1. .env ファイルに ANTHROPIC_API_KEY を設定"
echo "  2. npm run dev で開発サーバーを起動"
echo "  3. 別のターミナルで Claude Code を使用"
echo "  4. ブラウザで http://localhost:3001 を開く"
echo ""
