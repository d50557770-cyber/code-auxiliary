#!/usr/bin/env node

/**
 * Claude Code UserPromptSubmit フックハンドラー
 * ユーザーのプロンプトを自動キャプチャしてログに保存する
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

const PROMPT_DIR = join(homedir(), ".code-explainer", "prompts");
const MAX_PROMPTS = 50;

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

// プロンプトテキストを取得（Claude Codeのフォーマットに対応）
const promptText =
  hookData.prompt ||
  hookData.message ||
  hookData.user_message ||
  (typeof hookData === "string" ? hookData : null);

if (!promptText || !promptText.trim()) process.exit(0);

// 短すぎるプロンプトはスキップ（誤検知防止）
if (promptText.trim().length < 5) process.exit(0);

try {
  if (!existsSync(PROMPT_DIR)) {
    mkdirSync(PROMPT_DIR, { recursive: true });
  }

  const id = randomUUID();
  const entry = {
    id,
    timestamp: new Date().toISOString(),
    prompt: promptText.trim(),
    status: "pending", // pending | reviewed
    review: null,
  };

  const fileName = `${Date.now()}-${id.slice(0, 8)}.json`;
  writeFileSync(join(PROMPT_DIR, fileName), JSON.stringify(entry), "utf-8");

  // ローテーション
  const files = readdirSync(PROMPT_DIR).filter(f => f.endsWith(".json")).sort();
  if (files.length > MAX_PROMPTS) {
    const toDelete = files.slice(0, files.length - MAX_PROMPTS);
    for (const f of toDelete) {
      try { unlinkSync(join(PROMPT_DIR, f)); } catch { /* ignore */ }
    }
  }
} catch {
  // 書き込み失敗は無視
}
