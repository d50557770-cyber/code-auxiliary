import express from "express";
import { createServer } from "vite";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import Stripe from "stripe";
import { verifyLineSignature, handleLineWebhook } from "./line-bot.js";

const LOG_DIR            = join(homedir(), ".code-explainer", "logs");
const PROMPT_DIR         = join(homedir(), ".code-explainer", "prompts");
const ASSISTANT_DIR      = join(homedir(), ".code-explainer", "assistant-messages");
const HISTORY_DIR        = join(homedir(), ".code-explainer", "history");
const SESSIONS_PATH      = join(homedir(), ".code-explainer", "sessions.json");
const CLAUDE_PROJECTS    = join(homedir(), ".claude", "projects");
const PORT = Number(process.env.PORT) || 3001;
const MAX_LOGS = 100;
const MAX_PRICE_ID      = "price_1T3ZxPB8xcXMCEIyr4dFJwdh"; // MAX年額プラン
const BUY_ONCE_PRICE_ID = "price_1T34NiB8xcXMCEIySuTEemEb"; // 買い切り ¥980

// Claude Code JSONL ウォッチャー用
const seenUuids     = new Set<string>();
const fileLastSize  = new Map<string, number>();

// ディレクトリがなければ作成
if (!existsSync(LOG_DIR))       mkdirSync(LOG_DIR,       { recursive: true });
if (!existsSync(PROMPT_DIR))    mkdirSync(PROMPT_DIR,    { recursive: true });
if (!existsSync(ASSISTANT_DIR)) mkdirSync(ASSISTANT_DIR, { recursive: true });
if (!existsSync(HISTORY_DIR))   mkdirSync(HISTORY_DIR,   { recursive: true });

// .env ファイルを手動で読み込み
function loadEnv() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, "..", ".env");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          const value = trimmed.slice(eqIdx + 1).trim();
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    }
  }
}

loadEnv();

// ─── セッション管理 ────────────────────────────────────────────────────────────────

type PlanType = "pro" | "max" | "buy_once";
type SessionStore = Record<string, { plan: PlanType; createdAt: string }>;

function loadSessions(): SessionStore {
  try {
    if (existsSync(SESSIONS_PATH)) return JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
  } catch { /* ignore */ }
  return {};
}

function saveSession(token: string, plan: PlanType) {
  const sessions = loadSessions();
  sessions[token] = { plan, createdAt: new Date().toISOString() };
  try { writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2), "utf-8"); } catch { /* ignore */ }
}

function getSessionPlan(req: express.Request): PlanType | null {
  const token = req.headers["x-pro-token"] as string | undefined;
  if (!token) return null;
  return loadSessions()[token]?.plan ?? null;
}

const app = express();
// リクエストボディを50KBに制限（大量テキストによるコスト攻撃を防止）
app.use(express.json({ limit: "50kb" }));

// ─── セキュリティ: レートリミット & フリープラン制限 ─────────────────────────

// IPごとのレートリミット: 1分間に60リクエストまで
const rateLimitMap = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// フリープランのAI使用回数: IPごと・日次リセット・最大5回
const freeUsageMap = new Map<string, { count: number; resetAt: number }>();
const FREE_DAILY_LIMIT = 5;

function checkFreeLimit(ip: string): boolean {
  const now = Date.now();
  const tomorrow = new Date();
  tomorrow.setHours(24, 0, 0, 0);
  const resetAt = tomorrow.getTime();

  const entry = freeUsageMap.get(ip);
  if (!entry || entry.resetAt <= now) {
    freeUsageMap.set(ip, { count: 1, resetAt });
    return true;
  }
  if (entry.count >= FREE_DAILY_LIMIT) return false;
  entry.count++;
  return true;
}

// AIエンドポイント共通ミドルウェア
function aiAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.ip || "unknown";

  if (!checkRateLimit(ip)) {
    res.status(429).json({ error: "リクエストが多すぎます。1分後に再試行してください。" });
    return;
  }

  const plan = getSessionPlan(req);
  if (!plan && !checkFreeLimit(ip)) {
    res.status(429).json({ error: "本日の無料枠（5回）を使い切りました。アップグレードをご検討ください。" });
    return;
  }

  next();
}

// ─── セキュリティヘッダー（全レスポンス共通） ────────────────────────────────
app.use((_req, res, next) => {
  // ブラウザのコンテンツスニッフィングを無効化
  res.setHeader("X-Content-Type-Options", "nosniff");
  // クリックジャッキング対策
  res.setHeader("X-Frame-Options", "DENY");
  // XSS対策
  res.setHeader("X-XSS-Protection", "1; mode=block");
  // キャッシュ禁止（APIレスポンスを他のユーザーのキャッシュに残さない）
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  // CORS: localhostからのリクエストのみ許可
  const origin = _req.headers.origin || "";
  if (origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pro-token");
  }
  if (_req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
});

// ─── データエンドポイント認証: セッションまたはローカルホストのみ許可 ──────────
function getClientIp(req: express.Request): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.ip || "";
}

function isLocalhost(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function dataAuthMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isLocalhost(getClientIp(req)) || getSessionPlan(req)) {
    next(); return;
  }
  res.status(401).json({ error: "認証が必要です。" });
}

// ローカルホストのみ許可（APIキー設定・フック設定など管理操作用）
// ※ Host/Origin ヘッダーは偽造可能なので IP のみで判定する
function localhostOnlyMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isLocalhost(getClientIp(req))) {
    next(); return;
  }
  res.status(403).json({ error: "この操作はローカルからのみ実行できます。" });
}

// 招待コードのブルートフォース対策: IPごと1分間10回まで
const inviteRateLimitMap = new Map<string, { count: number; windowStart: number }>();
function checkInviteRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = inviteRateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > 60_000) {
    inviteRateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= 10) return false;
  entry.count++;
  return true;
}

// 古いログを削除（最大100件保持）
function pruneOldLogs() {
  if (!existsSync(LOG_DIR)) return;
  const files = readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length > MAX_LOGS) {
    const toDelete = files.slice(0, files.length - MAX_LOGS);
    for (const f of toDelete) {
      try {
        unlinkSync(join(LOG_DIR, f));
      } catch {
        /* ignore */
      }
    }
  }
}

// 全ログファイルを読み取って返す
function getAllLogs() {
  if (!existsSync(LOG_DIR)) return [];

  pruneOldLogs();

  const files = readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const logs = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(LOG_DIR, file), "utf-8");
      logs.push(JSON.parse(content));
    } catch {
      // 破損ファイルはスキップ
    }
  }
  return logs;
}

// DELETE /api/clear-all - ログ・プロンプト・応答を全削除
app.delete("/api/clear-all", dataAuthMiddleware, (_req, res) => {
  try {
    for (const dir of [LOG_DIR, PROMPT_DIR, ASSISTANT_DIR]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter(f => f.endsWith(".json"))) {
        try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
      }
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "クリアに失敗しました" });
  }
});

// GET /api/setup/status - セットアップ状況を返す
app.get("/api/setup/status", (_req, res) => {
  const geminiKey    = process.env.GEMINI_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  const keys = {
    gemini:    !!(geminiKey    && geminiKey    !== "your-gemini-key-here"),
    openai:    !!(openaiKey    && openaiKey    !== "your-openai-key-here"),
    anthropic: !!(anthropicKey && anthropicKey !== "your-api-key-here"),
  };

  let hooksConfigured = false;
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settingsStr = readFileSync(settingsPath, "utf-8");
      hooksConfigured = settingsStr.includes("code-explainer");
    } catch { /* ignore */ }
  }

  res.json({ keys, hooksConfigured });
});

// POST /api/setup/keys - APIキーを .env に保存して即時反映
app.post("/api/setup/keys", localhostOnlyMiddleware, (req, res) => {
  try {
    const { gemini, openai, anthropic } = req.body;
    const __dirnameDerived = dirname(fileURLToPath(import.meta.url));
    const envPath = join(__dirnameDerived, "..", ".env");

    const content = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
    const lines = content.split("\n");

    const updates: Record<string, string> = {};
    if (gemini?.trim())    updates["GEMINI_API_KEY"]    = gemini.trim();
    if (openai?.trim())    updates["OPENAI_API_KEY"]    = openai.trim();
    if (anthropic?.trim()) updates["ANTHROPIC_API_KEY"] = anthropic.trim();

    if (Object.keys(updates).length === 0) {
      res.json({ ok: true });
      return;
    }

    const handled = new Set<string>();
    const newLines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx <= 0) return line;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key in updates) {
        handled.add(key);
        return `${key}=${updates[key]}`;
      }
      return line;
    });

    for (const [key, value] of Object.entries(updates)) {
      if (!handled.has(key)) newLines.push(`${key}=${value}`);
    }

    writeFileSync(envPath, newLines.join("\n").trimEnd() + "\n", "utf-8");

    for (const [key, value] of Object.entries(updates)) {
      process.env[key] = value;
    }

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/hooks - ~/.claude/settings.json にフックを自動追加
app.post("/api/setup/hooks", localhostOnlyMiddleware, (_req, res) => {
  try {
    const __dirnameDerived = dirname(fileURLToPath(import.meta.url));
    const hooksDir = join(__dirnameDerived, "..", "hooks");

    const claudeDir = join(homedir(), ".claude");
    const settingsPath = join(claudeDir, "settings.json");

    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });

    let settings: any = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); }
      catch { settings = {}; }
    }

    if (!settings.hooks) settings.hooks = {};

    // PostToolUse
    if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];
    const postToolUseCmd = `node ${join(hooksDir, "log-action.js")}`;
    const hasPostToolUse = settings.hooks.PostToolUse.some((entry: any) =>
      entry.hooks?.some((h: any) => h.command === postToolUseCmd)
    );
    if (!hasPostToolUse) {
      settings.hooks.PostToolUse.push({
        matcher: "Write|Edit|Bash",
        hooks: [{ type: "command", command: postToolUseCmd }],
      });
    }

    // UserPromptSubmit
    if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];
    const userPromptCmd = `node ${join(hooksDir, "log-prompt.js")}`;
    const hasUserPrompt = settings.hooks.UserPromptSubmit.some((entry: any) =>
      entry.hooks?.some((h: any) => h.command === userPromptCmd)
    );
    if (!hasUserPrompt) {
      settings.hooks.UserPromptSubmit.push({
        hooks: [{ type: "command", command: userPromptCmd }],
      });
    }

    // Stop
    if (!settings.hooks.Stop) settings.hooks.Stop = [];
    const stopCmd = `node ${join(hooksDir, "log-assistant.js")}`;
    const hasStop = settings.hooks.Stop.some((entry: any) =>
      entry.hooks?.some((h: any) => h.command === stopCmd)
    );
    if (!hasStop) {
      settings.hooks.Stop.push({
        hooks: [{ type: "command", command: stopCmd }],
      });
    }

    writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings - APIキー設定状況を返す
app.get("/api/settings", localhostOnlyMiddleware, (_req, res) => {
  const geminiKey    = process.env.GEMINI_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  res.json({
    gemini:    !!(geminiKey    && geminiKey    !== "your-gemini-key-here"),
    openai:    !!(openaiKey    && openaiKey    !== "your-openai-key-here"),
    anthropic: !!(anthropicKey && anthropicKey !== "your-api-key-here"),
  });
});

// GET /api/logs - 全ログ取得
app.get("/api/logs", dataAuthMiddleware, (_req, res) => {
  try {
    const logs = getAllLogs();
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "ログの読み取りに失敗しました" });
  }
});

// GET /api/logs/watch - SSE で新規ログをリアルタイム配信
app.get("/api/logs/watch", dataAuthMiddleware, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "http://localhost:" + PORT,
  });

  const knownFiles = new Set<string>();
  if (existsSync(LOG_DIR)) {
    for (const f of readdirSync(LOG_DIR)) {
      if (f.endsWith(".json")) knownFiles.add(f);
    }
  }

  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  const interval = setInterval(() => {
    if (!existsSync(LOG_DIR)) return;

    const currentFiles = readdirSync(LOG_DIR).filter((f) =>
      f.endsWith(".json")
    );
    for (const file of currentFiles) {
      if (!knownFiles.has(file)) {
        knownFiles.add(file);
        try {
          const content = readFileSync(join(LOG_DIR, file), "utf-8");
          const logEntry = JSON.parse(content);
          res.write(
            `data: ${JSON.stringify({ type: "new_log", log: logEntry })}\n\n`
          );
        } catch {
          // 読み取りエラーはスキップ
        }
      }
    }
  }, 1000);

  req.on("close", () => {
    clearInterval(interval);
  });
});

// 解説設定からプロンプトを構築
function buildExplainPrompt(context: string, settings: string[]): string {
  const isBeginner = settings.includes("beginner");
  const level = isBeginner
    ? "プログラミングを始めたばかりの初心者にも伝わるよう、できるだけ平易な言葉で"
    : "分かりやすく";

  let prompt = `あなたはプログラミングの先生です。以下のコードについて、${level}自然な日本語で解説してください。絵文字や箇条書きは使わず、普通の文章として書いてください。専門用語には必要に応じてカッコ書きで説明を添えてください。\n\n${context}\n\n`;

  const tasks: string[] = [];
  if (settings.includes("full")) {
    tasks.push("まず、このコード全体が何をしているかを一言で伝えてください。");
  }
  if (settings.includes("detail")) {
    tasks.push("次に、処理の流れを上から順に「まず〜して、次に〜します」のように自然な流れで説明してください。");
  }
  if (settings.includes("next")) {
    tasks.push("このコードを踏まえて、次に何をすれば良いか自然な文章で提案してください。具体的なアクションを順番に伝えてください。");
  }
  if (settings.includes("improve")) {
    tasks.push("このコードの改善できる点・リファクタリングできる点を自然な文章で提案してください。可読性・保守性・パフォーマンスの観点から、簡単なものから順に伝えてください。");
  }

  if (tasks.length === 0) {
    prompt += "このコードが何をしているかを簡潔に説明してください。";
  } else {
    prompt += tasks.join("\n");
  }
  return prompt;
}

// POST /api/explain-overview - トーク単位で解説（前トークの要約も受け取る）
app.post("/api/explain-overview", aiAuthMiddleware, async (req, res) => {
  const { logs, previousSummaries = [] } = req.body;

  if (!Array.isArray(logs) || logs.length === 0) {
    res.status(400).json({ error: "ログがありません。" });
    return;
  }

  const typeLabel = (type: string) =>
    type === "file_create" ? "新規作成" : type === "file_edit" ? "編集" : "コマンド実行";

  const logList = logs
    .map((l: any) => `- ${typeLabel(l.type)}: ${l.file || l.summary}（${l.language}）`)
    .join("\n");

  const prevContext = Array.isArray(previousSummaries) && previousSummaries.length > 0
    ? `これまでのトーク履歴:\n${previousSummaries.map((s: string, i: number) => `トーク${i + 1}: ${s}`).join("\n")}\n\n`
    : "";

  const prompt = `あなたはプログラミング初心者に寄り添うコーチです。${prevContext}以下は今回のトークで Claude Code が行った操作の一覧です。${prevContext ? "これまでの流れも踏まえつつ、" : ""}今回何を作ろうとしているのか・どのような作業が行われたのかを自然な日本語で説明してください。絵文字や箇条書きは使わず、普通の会話のように書いてください。

操作一覧:
${logList}

まず今回のトークで何をしているのかを一言で表してから、どのような作業の流れだったのかをまとめて教えてください。専門用語にはカッコ書きで説明を添えてください。`;

  try {
    const explanation = await callAI(prompt, getSessionPlan(req));
    res.json({ explanation });
  } catch (err: any) {
    res.status(500).json({ error: `生成に失敗しました: ${err.message}` });
  }
});

// POST /api/explain - AI解説を生成
app.post("/api/explain", aiAuthMiddleware, async (req, res) => {
  const { code, language, type, file, summary, settings = ["full"] } = req.body;
  const plan = getSessionPlan(req);

  if (!plan) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const geminiKey    = process.env.GEMINI_API_KEY;
    const openaiKey    = process.env.OPENAI_API_KEY;
    const hasAny = (anthropicKey && anthropicKey !== "your-api-key-here")
                || (geminiKey    && geminiKey    !== "your-gemini-key-here")
                || (openaiKey    && openaiKey    !== "your-openai-key-here");
    if (!hasAny) {
      res.status(400).json({ error: "APIキーが設定されていません。" });
      return;
    }
  }

  const typeLabel = type === "file_create" ? "新規ファイル作成"
                  : type === "file_edit"   ? "ファイル編集"
                  : "コマンド実行";

  const context = `## アクション情報
- 種別: ${typeLabel}
- ファイル: ${file || "なし"}
- 言語: ${language}
- 概要: ${summary}

## コード
\`\`\`${language}
${code}
\`\`\``;

  const prompt = buildExplainPrompt(context, Array.isArray(settings) ? settings : ["full"]);

  try {
    const explanation = await callAI(prompt, plan);
    res.json({ explanation });
  } catch (err: any) {
    console.error("API エラー:", err.message);
    res.status(500).json({ error: `解説の生成に失敗しました: ${err.message}` });
  }
});

// AI呼び出しユーティリティ（共通化）
async function callAI(prompt: string, plan?: PlanType | null): Promise<string> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const geminiKey    = process.env.GEMINI_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;
  const hasGemini    = geminiKey    && geminiKey    !== "your-gemini-key-here";
  const hasOpenAI    = openaiKey    && openaiKey    !== "your-openai-key-here";
  const hasAnthropic = anthropicKey && anthropicKey !== "your-api-key-here";

  const AI_TIMEOUT = 45_000; // 45秒でタイムアウト

  if (plan === "max") {
    if (!hasAnthropic) throw new Error("Anthropic APIキーが設定されていません。");
    const client = new Anthropic({ apiKey: anthropicKey!, timeout: AI_TIMEOUT, maxRetries: 0 });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return message.content[0].type === "text" ? message.content[0].text : "";
  }

  if (plan === "pro") {
    if (!hasOpenAI) throw new Error("OpenAI APIキーが設定されていません。");
    const client = new OpenAI({ apiKey: openaiKey!, timeout: AI_TIMEOUT, maxRetries: 0 });
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return completion.choices[0].message.content || "";
  }

  if (plan === "buy_once") {
    if (hasOpenAI) {
      const client = new OpenAI({ apiKey: openaiKey!, timeout: AI_TIMEOUT, maxRetries: 0 });
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini", max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      return completion.choices[0].message.content || "";
    } else if (hasGemini) {
      const genAI = new GoogleGenerativeAI(geminiKey!);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } else if (hasAnthropic) {
      const client = new Anthropic({ apiKey: anthropicKey!, timeout: AI_TIMEOUT, maxRetries: 0 });
      const message = await client.messages.create({
        model: "claude-sonnet-4-20250514", max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });
      return message.content[0].type === "text" ? message.content[0].text : "";
    }
    throw new Error("買い切りプランはAPIキーの設定が必要です。ガイドタブからAPIキーを設定してください。");
  }

  if (hasOpenAI) {
    const client = new OpenAI({ apiKey: openaiKey!, timeout: AI_TIMEOUT, maxRetries: 0 });
    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini", max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return completion.choices[0].message.content || "";
  } else if (hasGemini) {
    const genAI = new GoogleGenerativeAI(geminiKey!);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } else if (hasAnthropic) {
    const client = new Anthropic({ apiKey: anthropicKey!, timeout: AI_TIMEOUT, maxRetries: 0 });
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return message.content[0].type === "text" ? message.content[0].text : "";
  }
  throw new Error("APIキーが設定されていません。");
}

function buildReviewPrompt(userPrompt: string): string {
  return `あなたは Claude Code のプロンプト専門家です。以下のプロンプトを読んで、初心者が書いたものとして自然な日本語でフィードバックをしてください。絵文字や箇条書きは使わず、普通の文章として書いてください。

まず10点満点で点数をつけてその理由を一言で伝えてください。次に、このプロンプトの良かった点を自然に説明してから、もっと良くできる点とその理由を話しかけるように伝えてください。最後に、改善したプロンプトの例を実際に書いてください。

診断するプロンプト:
${userPrompt}`;
}

app.get("/api/prompts", dataAuthMiddleware, (_req, res) => {
  try {
    if (!existsSync(PROMPT_DIR)) return res.json([]);
    const files = readdirSync(PROMPT_DIR).filter(f => f.endsWith(".json")).sort();
    const prompts = files.map(f => {
      try { return JSON.parse(readFileSync(join(PROMPT_DIR, f), "utf-8")); }
      catch { return null; }
    }).filter(Boolean);
    res.json(prompts);
  } catch {
    res.status(500).json({ error: "プロンプトの読み取りに失敗しました" });
  }
});

app.get("/api/prompts/watch", dataAuthMiddleware, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "http://localhost:" + PORT,
  });

  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

  const knownFiles = new Set<string>();
  if (existsSync(PROMPT_DIR)) {
    for (const f of readdirSync(PROMPT_DIR)) {
      if (f.endsWith(".json")) knownFiles.add(f);
    }
  }

  const interval = setInterval(async () => {
    if (!existsSync(PROMPT_DIR)) return;
    const currentFiles = readdirSync(PROMPT_DIR).filter(f => f.endsWith(".json"));
    for (const file of currentFiles) {
      if (!knownFiles.has(file)) {
        knownFiles.add(file);
        try {
          const filePath = join(PROMPT_DIR, file);
          const entry = JSON.parse(readFileSync(filePath, "utf-8"));
          res.write(`data: ${JSON.stringify({ type: "new_prompt", prompt: entry })}\n\n`);
          try {
            const review = await callAI(buildReviewPrompt(entry.prompt), getSessionPlan(req));
            entry.review = review;
            entry.status = "reviewed";
            writeFileSync(filePath, JSON.stringify(entry), "utf-8");
            res.write(`data: ${JSON.stringify({ type: "prompt_reviewed", prompt: entry })}\n\n`);
          } catch (err: any) {
            entry.status = "error";
            entry.review = `診断エラー: ${err.message}`;
            writeFileSync(filePath, JSON.stringify(entry), "utf-8");
            res.write(`data: ${JSON.stringify({ type: "prompt_reviewed", prompt: entry })}\n\n`);
          }
        } catch { /* 読み取りエラーはスキップ */ }
      }
    }
  }, 1000);

  req.on("close", () => clearInterval(interval));
});

app.post("/api/review-prompt", aiAuthMiddleware, async (req, res) => {
  const { prompt: userPrompt } = req.body;
  if (!userPrompt || !userPrompt.trim()) {
    res.status(400).json({ error: "プロンプトを入力してください。" });
    return;
  }
  try {
    const text = await callAI(buildReviewPrompt(userPrompt), getSessionPlan(req));
    res.json({ review: text });
  } catch (err: any) {
    res.status(500).json({ error: `診断に失敗しました: ${err.message}` });
  }
});

app.post("/api/explain-batch", aiAuthMiddleware, async (req, res) => {
  const { logs: entries, settings = ["full"] } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: "ログがありません。" });
    return;
  }
  const typeLabel = (type: string) =>
    type === "file_create" ? "新規ファイル作成" : type === "file_edit" ? "ファイル編集" : "コマンド実行";
  const isBeginner = (settings as string[]).includes("beginner");
  const level = isBeginner ? "プログラミングを始めたばかりの初心者にも伝わるよう、できるだけ平易な言葉で" : "分かりやすく";
  const entriesText = entries.map((l: any, i: number) => `### 操作${i + 1}: ${typeLabel(l.type)} — ${l.file || l.summary}
概要: ${l.summary}
\`\`\`${l.language}
${(l.code || "").slice(0, 500)}
\`\`\``).join("\n\n");
  const tasks: string[] = [];
  if ((settings as string[]).includes("full")) tasks.push("まず、これらの操作全体が何を目的としているかを一言で伝えてください。");
  if ((settings as string[]).includes("detail")) tasks.push("次に、各操作の流れを「まず〜して、次に〜します」のように自然な文章で説明してください。");
  if ((settings as string[]).includes("next")) tasks.push("最後に、これらの操作を踏まえて次に何をすれば良いか提案してください。");
  if (tasks.length === 0) tasks.push("これらの操作が全体として何をしているかを簡潔に説明してください。");
  const prompt = `あなたはプログラミングの先生です。以下の複数のファイル操作について、${level}自然な日本語でまとめて解説してください。絵文字や箇条書きは使わず、普通の文章として書いてください。専門用語には必要に応じてカッコ書きで説明を添えてください。

${entriesText}

${tasks.join("\n")}`;
  try {
    const explanation = await callAI(prompt, getSessionPlan(req));
    res.json({ explanation });
  } catch (err: any) {
    res.status(500).json({ error: `解説の生成に失敗しました: ${err.message}` });
  }
});

app.post("/api/explain-batch-assistant", aiAuthMiddleware, async (req, res) => {
  const { messages: entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: "メッセージがありません。" });
    return;
  }
  const messagesText = entries.map((m: any, i: number) => `### 返答${i + 1}
${(m.message || "").slice(0, 800)}`).join("\n\n");
  const prompt = `あなたはプログラミング初心者に寄り添うコーチです。以下は Claude Code がユーザーに返した複数の返答です。これらをまとめて、初心者にも伝わるように自然な日本語で解説してください。絵文字や箇条書きは使わず、普通の会話のように書いてください。

まず全体としてどのようなやり取りがあったかを一言でまとめてから、各返答で Claude が何を伝えようとしていたのかを順に説明してください。専門用語が出てきたときはカッコ書きで意味を補ってください。

${messagesText}`;
  try {
    const explanation = await callAI(prompt, getSessionPlan(req));
    res.json({ explanation });
  } catch (err: any) {
    res.status(500).json({ error: `解説の生成に失敗しました: ${err.message}` });
  }
});

app.post("/api/suggest-next-actions", aiAuthMiddleware, async (req, res) => {
  const { prompt: userPrompt } = req.body;
  if (!userPrompt?.trim()) {
    res.status(400).json({ error: "プロンプトを入力してください。" });
    return;
  }
  const aiPrompt = `あなたは Claude Code のアシスタントです。ユーザーが Claude Code に送った以下のプロンプトを読んで、次に送ると良いフォローアップの指示を 4つ考えてください。

それぞれの指示は、Claude Code にそのまま貼り付けて送信できる短い日本語の文章（20〜40文字程度）にしてください。
JSON配列のみを返してください。説明文や前置きは不要です。

例: ["テストコードも追加してください", "このコードをリファクタリングしてください", "TypeScriptの型を追加してください", "エラーハンドリングを改善してください"]

ユーザーのプロンプト:
${userPrompt.slice(0, 1000)}

JSON配列のみ返してください:`;
  try {
    const text = await callAI(aiPrompt, getSessionPlan(req));
    const match = text.match(/\[[\s\S]*\]/);
    const actions: string[] = match ? JSON.parse(match[0]) : [];
    res.json({ actions: actions.slice(0, 4) });
  } catch (err: any) {
    res.status(500).json({ error: `提案の生成に失敗しました: ${err.message}` });
  }
});

function buildAssistantExplainPrompt(message: string): string {
  return `あなたはプログラミング初心者に寄り添うコーチです。以下は Claude Code がユーザーに返した文章です。この文章が何を伝えているのかを、初心者にも伝わるように自然な日本語で説明してください。絵文字や箇条書きは使わず、普通の会話のように書いてください。

まず一言でこの返答の要点をまとめてから、具体的に何をしているのか・何を勧めているのかを説明してください。専門用語が出てきたときはカッコ書きで意味を補ってください。

Claude Code の返答:
${message.slice(0, 3000)}`;
}

app.get("/api/assistant-messages", dataAuthMiddleware, (_req, res) => {
  try {
    if (!existsSync(ASSISTANT_DIR)) return res.json([]);
    const files = readdirSync(ASSISTANT_DIR).filter(f => f.endsWith(".json")).sort();
    const messages = files.map(f => {
      try { return JSON.parse(readFileSync(join(ASSISTANT_DIR, f), "utf-8")); }
      catch { return null; }
    }).filter(Boolean);
    res.json(messages);
  } catch {
    res.status(500).json({ error: "アシスタントメッセージの読み取りに失敗しました" });
  }
});

app.get("/api/assistant-messages/watch", dataAuthMiddleware, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "http://localhost:" + PORT,
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  const knownFiles = new Set<string>();
  if (existsSync(ASSISTANT_DIR)) {
    for (const f of readdirSync(ASSISTANT_DIR)) {
      if (f.endsWith(".json")) knownFiles.add(f);
    }
  }
  const interval = setInterval(async () => {
    if (!existsSync(ASSISTANT_DIR)) return;
    const currentFiles = readdirSync(ASSISTANT_DIR).filter(f => f.endsWith(".json")).sort();
    for (const file of currentFiles) {
      if (!knownFiles.has(file)) {
        knownFiles.add(file);
        try {
          const filePath = join(ASSISTANT_DIR, file);
          const entry = JSON.parse(readFileSync(filePath, "utf-8"));
          res.write(`data: ${JSON.stringify({ type: "new_assistant_message", message: entry })}\n\n`);
          try {
            const explanation = await callAI(buildAssistantExplainPrompt(entry.message), getSessionPlan(req));
            entry.explanation = explanation;
            entry.status = "explained";
            writeFileSync(filePath, JSON.stringify(entry), "utf-8");
            res.write(`data: ${JSON.stringify({ type: "assistant_message_explained", message: entry })}\n\n`);
          } catch (err: any) {
            entry.status = "error";
            entry.explanation = `解説エラー: ${err.message}`;
            writeFileSync(filePath, JSON.stringify(entry), "utf-8");
            res.write(`data: ${JSON.stringify({ type: "assistant_message_explained", message: entry })}\n\n`);
          }
        } catch { /* 読み取りエラーはスキップ */ }
      }
    }
  }, 1000);
  req.on("close", () => clearInterval(interval));
});

app.post("/api/explain-assistant", aiAuthMiddleware, async (req, res) => {
  const { id, message } = req.body;
  if (!message || !message.trim()) {
    res.status(400).json({ error: "メッセージが空です。" });
    return;
  }
  try {
    const explanation = await callAI(buildAssistantExplainPrompt(message), getSessionPlan(req));
    if (id && existsSync(ASSISTANT_DIR)) {
      const files = readdirSync(ASSISTANT_DIR).filter(f => f.endsWith(".json") && f.includes(id.slice(0, 8)));
      if (files.length > 0) {
        const filePath = join(ASSISTANT_DIR, files[0]);
        try {
          const entry = JSON.parse(readFileSync(filePath, "utf-8"));
          entry.explanation = explanation;
          entry.status = "explained";
          writeFileSync(filePath, JSON.stringify(entry), "utf-8");
        } catch { /* ignore */ }
      }
    }
    res.json({ explanation });
  } catch (err: any) {
    res.status(500).json({ error: `解説の生成に失敗しました: ${err.message}` });
  }
});

function saveToHistory(kind: "log" | "prompt" | "assistant", id: string, timestamp: string, data: any) {
  try {
    const existing = existsSync(HISTORY_DIR)
      ? readdirSync(HISTORY_DIR).some(f => f.includes(id.slice(0, 8)))
      : false;
    if (existing) return;
    const record = { id, timestamp, kind, data };
    const ts = new Date(timestamp).getTime();
    const fileName = `${ts}-${kind}-${id.slice(0, 8)}.json`;
    writeFileSync(join(HISTORY_DIR, fileName), JSON.stringify(record), "utf-8");
  } catch { /* ignore */ }
}

app.get("/api/history", dataAuthMiddleware, (_req, res) => {
  try {
    if (!existsSync(HISTORY_DIR)) return res.json([]);
    const files = readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json")).sort();
    const records = files.map(f => {
      try { return JSON.parse(readFileSync(join(HISTORY_DIR, f), "utf-8")); }
      catch { return null; }
    }).filter(Boolean);
    res.json(records);
  } catch {
    res.status(500).json({ error: "履歴の読み取りに失敗しました" });
  }
});

app.get("/api/history/watch", dataAuthMiddleware, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "http://localhost:" + PORT,
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  const knownFiles = new Set<string>();
  if (existsSync(HISTORY_DIR)) {
    for (const f of readdirSync(HISTORY_DIR)) {
      if (f.endsWith(".json")) knownFiles.add(f);
    }
  }
  const interval = setInterval(() => {
    if (!existsSync(HISTORY_DIR)) return;
    for (const file of readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json"))) {
      if (!knownFiles.has(file)) {
        knownFiles.add(file);
        try {
          const record = JSON.parse(readFileSync(join(HISTORY_DIR, file), "utf-8"));
          res.write(`data: ${JSON.stringify({ type: "new_record", record })}\n\n`);
        } catch { /* ignore */ }
      }
    }
  }, 1000);
  req.on("close", () => clearInterval(interval));
});

function startHistoryBackup() {
  const knownLogs    = new Set<string>();
  const knownPrompts = new Set<string>();
  if (existsSync(LOG_DIR)) {
    for (const f of readdirSync(LOG_DIR).filter(f => f.endsWith(".json"))) knownLogs.add(f);
  }
  if (existsSync(PROMPT_DIR)) {
    for (const f of readdirSync(PROMPT_DIR).filter(f => f.endsWith(".json"))) knownPrompts.add(f);
  }
  setInterval(() => {
    if (existsSync(LOG_DIR)) {
      for (const f of readdirSync(LOG_DIR).filter(f => f.endsWith(".json"))) {
        if (!knownLogs.has(f)) {
          knownLogs.add(f);
          try {
            const data = JSON.parse(readFileSync(join(LOG_DIR, f), "utf-8"));
            saveToHistory("log", data.id, data.timestamp, data);
          } catch { /* ignore */ }
        }
      }
    }
    if (existsSync(PROMPT_DIR)) {
      for (const f of readdirSync(PROMPT_DIR).filter(f => f.endsWith(".json"))) {
        if (!knownPrompts.has(f)) {
          knownPrompts.add(f);
          try {
            const data = JSON.parse(readFileSync(join(PROMPT_DIR, f), "utf-8"));
            saveToHistory("prompt", data.id, data.timestamp, data);
          } catch { /* ignore */ }
        }
      }
    }
  }, 1200);
}

const pendingAssistantQueue: any[] = [];

function saveAssistantFromTranscript(entry: any) {
  try {
    const contentBlocks: any[] = entry.message?.content ?? [];
    const text = contentBlocks
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text as string)
      .join("\n")
      .trim();
    if (!text || text.length < 20) return;
    const id = entry.uuid as string;
    const existingFiles = existsSync(ASSISTANT_DIR)
      ? readdirSync(ASSISTANT_DIR).filter(f => f.includes(id.slice(0, 8)))
      : [];
    if (existingFiles.length > 0) return;
    const preview = text.slice(0, 200).replace(/\n+/g, " ");
    const logEntry = {
      id,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      message: text,
      preview,
      status: "pending",
      explanation: null,
    };
    const fileName = `${new Date(logEntry.timestamp).getTime()}-${id.slice(0, 8)}.json`;
    writeFileSync(join(ASSISTANT_DIR, fileName), JSON.stringify(logEntry), "utf-8");
    saveToHistory("assistant", id, logEntry.timestamp, logEntry);
    pendingAssistantQueue.push(logEntry);
  } catch { /* ignore */ }
}

function processJSONLFile(filePath: string) {
  try {
    const stat = statSync(filePath);
    const lastSize = fileLastSize.get(filePath);
    if (lastSize === undefined) {
      fileLastSize.set(filePath, stat.size);
      const content = readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        try {
          const e = JSON.parse(line);
          if (e.uuid) seenUuids.add(e.uuid);
        } catch { /* skip */ }
      }
      return;
    }
    if (stat.size <= lastSize) return;
    fileLastSize.set(filePath, stat.size);
    const buf = Buffer.alloc(stat.size - lastSize);
    const fd = openSync(filePath, "r");
    readSync(fd, buf, 0, buf.length, lastSize);
    closeSync(fd);
    const newLines = buf.toString("utf-8").split("\n").filter(l => l.trim());
    for (const line of newLines) {
      try {
        const entry = JSON.parse(line);
        if (!entry.uuid || seenUuids.has(entry.uuid)) continue;
        seenUuids.add(entry.uuid);
        if (entry.type === "assistant") {
          console.log(`[assistant] 新しい返答を検出: ${entry.uuid?.slice(0, 8)}`);
          saveAssistantFromTranscript(entry);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

function watchClaudeTranscripts() {
  if (!existsSync(CLAUDE_PROJECTS)) {
    console.log(`[watch] Claude projects ディレクトリが見つかりません: ${CLAUDE_PROJECTS}`);
    return;
  }
  console.log(`[watch] Claude Code セッション監視開始: ${CLAUDE_PROJECTS}`);
  setInterval(() => {
    try {
      for (const projectDir of readdirSync(CLAUDE_PROJECTS)) {
        const projectPath = join(CLAUDE_PROJECTS, projectDir);
        try {
          for (const file of readdirSync(projectPath).filter(f => f.endsWith(".jsonl"))) {
            processJSONLFile(join(projectPath, file));
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }, 1000);
}

const USED_CODES_PATH = join(homedir(), ".code-explainer", "used-codes.json");
const MAX_USES_PER_CODE = 15;

function getUsageCount(): Record<string, number> {
  try {
    if (existsSync(USED_CODES_PATH)) {
      const data = JSON.parse(readFileSync(USED_CODES_PATH, "utf-8"));
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    }
  } catch { /* ignore */ }
  return {};
}

function incrementUsage(code: string) {
  const counts = getUsageCount();
  counts[code] = (counts[code] ?? 0) + 1;
  try { writeFileSync(USED_CODES_PATH, JSON.stringify(counts, null, 2)); } catch { /* ignore */ }
}

app.post("/api/invite/redeem", (req, res, next) => {
  const ip = getClientIp(req);
  if (!checkInviteRateLimit(ip)) {
    res.status(429).json({ error: "試行回数が多すぎます。しばらく待ってから再試行してください。" });
    return;
  }
  next();
}, (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code || typeof code !== "string") {
    return res.status(400).json({ ok: false, error: "コードを入力してください" });
  }
  const normalized = code.trim().toUpperCase();
  const rawCodes = process.env.INVITE_CODES ?? "";
  const validCodes = rawCodes.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (validCodes.length === 0) {
    return res.status(500).json({ ok: false, error: "招待コードが設定されていません（管理者にお問い合わせください）" });
  }
  if (!validCodes.includes(normalized)) {
    return res.status(400).json({ ok: false, error: "無効な招待コードです" });
  }
  const counts = getUsageCount();
  const used = counts[normalized] ?? 0;
  if (used >= MAX_USES_PER_CODE) {
    return res.status(400).json({ ok: false, error: `招待コードの上限（${MAX_USES_PER_CODE}名）に達しました` });
  }
  incrementUsage(normalized);
  const token = randomUUID();
  saveSession(token, "pro");
  console.log(`[invite] コード使用: ${normalized} (${used + 1}/${MAX_USES_PER_CODE})`);
  res.json({ ok: true, plan: "pro", token });
});

app.get("/api/session/validate", (req, res) => {
  const plan = getSessionPlan(req);
  if (!plan) return res.status(401).json({ valid: false });
  res.json({ valid: true, plan });
});

function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key === "your-stripe-secret-key-here") return null;
  return new Stripe(key);
}

app.post("/api/stripe/create-checkout-session", async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(500).json({ error: "Stripe キーが設定されていません" });
  }
  const { priceId, mode } = req.body as { priceId: string; mode: "subscription" | "payment" };
  if (!priceId || !mode) {
    return res.status(400).json({ error: "priceId と mode は必須です" });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL || `http://localhost:${PORT}`}/upgrade?session_id={CHECKOUT_SESSION_ID}&status=success`,
      cancel_url:  `${process.env.APP_URL || `http://localhost:${PORT}`}/upgrade?status=cancel`,
      locale: "ja",
    });
    res.json({ url: session.url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/stripe/session-token", async (req, res) => {
  const stripe = getStripe();
  if (!stripe) return res.status(500).json({ error: "Stripe未設定" });
  const sessionId = req.query.session_id as string;
  if (!sessionId) return res.status(400).json({ error: "session_id が必要です" });
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid" && session.status !== "complete") {
      return res.status(400).json({ error: "決済が完了していません" });
    }
    const lineItems = await stripe.checkout.sessions.listLineItems(sessionId);
    const priceId = lineItems.data[0]?.price?.id;
    const plan: PlanType = priceId === MAX_PRICE_ID      ? "max"
                         : priceId === BUY_ONCE_PRICE_ID ? "buy_once"
                         : "pro";
    const token = randomUUID();
    saveSession(token, plan);
    console.log(`[stripe] トークン発行: plan=${plan}`);
    res.json({ ok: true, plan, token });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers["stripe-signature"] as string;
  const stripe = getStripe();
  if (!stripe || !webhookSecret) {
    return res.status(400).json({ error: "Stripe 設定が不完全です" });
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err: any) {
    console.error("[stripe webhook] 署名検証エラー:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    console.log(`[stripe] 決済完了: ${session.id} mode=${session.mode}`);
  }
  res.json({ received: true });
});

// ── LINE Webhook ──────────────────────────────────────────────────────────────

// LINE からの raw body が必要なため express.raw() を使う
app.post(
  "/webhook/line",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

    if (!channelSecret || !channelAccessToken) {
      console.error("[LINE] 環境変数 LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN が未設定");
      return res.status(500).json({ error: "LINE設定が未完了です" });
    }
    if (!anthropicApiKey) {
      console.error("[LINE] 環境変数 ANTHROPIC_API_KEY が未設定");
      return res.status(500).json({ error: "Anthropic APIキーが未設定です" });
    }

    const signature = req.headers["x-line-signature"] as string | undefined;
    if (!signature) {
      return res.status(400).json({ error: "署名がありません" });
    }

    const rawBody = req.body as Buffer;
    if (!verifyLineSignature(rawBody, signature, channelSecret)) {
      console.warn("[LINE] 署名検証失敗 - 不正なリクエストの可能性");
      return res.status(401).json({ error: "署名が無効です" });
    }

    let body: { destination: string; events: unknown[] };
    try {
      body = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      return res.status(400).json({ error: "JSONパースエラー" });
    }

    // 即座に200を返す（LINEのタイムアウト対策）
    res.json({ ok: true });

    // 非同期でイベント処理
    handleLineWebhook(
      body as Parameters<typeof handleLineWebhook>[0],
      undefined,
      channelAccessToken,
      anthropicApiKey
    ).catch((err) => console.error("[LINE] handleLineWebhook エラー:", err));
  }
);

// ── ビジネスサイト配信 ────────────────────────────────────────────────────────

const businessSitePath = join(dirname(fileURLToPath(import.meta.url)), "..", "business-site");
if (existsSync(businessSitePath)) {
  app.use("/business-site", express.static(businessSitePath));
  console.log("[business-site] /business-site で配信します");
}

// ─────────────────────────────────────────────────────────────────────────────

async function startServer() {
  const landingPath = join(dirname(fileURLToPath(import.meta.url)), "..", "landing");
  const distPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
  if (existsSync(join(distPath, "index.html"))) {
    // dist/ を優先（アプリ本体）
    app.use(express.static(distPath));
    // ランディングページは /landing で提供
    if (existsSync(join(landingPath, "index.html"))) {
      app.use("/landing", express.static(landingPath));
    }
    app.get("*", (_req, res) => {
      res.sendFile(join(distPath, "index.html"));
    });
  } else if (existsSync(join(landingPath, "index.html"))) {
    app.use(express.static(landingPath));
    app.get("*", (_req, res) => {
      res.sendFile(join(landingPath, "index.html"));
    });
  } else {
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }
  watchClaudeTranscripts();
  startHistoryBackup();
  app.listen(PORT, () => {
    console.log(`\n  🔍 Code Explainer が起動しました`);
    console.log(`  📡 http://localhost:${PORT}\n`);
    console.log(`  ログ監視ディレクトリ: ${LOG_DIR}`);
    console.log(`  Claude Code セッション監視: ${CLAUDE_PROJECTS}`);
    console.log(`  Ctrl+C で停止\n`);
  });
}

startServer();
