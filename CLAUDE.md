# CLAUDE.md

Vonage Voice API の音声ストリームを OpenAI Live API (GPT-Live) に中継する Fastify サーバー。
Realtime API 版は `../websocket-openai` にある。**あちらのコードをそのまま持ってこないこと**
(API が別物。差分は `docs/gpt-live-investigation.md`)。

## コマンド

```sh
npm start       # サーバー起動
npm run deploy  # Fly.io へデプロイ (デプロイ後にマシンを起こすところまで)
npm run warmup  # マシンを起こすだけ
```

## アーキテクチャ

`index.js` は設定の読み込みと起動のみ。実体は `src/` にある。

- `src/config.js` — 環境変数を読んで 1 つの設定オブジェクトにする。`process.env` を直接読むのは
  ここと `index.js` だけ。他のモジュールは引数で config を受け取る (テストで差し替えられるように)。
  待ち受けポートは `VCR_PORT` を最優先する
- `src/server.js` — `buildServer(config)` が Fastify インスタンスを返す。`listen` はしないので
  テストからは `fastify.inject()` でそのまま使える
- `src/live/bridge.js` — 中継の本体。**状態はすべて `createBridge` のスコープに閉じること**。
  モジュールスコープに可変状態を置くと同時通話が互いに干渉する
- `src/live/session.js` — `session.start` と挨拶指示の組み立て

## GPT-Live で気をつけること

Realtime API とは**プロトコルが別物**。以下を混同しない。

- 接続先は `wss://api.openai.com/v1/live/sessions`。モデルは URL のクエリではなく
  `session.start` の中で指定する
- 1 通目は `session.update` ではなく `session.start`
- 音声は `session.input_audio.append` / `session.output_audio.delta`
- **ターン制御が無い**。`input_audio_buffer.commit` も `response.create` によるターン起動も無い。
  音声は流しっぱなしで、いつ話すかはモデルが決める
- **`conversation.item.truncate` が無い**。`speech_started` も `response.output_audio.done` も無い。
  割り込みはモデル側で処理される前提
- 自分から先に話しかけたいときは **2 段階**。`session.started` の後に
  `session.instructions.append` (`delegation_id: null`) で「この文言を読み上げてから聞く」と指示し、
  `session.instructions.appended` の `client_event_id` を突き合わせてから
  `session.commentary.append` で口火を切らせる。
  **指示を足しただけでは話し始めない** (相手が話しかけてくるまで黙ったままになる)。
  `opening` のような専用フィールドは無い
- ツールは `session.tools` ではなく `delegation.responses.tools`。呼び出しは
  `response.event` の入れ子で届き、結果は `response.item.create` + `response.create` で返す。
  保留中の tool call を全部返してから `response.create` すること
- 終了時は `session.close` を送って `session.closed` を待つ。
  待たずに切ると最終的な利用秒数が確定しない

### サンプリングレート

Vonage と GPT-Live で**同じレートに揃えてある** (既定 16kHz)。`AUDIO_RATE` を変えるときは
NCCO の `contentType` と `session.start` の `audio.format` の両方に反映される
(`src/config.js` の 1 箇所で持っている)。GPT-Live の `audio.format` は**入出力共通で 1 つだけ**、
セッション途中では変更できない。

レートが揃っているのでリサンプリングは無い。Realtime 版にあった `src/audio/resample.js` は不要。
ただし Vonage は 20ms フレーム (16kHz なら 640 バイト) を前提にしているので、
GPT-Live から可変長で届く音声は `FrameSplitter` を通して切り直すこと。

### プロンプト

2 ファイルに分かれている。混ぜないこと。

- `system-message.txt` → `session.instructions` (会話スタイル・話し方・委譲の方針)
- `backend-message.txt` → `delegation.responses.instructions` (業務ルール・ツールの使い方)

### ログ

`console.log` ではなく Fastify のロガー (pino) を使う。開発時は pino-pretty で整形される。
API キーをログに出さないこと。

## デプロイ

Fly.io (`fly.toml`)。`npm run deploy` で反映する。環境変数は `fly secrets import < .env`。

`auto_stop_machines` は **`'suspend'` から変えないこと**。Vonage の `answer_url` は
5 秒 (上限も 5,000ms で延長不可) しか待たないが、実測した応答時間は
`stopped` で約 7.5 秒、`suspended` で約 0.5 秒、`started` で約 0.03 秒。
`'stop'` にすると着信が切断される。

`fly deploy` 直後のマシンは `stopped` なので、そのまま着信すると切れる。
`npm run deploy` は最後に `scripts/warmup.js` を実行して起こしている
(`fly status --json` でマシン一覧を取り、`fly-force-instance-id` で 1 台ずつ名指しで叩く)。
`fly deploy` を単体で実行したときは `npm run warmup` を忘れないこと。

それでも切れるようなら `min_machines_running = 1` で常時起動させるか、
VCR 前段 (`APP_ROLE=front`) を移植する。

Webhook URL は Vonage ダッシュボードで設定する。Fly.io のホスト名は固定なので一度だけでよい。
ローカル (ngrok) と切り替えるときは手で変える
(Realtime 版の `scripts/change-url.js` に相当するものはまだ移していない)。

## 未実装

ツール (Function Calling)、`/connect` でのアウトバウンド発信、VCR 前段 (`APP_ROLE=front`)、
ユニットテスト。Realtime 版には全部あるので、移す際は上記の差分を反映する。

## 実測で分かっていること

実機の通話 (121 秒) で確認済み。

- **音声は実時間で届く** (`ratio` 0.96)。Vonage 側にバッファが溜まらないので、
  Realtime 版に必要だった割り込み時の `{"action":"clear"}` は**要らない**
- `audio/pcm` の **16000 Hz は受理される**。リサンプリング不要で通話が成立する
- voice `marin`、`session.close` → `session.closed` (`reason: close_requested`) は期待どおり動く
- 初回挨拶は **`instructions.append` + `commentary.append` の 2 段階で動く**。
  commentary を送らなかったときは、相手が話しかけるまで黙ったままだった
- コストは音声 $0.05/分 + Vonage 約 $0.015/分 で、**1 通話あたり 10 円/分**ほど
  (実測: 121 秒で $0.131、89 秒で $0.097)
- `gapMs` はほぼ 0〜-200ms。GPT-Live は待たずに応答しており、
  **体感の遅延は伝送経路 (電話 → Vonage → Fly.io 東京 → OpenAI 米国) 由来**。
  会話の往復はパラメータでは詰められない
- 委譲した調べ物は `service_tier: priority` + `reasoning.effort: low` で
  **約 24 秒 → 約 12 秒**になった

### 遅延の切り分け

`bridge.js` は 2 つの指標をログに出す。**混同しないこと**。

- `ratio` (通話終了時) — 音声の到着ペース。伝送のバッファ滞留を見る
- `gapMs` (発話ごと) — ユーザーが話し終えてから話し始めるまでの間。
  GPT-Live のセッションタイムライン上の差なので**経路の遅延を含まない**。
  体感との差が電話・Vonage・Fly.io の伝送遅延にあたる

会話そのものの速さはパラメータでは変えられない。効くのは
`system-message.txt` の相槌・間の指示と、ネットワーク経路。

**委譲した調べ物の待ち時間**は設定で変わる (実測で 1 回あたり約 24 秒かかっていた)。
`delegation.responses` の `service_tier` (既定 `priority`) /
`reasoning.effort` (既定 `low`) / `max_output_tokens` / `model` で調整する。
いずれも `src/config.js` の `openai` から渡していて、環境変数を空にすれば送らない。
