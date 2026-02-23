# 🔑 APIキー設定ガイド
### Code Explainer をはじめて使う方へ

---

## はじめに：APIキーってなに？

「APIキー」とは、あなた専用の **合言葉** のようなものです。
Code Explainer が AI に解説を依頼するとき、この合言葉を使って「正規のユーザーです」と証明します。

> **💡 例えるなら...**
> 図書館の会員カード番号のようなもので、あなただけに発行される固有の番号です。

---

## どちらのAIを使いますか？

Code Explainer は 2種類の AI に対応しています。

| | Gemini（Google） | Claude（Anthropic） |
|---|---|---|
| **料金** | **無料枠あり** ✅ | 有料（$5〜） |
| **性能** | 十分な品質 | 高品質 |
| **おすすめ** | まず試したい方 | 本格的に使いたい方 |

👉 **はじめての方は Gemini（無料）からスタートがおすすめです！**

---

# 🆓 Gemini（無料）で始める方法

## ⚠️ 始める前に確認すること

- パソコン（Mac または Windows）
- Google アカウント（Gmail があればOK）
- クレジットカード不要！

---

## STEP 1：Google AI Studio を開く

**1. 下のURLをブラウザで開いてください**

```
https://aistudio.google.com/app/apikey
```

**2. Google アカウントでログイン**

（Gmail のアカウントでそのまま使えます）

---

## STEP 2：APIキーを発行する

**1.「Create API key」をクリック**

**2.「Create API key in new project」を選択**

**3. しばらく待つと、長い文字列が表示されます（例：`AIzaSy...`）**

**4. 「Copy」ボタンを押してコピー**

> ⚠️ このキーはあとで確認できますが、念のためメモ帳に保存しておきましょう。

> ✅ これだけでOK！クレジットカード不要です。

---

## STEP 3：アプリにAPIキーを設定する

**1. Code Explainer のフォルダを開く**

Finder で `code-explainer` フォルダを開いてください。

**2. `.env` ファイルをテキストエディタで開く**

> **Macの方：**
> `.env` ファイルを右クリック →「このアプリケーションで開く」→「テキストエディット」

> **Windowsの方：**
> `.env` ファイルを右クリック →「プログラムから開く」→「メモ帳」

> 💡 ファイルが見えない場合：
> Mac → Finder で `Command + Shift + .` を押すと隠しファイルが表示されます
> Windows → エクスプローラーの「表示」→「隠しファイル」にチェック

**3. ファイルの中身を書き換える**

開くと以下のような文字があります：

```
ANTHROPIC_API_KEY=your-api-key-here
GEMINI_API_KEY=your-gemini-key-here
```

`your-gemini-key-here` の部分を、さっきコピーしたキーに書き換えてください：

```
ANTHROPIC_API_KEY=your-api-key-here
GEMINI_API_KEY=AIzaSyここにあなたのキーを貼り付ける
```

**4. 保存して閉じる**

---

## STEP 4：動作確認

**1. ターミナルを開いて、以下を入力して Enter を押す：**

```bash
cd ~/code-explainer && npm run dev
```

**2. ブラウザで下のURLを開く：**

```
http://localhost:3001
```

**3. 別のターミナルで Claude Code を使ってみる**

ファイルを作成・編集したときに、画面に解説が表示されれば成功です！ 🎉

---

## Gemini 無料枠の制限について

無料枠では以下の制限があります。通常の使い方であれば問題ありません。

| 制限 | 内容 |
|------|------|
| 1分あたりのリクエスト数 | 15回まで |
| 1日あたりのリクエスト数 | 1,500回まで |

> 制限を超えた場合は「しばらく待ってから再試行してください」というエラーが表示されます。

---
---

# 💳 Claude（Anthropic）で使う方法

より高品質な解説を希望する方向けです。

## ⚠️ 始める前に確認すること

- パソコン（Mac または Windows）
- メールアドレス
- クレジットカードまたはデビットカード（少額の入金が必要です）

---

## STEP 1：Anthropic のアカウントを作る

**1. 下のURLをブラウザで開いてください**

```
https://console.anthropic.com
```

**2.「Sign Up」または「新規登録」をクリック**

**3. メールアドレスとパスワードを入力して登録**

**4. 届いたメールを開いて、メール認証を完了させる**

> ✅ ここまでできたら、アカウント作成完了です！

---

## STEP 2：クレジットを追加する（少額でOK）

APIの利用には、事前のチャージが必要です。
**まず $5（約750円）** から始めるのがおすすめです。

**1. ログイン後、左側のメニューから「Billing」をクリック**

**2.「Add credit」または「Purchase credits」をクリック**

**3. クレジットカード情報を入力**

**4. 金額を選択（最低 $5 から）→「Purchase」をクリック**

> ✅ $5 は数ヶ月〜数年使える量なので安心してください。

---

## STEP 3：APIキーを発行する

**1. 左側のメニューから「API Keys」をクリック**

**2. 画面右上の「+ Create Key」をクリック**

**3. キーの名前を入力**（なんでもOK。例：`code-explainer`）

**4.「Create Key」をクリック**

**5. 画面に長い文字列が表示されます（例：`sk-ant-api03-...`）**

> ⚠️ **重要！** このキーは**この画面でしか確認できません。**
> 必ずコピーしてメモ帳などに一時保存してください。

---

## STEP 4：アプリにAPIキーを設定する

`.env` ファイルの `your-api-key-here` の部分を書き換えてください：

```
ANTHROPIC_API_KEY=sk-ant-api03-ここにあなたのキーを貼り付ける
GEMINI_API_KEY=your-gemini-key-here
```

保存してアプリを再起動すれば完了です。

---

## よくある質問

**Q. GeminiとAnthropicのキーを両方設定したらどうなりますか？**
A. Gemini が優先して使われます。Gemini を使いたくない場合は、Gemini のキーを削除してください。

**Q. APIキーを誰かに見せてしまった！**
A. すぐに発行元のサイトでそのキーを削除して、新しいキーを発行してください。

**Q. Gemini で「制限を超えました」と表示される**
A. 1分間に15回以上使うと制限がかかります。少し待ってから使ってみてください。

**Q. `.env` ファイルが見つからない**
A. Mac の場合、`Command + Shift + .` を押すと隠しファイルが表示されます。

**Q. 設定したのに「APIキーが設定されていません」と表示される**
A. `.env` ファイルを保存後、アプリを一度停止（`Ctrl + C`）して再起動してみてください。

---

## 困ったときは

**Gemini（Google）**
- Google AI Studio: https://aistudio.google.com/app/apikey

**Claude（Anthropic）**
- Anthropic サポート: https://support.anthropic.com
- APIキーの管理: https://console.anthropic.com/settings/keys
- 料金の確認: https://console.anthropic.com/settings/billing

---

*このガイドは Code Explainer v1.0 に対応しています*
