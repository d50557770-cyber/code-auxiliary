#!/usr/bin/env node

/**
 * Claude Code Stop フックハンドラー
 * アシスタント（Claude）の応答メッセージを自動キャプチャしてログに保存する
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";

const ASSISTANT_DIR = join(homedir(), ".code-explainer", "assistant-messages");
const MAX_MESSAGES = 50;

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

// アシスタントメッセージを複数パターンで抽出
function extractAssistantMessage(data) {
  // パターン1: transcript 配列から最後のアシスタントメッセージを取得
  if (Array.isArray(data.transcript)) {
    const assistantMessages = data.transcript.filter(m => m.role === "assistant");
    if (assistantMessages.length > 0) {
      const last = assistantMessages[assistantMessages.length - 1];
      const content = last.content;
      if (typeof content === "string") return content;
      // content が配列の場合（例: [{type: "text", text: "..."}]）
      if (Array.isArray(content)) {
        const textParts = content
          .filter(c => c.type === "text")
          .map(c => c.text)
          .join("\n");
        if (textParts) return textParts;
      }
    }
  }

  // パターン2: result フィールド
  if (data.result && typeof data.result === "string") return data.result;

  // パターン3: message フィールド
  if (data.message && typeof data.message === "string") return data.message;

  // パターン4: response フィールド
  if (data.response && typeof data.response === "string") return data.response;

  return null;
}

const messageText = extractAssistantMessage(hookData);
if (!messageText || messageText.trim().length < 10) process.exit(0);

try {
  if (!existsSync(ASSISTANT_DIR)) {
    mkdirSync(ASSISTANT_DIR, { recursive: true });
  }

  const id = randomUUID();
  // 長すぎる場合は先頭200文字でプレビュー生成
  const preview = messageText.trim().slice(0, 200).replace(/\n+/g, " ");

  const entry = {
    id,
    timestamp: new Date().toISOString(),
    message: messageText.trim(),
    preview,
    status: "pending", // pending | explained
    explanation: null,
  };

  const fileName = `${Date.now()}-${id.slice(0, 8)}.json`;
  writeFileSync(join(ASSISTANT_DIR, fileName), JSON.stringify(entry), "utf-8");

  // ローテーション
  const files = readdirSync(ASSISTANT_DIR).filter(f => f.endsWith(".json")).sort();
  if (files.length > MAX_MESSAGES) {
    const toDelete = files.slice(0, files.length - MAX_MESSAGES);
    for (const f of toDelete) {
      try { unlinkSync(join(ASSISTANT_DIR, f)); } catch { /* ignore */ }
    }
  }
} catch {
  // 書き込み失敗は無視
}
