/**
 * LINE Bot Webhook ハンドラー
 *
 * 機能:
 * - LINE Messaging API の署名検証
 * - テキストメッセージを受信してウェブサイト編集リクエストとして処理
 * - Claude API でHTML を自動編集
 * - 結果を LINE に返信
 */

import crypto from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BUSINESS_SITE_PATH = join(__dirname, "..", "business-site", "index.html");
const LINE_API_URL = "https://api.line.me/v2/bot/message";

// ── 型定義 ────────────────────────────────────────────────────────────────────

interface LineEvent {
  type: string;
  message?: {
    type: string;
    text?: string;
  };
  replyToken?: string;
  source?: {
    type: string;
    userId?: string;
    roomId?: string;
    groupId?: string;
  };
}

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

// ── LINE 署名検証 ──────────────────────────────────────────────────────────────

/**
 * LINE から送られてきたリクエストの署名を検証する
 */
export function verifyLineSignature(
  rawBody: Buffer,
  signature: string,
  channelSecret: string
): boolean {
  const hash = crypto
    .createHmac("SHA256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return hash === signature;
}

// ── LINE 返信 ─────────────────────────────────────────────────────────────────

/**
 * LINE の replyToken を使って返信する
 */
async function replyToLine(
  replyToken: string,
  text: string,
  channelAccessToken: string
): Promise<void> {
  const response = await fetch(`${LINE_API_URL}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channelAccessToken}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error("[LINE] 返信失敗:", error);
  }
}

// ── ウェブサイト編集 ──────────────────────────────────────────────────────────

/**
 * 現在のHTMLを読み込む
 */
function getCurrentHtml(): string {
  if (!existsSync(BUSINESS_SITE_PATH)) {
    throw new Error(`ウェブサイトファイルが見つかりません: ${BUSINESS_SITE_PATH}`);
  }
  return readFileSync(BUSINESS_SITE_PATH, "utf-8");
}

/**
 * Claude API を使ってHTMLを編集する
 */
async function editWebsiteWithClaude(
  userRequest: string,
  currentHtml: string,
  anthropic: Anthropic
): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [
      {
        role: "user",
        content: `あなたはウェブサイト編集AIです。
以下のユーザーの要望に従って、HTMLファイルを編集してください。

## ルール
- 要望された変更のみを行い、それ以外は変更しないでください
- 完全なHTMLファイルをそのまま返してください（説明文は不要）
- \`\`\`html や \`\`\` などのマークダウン記法は使わないでください
- 日本語の内容を適切に扱ってください

## ユーザーの要望
${userRequest}

## 現在のHTML
${currentHtml}`,
      },
    ],
  });

  const content = message.content[0];
  if (content.type !== "text") {
    throw new Error("Claude から予期しないレスポンス形式が返されました");
  }

  // マークダウンのコードブロックが含まれていた場合は除去
  let html = content.text.trim();
  if (html.startsWith("```html")) {
    html = html.replace(/^```html\n?/, "").replace(/\n?```$/, "");
  } else if (html.startsWith("```")) {
    html = html.replace(/^```\n?/, "").replace(/\n?```$/, "");
  }

  return html;
}

/**
 * HTMLファイルを保存する
 */
function saveHtml(html: string): void {
  writeFileSync(BUSINESS_SITE_PATH, html, "utf-8");
}

// ── メインハンドラー ──────────────────────────────────────────────────────────

/**
 * LINE Webhook イベントを処理する
 */
export async function handleLineWebhook(
  body: LineWebhookBody,
  replyToken: string | undefined,
  channelAccessToken: string,
  anthropicApiKey: string
): Promise<{ success: boolean; message: string }> {
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  for (const event of body.events) {
    // テキストメッセージのみ処理
    if (
      event.type !== "message" ||
      event.message?.type !== "text" ||
      !event.message.text ||
      !event.replyToken
    ) {
      continue;
    }

    const userText = event.message.text.trim();
    const token = event.replyToken;

    console.log(`[LINE] 受信: "${userText}"`);

    // 特殊コマンド処理
    if (userText === "!ヘルプ" || userText === "!help") {
      await replyToLine(
        token,
        `📖 使い方\n\n自然な日本語でウェブサイトへの変更を伝えてください。\n\n例:\n・「タイトルを〇〇に変えて」\n・「背景色を緑にして」\n・「お問い合わせのメールアドレスを〇〇に変更して」\n・「サービスに〇〇を追加して」\n\n現在のサイトURL: ${process.env.SITE_URL || "（未設定）"}`,
        channelAccessToken
      );
      continue;
    }

    if (userText === "!プレビュー" || userText === "!preview") {
      const siteUrl = process.env.SITE_URL || "（SITE_URL が未設定です）";
      await replyToLine(
        token,
        `🌐 現在のサイト\n${siteUrl}`,
        channelAccessToken
      );
      continue;
    }

    // ウェブサイト編集リクエストとして処理
    try {
      // 処理中メッセージ（LINE は replyToken で1回しか返信できないので省略）

      const currentHtml = getCurrentHtml();
      console.log("[LINE] Claude でHTML編集開始...");

      const updatedHtml = await editWebsiteWithClaude(
        userText,
        currentHtml,
        anthropic
      );

      saveHtml(updatedHtml);
      console.log("[LINE] HTML更新完了");

      const siteUrl = process.env.SITE_URL
        ? `\n🌐 ${process.env.SITE_URL}`
        : "";

      await replyToLine(
        token,
        `✅ ウェブサイトを更新しました！\n\n「${userText}」の変更を反映しました。${siteUrl}`,
        channelAccessToken
      );
    } catch (error) {
      console.error("[LINE] 編集エラー:", error);
      await replyToLine(
        token,
        `❌ 申し訳ありません、更新に失敗しました。\nエラー: ${error instanceof Error ? error.message : "不明なエラー"}`,
        channelAccessToken
      );
    }
  }

  return { success: true, message: "処理完了" };
}
