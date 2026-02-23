#!/usr/bin/env node

/**
 * Claude Code PostToolUse フックハンドラー（軽量版）
 *
 * 設計方針:
 * - 同期I/Oのみ使用（最速で完了してClaude Codeをブロックしない）
 * - 最小限の処理のみ行う
 * - エラー時は静かに終了（Claude Codeに影響を与えない）
 * - ログは最大100件を保持（古いものを自動削除）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

const LOG_DIR = join(homedir(), ".code-explainer", "logs");
const MAX_LOGS = 100;

// --- メイン処理（即座に実行して終了） ---

let input = "";
try {
  input = readFileSync("/dev/stdin", "utf-8");
} catch {
  process.exit(0);
}

if (!input.trim()) process.exit(0);

let hookData;
try {
  hookData = JSON.parse(input);
} catch {
  process.exit(0);
}

const toolName = hookData.tool_name || "";
const toolInput = hookData.tool_input || {};

let type = null;
let filePath = "";
let code = "";

if (toolName === "Write" || toolName === "CreateFile") {
  type = "file_create";
  filePath = toolInput.file_path || toolInput.path || "";
  code = toolInput.content || "";
} else if (toolName === "Edit" || toolName === "StrReplace" || toolName === "str_replace_editor") {
  type = "file_edit";
  filePath = toolInput.file_path || toolInput.path || "";
  const oldStr = toolInput.old_string || toolInput.old_str || "";
  const newStr = toolInput.new_string || toolInput.new_str || "";
  code = `--- 変更前 ---\n${oldStr}\n--- 変更後 ---\n${newStr}`;
} else if (toolName === "Bash") {
  type = "command";
  code = toolInput.command || "";
} else {
  process.exit(0);
}

// 言語判定（インライン・軽量）
const ext = filePath ? (filePath.split(".").pop() || "").toLowerCase() : "";
const langMap = {
  js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  java: "java", swift: "swift", c: "c", cpp: "cpp",
  cs: "csharp", php: "php", html: "html", css: "css",
  scss: "scss", json: "json", yaml: "yaml", yml: "yaml",
  md: "markdown", sql: "sql", sh: "bash", zsh: "bash",
  toml: "toml", xml: "xml", vue: "vue", svelte: "svelte",
};
const language = langMap[ext] || "text";

// 要約生成（インライン）
const fileName = filePath ? filePath.split("/").pop() : "";
const summary =
  type === "file_create" ? `${fileName} を新規作成` :
  type === "file_edit" ? `${fileName} を編集` :
  `コマンド実行: ${(code || "").substring(0, 60)}`;

// ログ書き込み
try {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  const id = randomUUID();
  const logEntry = {
    id,
    timestamp: new Date().toISOString(),
    type,
    file: filePath,
    language,
    code,
    summary,
  };

  const logFileName = `${Date.now()}-${id.slice(0, 8)}.json`;
  writeFileSync(join(LOG_DIR, logFileName), JSON.stringify(logEntry), "utf-8");

  // ログローテーション: 100件を超えたら古いものを削除
  const files = readdirSync(LOG_DIR).filter(f => f.endsWith(".json")).sort();
  if (files.length > MAX_LOGS) {
    const toDelete = files.slice(0, files.length - MAX_LOGS);
    for (const f of toDelete) {
      try { unlinkSync(join(LOG_DIR, f)); } catch { /* ignore */ }
    }
  }
} catch {
  // 書き込み失敗は静かに無視
}
