import WebSocket from 'ws';

import { FRAME_MS, FrameSplitter, frameBytes } from '../audio/frames.js';
import { executeTool } from '../tools/index.js';
import {
  GREETING_EVENT_ID,
  buildGreeting,
  buildGreetingCue,
  buildSessionStart
} from './session.js';

const LIVE_URL = 'wss://api.openai.com/v1/live/sessions';

/** `session.close` を投げてから `session.closed` を待つ上限 */
const CLOSE_GRACE_MS = 2_000;

/** 文字起こしの断片をまとめてログに出すまでの無音時間 */
const TRANSCRIPT_IDLE_MS = 800;

/**
 * 話者ごとに文字起こしの断片を溜めて、途切れたところでまとめて出す。
 * GPT-Live の transcript は delta のみで「発話が終わった」イベントが無いため、
 * 無音時間で区切る。
 *
 * @param {import('fastify').FastifyBaseLogger} log
 * @param {string} label
 */
const createTranscriptLogger = (log, label) => {
  let text = '';
  let timer = null;

  const flush = () => {
    timer = null;
    if (!text) return;
    log.info({ transcript: text }, label);
    text = '';
  };

  return {
    push(delta) {
      if (!delta) return;
      text += delta;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, TRANSCRIPT_IDLE_MS);
    },
    stop() {
      if (timer) clearTimeout(timer);
      flush();
    }
  };
};

/**
 * Vonage のメディアストリームと OpenAI Live API (GPT-Live) を 1 通話ぶん中継する。
 *
 * 状態はすべてこの関数のスコープに閉じているので、
 * 同時に複数の通話が走っても互いに干渉しない。
 *
 * @param {object} params
 * @param {object} params.config loadConfig() の戻り値
 * @param {import('ws').WebSocket} params.connection Vonage 側の WebSocket
 * @param {{ caller: string, called: string, uuid: string, direction: string }} params.call
 * @param {import('fastify').FastifyBaseLogger} params.log
 * @param {() => number} [params.now] 現在時刻 (テストから差し替えるため)
 */
export const createBridge = ({ config, connection, call, log, now = () => Date.now() }) => {
  // ---- 通話ごとの状態 -------------------------------------------------
  let sessionReady = false;
  let closing = false;
  let closeTimer = null;

  /** 受け取った音声の合計再生時間 (ms)。ペース計測用 */
  let receivedAudioMs = 0;
  /** 最初の音声が届いた時刻。ペース計測用 */
  let firstAudioAt = 0;

  /** 直近のユーザー発話の終わり (セッション開始からの ms)。応答までの間の計測用 */
  let lastUserEndMs = 0;
  /** ユーザーが話し終えてから、まだアシスタントが話し始めていない */
  let awaitingReply = false;

  /** 実行中のツールの本数。全部返し終えてから応答を再開させる */
  let runningTools = 0;
  /** 応答の再開を抑止する (転送のように通話が離れる操作のとき) */
  let skipResponseAfterTools = false;

  const VONAGE_FRAME_BYTES = frameBytes(config.audioRate);
  // GPT-Live は可変長で音声を返してくるので、Vonage が期待する 20ms フレームに切り直す
  const outbound = new FrameSplitter(VONAGE_FRAME_BYTES);

  const userTranscript = createTranscriptLogger(log, '🗣️ ユーザー');
  const assistantTranscript = createTranscriptLogger(log, '🤖 アシスタント');

  const liveWs = new WebSocket(LIVE_URL, {
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      'User-Agent': 'websocket-openai-live'
    }
  });

  const sendToLive = (payload) => {
    if (liveWs.readyState === WebSocket.OPEN) {
      liveWs.send(JSON.stringify(payload));
    }
  };

  const sendToVonage = (payload) => {
    if (connection.readyState === WebSocket.OPEN) {
      connection.send(payload);
    }
  };

  /**
   * GPT-Live 側を閉じる。
   *
   * `session.closed` を受け取るまでは最終的な利用秒数が確定しないので、
   * まず `session.close` を送って待つ。返ってこなければ強制的に切る。
   * CONNECTING のまま放置すると通話終了後に接続だけ生き残るため、
   * CLOSED / CLOSING 以外はすべて閉じにいく。
   */
  const closeLive = () => {
    if (closing) return;
    closing = true;

    if (liveWs.readyState === WebSocket.OPEN) {
      sendToLive({ type: 'session.close', event_id: 'close' });
      closeTimer = setTimeout(() => {
        log.warn('session.closed が届かないまま切断します');
        liveWs.close();
      }, CLOSE_GRACE_MS);
      return;
    }

    if (liveWs.readyState !== WebSocket.CLOSED) liveWs.close();
  };

  /**
   * 受け取った音声が実時間に対してどれくらい速いかを記録する。
   *
   * Realtime API は実時間より速く音声を返してきたため Vonage 側にバッファが溜まり、
   * 割り込み時に捨てる仕組みが必要だった。GPT-Live がどちらなのかは
   * ドキュメントに記載が無いので、実測できるようにログに残す。
   */
  const logAudioPace = () => {
    if (!firstAudioAt || receivedAudioMs === 0) return;
    const elapsedMs = Math.max(1, now() - firstAudioAt);
    log.info(
      {
        receivedAudioMs,
        elapsedMs,
        ratio: Number((receivedAudioMs / elapsedMs).toFixed(2))
      },
      '音声の到着ペース (1.0 なら実時間。大きいほど先行して届いている)'
    );
  };

  /**
   * ツールを実行し、結果を返して応答を再開させる。
   *
   * ツールを呼ぶのは音声モデルではなくバックエンド (responses) なので、
   * 呼び出しは `response.event` の入れ子で届く。結果を積む (`response.item.create`) だけでは
   * 応答は再開せず、`response.create` を別途送る必要がある。
   *
   * 保留中のツール結果は「全部」返してから再開させる決まりなので、実行中の本数を数え、
   * 最後の 1 本が終わったときだけ再開させる。
   *
   * @param {{ call_id: string, name: string, arguments: string }} item
   */
  const runTool = async (item) => {
    runningTools += 1;

    try {
      const { output, skipResponse } = await executeTool(item.name, item.arguments, {
        config,
        callUuid: call.uuid,
        log
      });

      log.info({ tool: item.name, output }, 'ツールを実行しました');
      // 転送のように通話自体が離れる操作では追加の応答を求めない
      if (skipResponse) skipResponseAfterTools = true;

      sendToLive({
        type: 'response.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(output)
        }
      });
    } catch (error) {
      log.error({ err: error, tool: item.name }, 'ツール結果の返却に失敗しました');
    } finally {
      runningTools -= 1;
      if (runningTools === 0) {
        if (!skipResponseAfterTools) sendToLive({ type: 'response.create' });
        skipResponseAfterTools = false;
      }
    }
  };

  // ---- GPT-Live 接続 --------------------------------------------------
  liveWs.on('open', () => {
    log.info('OpenAI Live API に接続しました');
    sendToLive(buildSessionStart(config, call));
  });

  liveWs.on('message', (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch (error) {
      log.error({ err: error }, 'GPT-Live からのメッセージを解析できませんでした');
      return;
    }

    switch (event.type) {
      // セッションが確立したら音声の送出を始め、こちらから挨拶させる
      case 'session.started': {
        sessionReady = true;
        log.info({ sessionId: event.session?.id }, 'セッションが開始しました');
        sendToLive(buildGreeting());
        break;
      }

      // 挨拶の指示が反映されたので、実際に話し始めてもらう。
      // 指示を足しただけでは相手が話しかけてくるまで黙ったままになる
      case 'session.instructions.appended': {
        if (event.client_event_id === GREETING_EVENT_ID) {
          log.info('挨拶の指示が反映されたので、話し始めるよう促します');
          sendToLive(buildGreetingCue());
        } else {
          log.debug({ event }, '指示が反映されました');
        }
        break;
      }

      case 'session.commentary.appended': {
        log.debug({ event }, 'コメンタリが反映されました');
        break;
      }

      case 'session.output_audio.delta': {
        if (!event.delta) break;

        const chunk = Buffer.from(event.delta, 'base64');
        if (!firstAudioAt) firstAudioAt = now();

        // 端数は FrameSplitter が保持するので音が欠けない
        for (const frame of outbound.push(chunk)) {
          sendToVonage(frame);
          receivedAudioMs += FRAME_MS;
        }
        break;
      }

      case 'session.input_transcript.delta': {
        userTranscript.push(event.delta);
        if (typeof event.end_ms === 'number') {
          lastUserEndMs = Math.max(lastUserEndMs, event.end_ms);
          awaitingReply = true;
        }
        break;
      }

      case 'session.output_transcript.delta': {
        assistantTranscript.push(event.delta);

        // ユーザーが話し終えてから話し始めるまでの間。
        // start_ms / end_ms はどちらもセッションのタイムラインなので、
        // ここで出る値は電話・Vonage・Fly.io の経路を含まない「モデル側の間」になる。
        // 体感との差がそのまま伝送の遅延にあたる。
        // full-duplex なので、相槌のように被せて話し始めると負の値になる
        if (awaitingReply && typeof event.start_ms === 'number') {
          awaitingReply = false;
          log.info({ gapMs: event.start_ms - lastUserEndMs }, '⏱️ 応答までの間');
        }
        break;
      }

      // バックエンドへの委譲が始まった。ツールを足すまではログのみ
      case 'session.delegation.created': {
        log.info({ delegation: event.delegation }, 'バックエンドに委譲しました');
        break;
      }

      // バックエンド (responses) のイベントは入れ子で届く
      case 'response.event': {
        const inner = event.event ?? {};
        if (
          inner.type === 'response.output_item.done' &&
          inner.item?.type === 'function_call' &&
          inner.item.status === 'completed'
        ) {
          runTool(inner.item);
          break;
        }
        log.debug({ inner: inner.type }, 'バックエンドのイベント');
        break;
      }

      case 'session.usage.updated': {
        log.debug(
          { seconds: event.usage?.seconds, contextRatio: event.context_window?.usage_ratio },
          '利用状況'
        );
        break;
      }

      case 'session.closed': {
        log.info(
          { reason: event.reason, seconds: event.usage?.seconds },
          'セッションが終了しました'
        );
        if (closeTimer) clearTimeout(closeTimer);
        liveWs.close();
        break;
      }

      case 'error': {
        log.error({ error: event.error, clientEventId: event.client_event_id }, 'GPT-Live エラー');
        break;
      }

      default:
        log.debug({ type: event.type }, '未処理のイベント');
        break;
    }
  });

  liveWs.on('error', (error) => {
    log.error({ err: error }, '👺 GPT-Live WebSocket エラー');
  });

  liveWs.on('close', (code, reason) => {
    sessionReady = false;
    if (closeTimer) clearTimeout(closeTimer);
    userTranscript.stop();
    assistantTranscript.stop();
    logAudioPace();
    log.info({ code, reason: reason?.toString() }, 'GPT-Live から切断されました');
    if (connection.readyState === WebSocket.OPEN) connection.close();
  });

  // ---- Vonage 接続 ----------------------------------------------------
  connection.on('message', (data, isBinary) => {
    // 制御メッセージはテキストフレームで届く
    if (!isBinary) {
      try {
        log.info({ event: JSON.parse(data.toString()) }, 'Vonage からの制御メッセージ');
      } catch {
        log.debug({ raw: data.toString() }, 'Vonage からの解析できないテキスト');
      }
      return;
    }

    if (!sessionReady) return;

    // Vonage も GPT-Live も同じレートの PCM16LE なので、そのまま base64 にして流す。
    // GPT-Live 側にターン制御は無く、音声は流しっぱなしでよい
    sendToLive({ type: 'session.input_audio.append', audio: data.toString('base64') });
  });

  connection.on('close', () => {
    log.info('Vonage 側の接続が切断されました');
    closeLive();
  });

  connection.on('error', (error) => {
    log.error({ err: error }, '👺 Vonage WebSocket エラー');
  });

  return { close: closeLive };
};
