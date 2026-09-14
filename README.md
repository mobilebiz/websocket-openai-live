# Vonage と OpenAI Live API (GPT-Live) の WebSocket 連携

Vonage Voice API の音声ストリームを OpenAI の **Live API (GPT-Live)** に中継し、
電話越しに音声対話ができるサーバーです。

Realtime API 版は [`../websocket-openai`](../websocket-openai) にあります。
API の違いと移植方針は [`docs/gpt-live-investigation.md`](docs/gpt-live-investigation.md) にまとめています。

現在は**最小構成**です。着信 → NCCO → WebSocket → GPT-Live の音声往復までを実装しています。
ツール (Function Calling)、アウトバウンド発信、VCR 前段は未実装です。

## 概要

```
着信 → /answer (NCCO)
     → connect で wss://<このサーバー>/media-stream
     → GPT-Live (wss://api.openai.com/v1/live/sessions)
```

GPT-Live は音声会話 (`gpt-live-1`) と推論・ツール (バックエンドモデル) が分離されています。
このプロジェクトは `responses` 委譲を使い、バックエンドは OpenAI 側に任せています。

音声は Vonage と GPT-Live で**同じサンプリングレート (既定 16kHz) の PCM16LE** に揃えているため、
リサンプリングは行いません。Vonage が 20ms フレームを前提にしているため、
GPT-Live から可変長で届く音声だけフレームに切り直しています。

## ディレクトリ構成

```text
index.js                     エントリポイント (設定の読み込みとサーバー起動のみ)
src/
  config.js                  環境変数の集約と検証
  server.js                  Fastify の組み立て・ルート登録
  routes/
    health.js                / , /_/health
    vonage-webhooks.js       /event , /answer (NCCO の生成)
    media-stream.js          /media-stream (WebSocket)
  live/
    session.js               session.start / 挨拶指示の生成
    bridge.js                Vonage ⇔ GPT-Live の中継本体
  audio/
    frames.js                20ms フレームへの切り出し
system-message.txt           会話スタイルの指示 (session.instructions)
backend-message.txt          業務ルールの指示 (delegation.responses.instructions)
scripts/warmup.js            デプロイ後にマシンを起こす (コールドスタート対策)
docs/
  gpt-live-investigation.md  Realtime API との差分調査
Dockerfile / fly.toml        Fly.io へのデプロイ設定
```

プロンプトが 2 つあるのは GPT-Live の構造によるものです。
会話の振る舞いは `system-message.txt`、調べ物や業務ルールは `backend-message.txt` に書きます。
どちらもファイルが無い・空の場合は `src/config.js` の既定値を使います。

## 必要な環境

- Node.js 22 以上
- Vonage アカウントと電話番号
- OpenAI の API キー (GPT-Live は無料枠では使えません)

## 設定

### Vonage の準備

1. [Vonageアカウントの作成](https://zenn.dev/kwcplus/articles/create-vonage-account)
1. [Vonageで電話番号を取得する方法](https://zenn.dev/kwcplus/articles/buynumber-vonage)
1. [Vonage Voice API ガイド](https://zenn.dev/kwcplus/articles/vonage-voice-guide) に従ってアプリケーションを作成
1. 作成したアプリケーションに購入した電話番号をリンク

### セットアップ

```sh
npm install
cp .env.example .env
```

キー | 必須 | 値
:--|:--|:--
`SERVER_URL` | ✅ | Fly.io で払い出されたホスト名 (例 `websocket-openai-live.fly.dev`)。Vonage の WebSocket は `wss://` のみ対応のため `http://` は指定できません
`OPENAI_API_KEY` | ✅ | OpenAI のシークレットキー
`OPENAI_MODEL` | | 音声会話のモデル。既定は `gpt-live-1`
`OPENAI_VOICE` | | 音声の種類。既定は `marin`
`OPENAI_BACKEND_MODEL` | | 委譲先のモデル。既定は `gpt-5.6-luna`。`gpt-5.6-terra` は品質と遅延のバランス型
`OPENAI_SERVICE_TIER` | | `auto` / `default` / `flex` / `priority`。既定は `priority` (Fast mode)。空にすると指定しない
`OPENAI_REASONING_EFFORT` | | `minimal` / `low` / `medium` / `high`。既定は `low`。空にすると指定しない
`OPENAI_MAX_OUTPUT_TOKENS` | | 委譲先の出力上限 (最小 16)。既定は指定なし
`AUDIO_RATE` | | Vonage と GPT-Live 共通のサンプリングレート。`16000` (既定) か `24000`
`LOG_LEVEL` | | ログレベル。既定は `info`
`PORT` | | 待ち受けポート。既定は 3000

## Fly.io へのデプロイ

### Fly.io CLI のインストール

```sh
brew install flyctl
fly auth login
```

### 初期セットアップ (一度だけ)

デプロイ環境を作成します。`fly.toml` があるので、既存の設定を使うか聞かれたら「はい」を選びます。

```sh
fly launch
```

払い出されたホスト名 (`<アプリ名>.fly.dev`) を `.env` の `SERVER_URL` に設定してから、
環境変数を Fly.io に反映します。

```sh
fly secrets import < .env
```

### デプロイ

```sh
npm run deploy
```

`fly deploy` の後に `scripts/warmup.js` が走り、マシンを起こしてから終わります
(理由は後述の「コールドスタートに注意」)。手動で起こしたいときは `npm run warmup` です。

### Webhook URL の設定

Vonage ダッシュボードでアプリケーションの
**回答 URL** に `https://<アプリ名>.fly.dev/answer`、
**イベント URL** に `https://<アプリ名>.fly.dev/event` を、いずれもメソッド `POST` で設定します。

Fly.io のホスト名は固定なので、設定は最初の一度だけです。

### コールドスタートに注意

Vonage の `answer_url` は応答を **5 秒**しか待ちません
(`socket_timeout` の上限が 5,000ms のため延ばせません)。
マシンの状態ごとの応答時間を実測すると、この制限に収まるかどうかがはっきり分かれます。

マシンの状態 | `/_/health` の応答時間 | 5 秒制限
:--|--:|:--
`stopped` (完全停止) | 約 7.5 秒 | ❌ 間に合わない
`suspended` (メモリ保持) | 約 0.5 秒 | ✅
`started` | 約 0.03 秒 | ✅

`fly.toml` では `auto_stop_machines = 'suspend'` にしてあるため、
アイドルで止まったマシンは `suspended` になり、復帰が間に合います。
**ここを `'stop'` に変えないでください。**

問題は `fly deploy` の直後で、このときマシンは `stopped` です。
一度もリクエストを受けないまま着信すると 7.5 秒かかって切断されます。
`npm run deploy` が最後に `scripts/warmup.js` を実行して起こしているのはこのためです。

しばらく着信が無い日が続くなど、`suspended` から `stopped` に落ちることもあります。
着信が切れるようになったら `npm run warmup` で起こすか、
以下のいずれかに切り替えてください。

- `fly.toml` の `min_machines_running` を `1` にして常時起動 (月 $6 前後)
- 常時起動している VCR に `answer_url` だけ受けさせる前段を置く
  (Realtime API 版 `../websocket-openai` の `APP_ROLE=front` が実装例)

### ローカルでの開発 (任意)

手元で動かす場合は ngrok でトンネルを張ります。

```sh
npm start
ngrok http 3000
```

ngrok が払い出したホスト名を `.env` の `SERVER_URL` に設定して再起動し、
Vonage 側の Webhook URL も ngrok のものに切り替えます。
ngrok は再起動のたびに URL が変わるため、その都度この手順が必要です。

## 動作確認

アプリケーションにリンクした電話番号に電話をかけ、AI が応答することを確認します。

通話を切ると、受け取った音声の到着ペースがログに出ます。

```
音声の到着ペース (1.0 なら実時間。大きいほど先行して届いている)
  receivedAudioMs=12340 elapsedMs=12010 ratio=1.03
```

`ratio` が 1.0 前後なら GPT-Live は実時間で音声を返しており、
Vonage 側にバッファが溜まらないため割り込み時の破棄処理は要りません。
**実測では 0.96 でした**ので、Realtime API 版に必要だった `{"action":"clear"}` は不要です。

応答の速さは、ユーザーが話し終えてからアシスタントが話し始めるまでの間として出ます。

```
⏱️ 応答までの間  gapMs=820
```

この値は GPT-Live のセッションタイムライン上の差なので、
電話・Vonage・Fly.io の経路は含みません。体感との差がそのまま伝送の遅延です。
full-duplex のため、相槌のように被せて話し始めると負の値になります。

### タイムラグを詰める

会話そのものの速さ (`gpt-live-1`) はパラメータでは変わりません。
プロンプト (`system-message.txt`) での相槌や間の指示と、ネットワーク経路が効きます。

調整できるのは**委譲した調べ物の待ち時間**です。ここは数十秒かかることがあります。

- `OPENAI_SERVICE_TIER=priority` — Fast mode。既定
- `OPENAI_REASONING_EFFORT=minimal` — 考える時間を最短に (既定は `low`)
- `OPENAI_MAX_OUTPUT_TOKENS=300` — 長い答えの生成完了を待たない
- `OPENAI_BACKEND_MODEL=gpt-5.6-terra` — Luna より賢いぶん、少ない試行で終わることがある

また `system-message.txt` の委譲の方針を狭めて、
そもそも委譲せずに答えられるものを増やすのも効きます。

## 今後

- 到着ペースの実測と、必要なら割り込み処理の実装
- ツール (Function Calling) — `delegation.responses.tools` に定義を載せ、
  `response.event` の入れ子で届く `function_call` を実行して
  `response.item.create` + `response.create` で返す
- `/connect` でのアウトバウンド発信
- コールドスタートが 5 秒に間に合わない場合の VCR 前段 (`APP_ROLE=front`)
- ユニットテスト (tap)
