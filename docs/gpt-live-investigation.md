# GPT-Live API 調査メモ

`../websocket-openai` (Vonage Voice API ⇔ OpenAI Realtime API) を
OpenAI **Live API (GPT-Live)** ベースに作り直すための事前調査。

調査日: 2026-09-12
一次情報: <https://developers.openai.com/api/docs/guides/live> とその配下のガイド群

---

## 1. GPT-Live とは何か

Realtime API が「1 つのモデルが 音声認識・推論・ツール選択・発話 をすべて担当する」のに対し、
GPT-Live は **音声会話担当 (gpt-live-1) と タスク処理担当 (バックエンドモデル) を分離**する。

- `gpt-live-1` は full-duplex。聞きながら話せる。ターン管理を API 利用者がやらない
- 業務ロジック・ツール実行は「delegation (委譲)」先が担当する
- 課金は音声セッション **$0.05 / 分 (秒単位課金)** + バックエンドモデルのトークン課金
- Live エンドポイント (`v1/live/sessions`) 専用モデル。knowledge cutoff 2025-07-31
- 無料枠なし。同時セッション数は Tier 1 で 25、Tier 5 で 500

### delegation の 2 モード

モード | 設定 | 誰がツールを実行するか
:--|:--|:--
`responses` | `delegation.responses.{model,instructions,tools,tool_choice,...}` | OpenAI 側が設定済みモデルを呼ぶ。function call が自分に飛んでくるので実行して結果を返す
`client` | `delegation: { type: 'client' }` | 自前。`session.delegation.created` を受けて、自分のエージェント/API を叩き、結果を `session.commentary.append` で返す

`responses` の場合、バックエンドモデルは `gpt-5.6-terra` / `gpt-5.6-luna` を指定する例が出ている。

**このプロジェクトでは `responses` を推奨**。現行の `src/tools/` 方式 (definition + handler) が
`delegation.responses.tools` にそのまま載り、function call → 実行 → 結果返却 の流れも
Realtime とほぼ同型のため、移植コストが最小になる。

`client` は「どのバックエンドを叩くか自分で決めたい」「結果を検証・マスクしてから返したい」
場合の選択肢。ただし発話テキストが delegation イベントに含まれず、
`session.input_transcript.delta` を自前で蓄積して意図を判断する必要があるため実装量が増える。

---

## 2. 接続とプロトコル

### エンドポイント

```
wss://api.openai.com/v1/live/sessions
```

ヘッダー: `Authorization: Bearer $OPENAI_API_KEY` (+ `User-Agent`)
`?model=` のクエリは使わず、**モデルは `session.start` の中で指定する**。

サイドバンド接続 (既存セッションにサーバーから後付けで繋ぐ) は
`wss://api.openai.com/v1/live/sessions/{session_id}/attach`。
WebRTC / SIP で音声を張った上でサーバーがイベントだけ見る用途。今回は不要。

### 最初に送るイベント (`session.start`)

```json
{
  "type": "session.start",
  "event_id": "event_start",
  "session": {
    "model": "gpt-live-1",
    "instructions": "会話スタイルの指示",
    "audio": {
      "format": { "type": "audio/pcm", "rate": 24000 },
      "output": { "voice": "marin" }
    },
    "delegation": {
      "type": "responses",
      "responses": {
        "model": "gpt-5.6-luna",
        "instructions": "業務ルールとツールの使い方",
        "tools": [{ "type": "web_search" }],
        "tool_choice": "auto"
      }
    }
  }
}
```

`delegation.responses` で指定できるもの:
`model` / `instructions` / `tools` / `tool_choice` / `parallel_tool_calls` /
`max_output_tokens` (最小 16) / `service_tier` / `reasoning`

### 音声フォーマット

`session.audio.format` は **入出力共通で 1 つだけ**。セッション途中で変更不可。

- `{"type":"audio/pcm","rate":24000}` — 既定
- `{"type":"audio/pcm","rate":16000}`
- `{"type":"audio/pcmu","rate":8000}` — G.711 μ-law
- `{"type":"audio/pcma","rate":8000}` — G.711 A-law

音声は WAV ヘッダ無しの生バイトを base64 で送る。PCM は 16bit 単位で切れていること (偶数バイト)。

### イベント名 (Realtime との対応)

Realtime API | GPT-Live
:--|:--
`input_audio_buffer.append` | `session.input_audio.append`
`response.output_audio.delta` | `session.output_audio.delta`
`conversation.item.input_audio_transcription.delta` | `session.input_transcript.delta`
`response.output_audio_transcript.delta` | `session.output_transcript.delta`
`response.output_item.done` (function call) | `response.event` → 内側の `response.output_item.done`
`conversation.item.create` (ツール結果) | `response.item.create`
`session.update` (初回) | `session.start`
`session.created` / `session.updated` | `session.started` / `session.updated`

その他のイベント:

- クライアント → `session.update` / `session.close` / `session.input_audio.mute` / `session.input_audio.unmute` /
  `session.instructions.append` / `session.thinking.append` / `session.commentary.append` /
  `response.item.create` / `response.create`
- サーバー → `session.started` / `session.updated` / `session.closed` / `session.output_audio.delta` /
  `session.input_transcript.delta` / `session.output_transcript.delta` / `session.delegation.created` /
  `response.event` / `session.usage.updated` / `session.input_audio.muted` / `session.input_audio.unmuted` /
  `session.instructions.appended` / `session.thinking.appended` / `session.commentary.appended` / `error`

**無くなったもの** (ここが設計上いちばん効く):

- `input_audio_buffer.commit` / `response.create` による**ターン制御が無い**。音声は流しっぱなしで、
  いつ話すかは GPT-Live が決める
- `input_audio_buffer.speech_started` に相当する「ユーザーが話し始めた」イベントが**無い**
- `conversation.item.truncate` が**無い**
- `response.output_audio.done` / `response.done` が**無い**。
  発話の終端を示すイベントは存在しないので、再生状態は自前で管理する
- `session.output_audio.delta` に**タイムスタンプが無い**

### 文字起こし

`session.input_transcript.delta` / `session.output_transcript.delta` が自動で届く。
Realtime の `input_audio_transcription.model` のような有効化設定は見当たらない
(= 文字起こしモデルの env は不要になる可能性が高い)。
各 delta は `delta` / `start_ms` / `end_ms` を持つ。セッション開始からのミリ秒で、
**話者間で区間が重なりうる** (full-duplex なので当然)。

### Function Calling (responses delegation)

```js
// 受信
{
  type: 'response.event',
  delegation_id: 'item_...',
  event: {
    type: 'response.output_item.done',
    item: { type: 'function_call', status: 'completed', call_id, name, arguments }
  }
}

// 返却 (2 通送る。item.create だけでは応答が再開しない)
{ type: 'response.item.create', item: { type: 'function_call_output', call_id, output: '<JSON文字列>' } }
{ type: 'response.create' }
```

保留中の tool call が複数あるなら**全部返してから** `response.create` すること。

### 終了と課金

- `session.close` → `session.closed` (`reason`, `usage.seconds`)。
  `reason` は `close_requested` / `expired` / `content` / `remote_hangup` / `connection_lost`
- `session.usage.updated` が `usage.seconds` と `context_window.usage_ratio` のスナップショットを返す (加算値ではない)
- `session.closed` を受け取るまで WebSocket を閉じないこと。閉じると最終 usage が確定しない

---

## 3. 現行プロジェクト (websocket-openai) との差分

### そのまま使える

- `index.js` / `src/config.js` / `src/server.js` の骨格
- `src/routes/` 全部 (`/answer` の NCCO、`/event`、`/connect`、`/media-stream` の口)
- `src/vonage/` (JWT、発信・転送)
- `src/tools/` のレジストリ方式 (definition + handler)。定義の置き場所が
  `session.tools` → `delegation.responses.tools` に変わるだけ
- `APP_ROLE=front` (VCR) / `full` (Fly.io) の 2 段構成。
  これは Vonage の `answer_url` 5 秒制限に対する対策なので Live API とは無関係、そのまま維持
- `scripts/change-url.js`、`vcr.yml`、`fly.toml`、Dockerfile、テスト基盤 (tap)

### 削れる

- **`src/audio/resample.js` が丸ごと不要になる見込み**。
  Vonage は `audio/l16;rate=16000`、GPT-Live も `audio/pcm` の 16000 を受け付けるので
  **リサンプリング無しで直結できる**。現行の 16k↔24k 変換は消える。
  (`FrameSplitter` は Vonage への送出を 20ms = 640 バイト単位に揃えるために残す価値あり。
  Vonage は 20ms フレームを期待している)
- `OPENAI_TRANSCRIPTION_MODEL` の設定 (文字起こしが常時オンのため)

### 作り直しが必要

`src/realtime/` → `src/live/` 相当。書き換え量が多いのはここだけ。

1. **セッション生成** — `session.update` → `session.start`。
   スキーマが `output_modalities` / `audio.input.*` / `audio.output.*` / `tools` から
   `audio.format` / `audio.output.voice` / `delegation.responses.*` に変わる
2. **初回挨拶** — 現行は `session.updated` を待って `response.create` を投げている。
   GPT-Live には `response.create` によるターン起動が無く、`opening` のような
   専用フィールドも無い。公式の手順は 2 段階。

   1. `session.started` の後に `session.instructions.append` (`delegation_id: null`) で
      「この文言で先に話しかけ、その後は聞く」と指示する
   2. `session.instructions.appended` の `client_event_id` を突き合わせてから
      `session.commentary.append` で「今すぐ会話を始めて」と促す

   **1 だけでは話し始めない。** 相手が話しかけてくるまで黙ったままになる
   (実機で確認済み。指示自体は効いていて、こちらが「こんにちは」と言った直後に
   指定どおりの文言を読み上げた)
3. **割り込み処理** — 現行の肝 (`speech_started` → `conversation.item.truncate` +
   Vonage へ `{"action":"clear"}` + 送出済み ms の管理) が**全部使えない**。
   GPT-Live は割り込みをモデル側で処理する前提。
   → **未解決の論点。下記 4. を参照**
4. **ツール実行** — イベントが `response.event` の入れ子になり、
   結果返却が `conversation.item.create` → `response.item.create` + `response.create` になる。
   `transfer_call` の `skipResponseOnSuccess` はそのまま活かせる (= `response.create` を送らない)

---

## 4. 未解決 / 実機で確かめること

> **2026-09-12 追記** — 実機の通話 (121 秒) で 1〜3 は解決した。
>
> 1. 音声は**実時間で届く** (`ratio` 0.96)。割り込み時の破棄処理は不要
> 2. voice は `marin` で動作
> 3. `audio/pcm` の **16000 Hz は受理される**。リサンプリング不要
> 4. 委譲 1 回あたり約 24 秒かかっていたため、`service_tier: 'priority'` と
>    `reasoning.effort: 'low'` を既定にした (効果は次の通話で確認する)
> 5. コストは音声 $0.05/分 (121 秒で $0.10) + Vonage $0.03 の計 20 円前後
> 6. Node SDK は使わず `ws` を直接叩いて問題なく動いている

1. **Vonage 側の再生バッファをどうするか**
   Realtime API は実時間より速く音声を返してきたため、Vonage 側にバッファが溜まり、
   割り込み時に `{"action":"clear"}` で捨てる必要があった。
   GPT-Live が実時間ペースで `session.output_audio.delta` を返すなら、この処理自体が不要になる。
   ドキュメントに記述が無いので**実測が必要**。
   速く返ってくる場合、割り込み検知の代替が `session.input_transcript.delta` の到着しか無く、
   full-duplex の相槌と区別できないため、clear の判断が難しい
2. **利用できる voice の一覧**。ドキュメントの例には `marin` が出てくる。
   Realtime の `alloy` 系がそのまま使えるかは未確認
3. **`audio/pcm` 16000 が本当に受理されるか** (ドキュメント上は可)。
   駄目なら 24000 に揃えて現行のリサンプラを残す
4. **バックエンドモデルの選定**。`gpt-5.6-terra` / `gpt-5.6-luna` の
   速度・コスト差。電話は遅延がそのまま体験に響くので `service_tier: 'priority'` の要否も含めて検討
5. **コスト比較**。$0.05/分 + バックエンドのトークン課金 が、現行の gpt-realtime 比でどうなるか
6. **Node SDK の対応状況**。`openai` パッケージに Live 用クライアントがあるか。
   無ければ現行どおり `ws` を直接使う (Twilio の公式サンプルも生 `ws`)

---

## 5. 参考: Twilio 公式サンプルの実装形

同じ「電話の音声 WebSocket ⇔ GPT-Live」構成。8kHz μ-law をそのまま素通ししている。

```js
const openAiWs = new WebSocket('wss://api.openai.com/v1/live/sessions', {
  headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'User-Agent': USER_AGENT }
});

send({ type: 'session.start', session: {
  model: MODEL,
  instructions: VOICE_PROMPT,
  audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: VOICE } },
  delegation: { type: 'responses', responses: { model: DELEGATED_MODEL, instructions: BACKEND_PROMPT, tools: TOOLS } }
} });

// 上り: Twilio の media をそのまま append
send({ type: 'session.input_audio.append', audio: data.media.payload });

// 下り: delta をそのまま media で返す
connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
```

**割り込み時の clear 処理は一切書かれていない。** Vonage 版でも同様に省けるかは要検証 (4-1)。

パートナー統合が用意されているのは LiveKit / Twilio / Telnyx / Daily(Pipecat) で、
**Vonage は現時点で一覧に無い**。自前でブリッジを書く前提。

---

## 6. 参考リンク

- [Getting started with GPT-Live](https://developers.openai.com/api/docs/guides/live)
- [WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live)
- [Delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [Conversations](https://developers.openai.com/api/docs/guides/live-conversations)
- [Prompting](https://developers.openai.com/api/docs/guides/live-prompting)
- [Migrate to GPT-Live](https://developers.openai.com/api/docs/guides/live-migration)
- [Server-side controls](https://developers.openai.com/api/docs/guides/voice-server-controls?api=live)
- [Telephony and SIP](https://developers.openai.com/api/docs/guides/voice-sip?api=live)
- [Latency and cost](https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live)
- [gpt-live-1 model](https://developers.openai.com/api/docs/models/gpt-live-1)
- [Vonage Voice API WebSockets](https://developer.vonage.com/en/voice/voice-api/concepts/websockets)
- [Twilio の Node.js 実装例](https://www.twilio.com/en-us/blog/developers/tutorials/integrations/voice-ai-assistant-openai-gpt-live-1-node)
