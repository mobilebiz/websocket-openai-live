/**
 * GPT-Live のセッション設定を組み立てる。
 *
 * Realtime API の `session.update` と違い、GPT-Live は接続後の 1 通目に
 * `session.start` を送る。モデル名もこのペイロードで指定する (URL のクエリではない)。
 * 音声フォーマットは入出力共通で 1 つだけで、セッション途中では変更できない。
 */

import { toolDefinitions } from '../tools/index.js';

/** E.164 らしき番号だけを通し、それ以外は unknown 扱いにする */
const sanitizeNumber = (value) =>
  /^\+?[0-9]{5,15}$/.test(String(value ?? '')) ? String(value) : 'unknown';

/**
 * 通話固有の情報を会話側の指示に足す。
 *
 * Vonage の webhook は通話の向きに関わらず from=発信側 / to=着信側で届く。
 * こちらから架けた場合は発信側がこちらになるため、役割を入れ替える。
 *
 * @param {string} systemMessage
 * @param {{ caller: string, called: string, direction?: string }} call
 */
export const buildInstructions = (systemMessage, { caller, called, direction = 'inbound' }) => {
  const isOutbound = direction === 'outbound';
  const otherParty = sanitizeNumber(isOutbound ? called : caller);
  const ourNumber = sanitizeNumber(isOutbound ? caller : called);

  return [
    systemMessage,
    '',
    '電話番号情報:',
    `- 通話相手の電話番号: ${otherParty}`,
    `- こちら側の電話番号: ${ourNumber}`,
    '電話番号を聞かれた場合、先頭が81から始まる番号であれば、それを0に置き換えて、日本のローカル番号として回答してください。'
  ].join('\n');
};

/**
 * `session.start` のペイロードを組み立てる。
 *
 * @param {object} config loadConfig() の戻り値
 * @param {{ caller: string, called: string, direction?: string }} call
 */
export const buildSessionStart = (config, call) => ({
  type: 'session.start',
  event_id: 'session_start',
  session: {
    model: config.openai.model,
    // 会話スタイルだけをここに書く。業務ルールは delegation 側に持たせる
    instructions: buildInstructions(config.systemMessage, call),
    audio: {
      format: { type: 'audio/pcm', rate: config.audioRate },
      output: { voice: config.openai.voice }
    },
    delegation: {
      type: 'responses',
      responses: {
        model: config.openai.backendModel,
        instructions: config.backendMessage,
        // ツールを呼ぶのは音声モデルではなくこのバックエンドなので、
        // 定義は session.tools ではなくここに載せる
        ...(toolDefinitions.length > 0 ? { tools: toolDefinitions } : {}),
        tool_choice: 'auto',
        // 委譲した処理の応答速度に効く設定。
        // 電話では待たされた数秒がそのまま体験に響くので既定を遅延寄りにしている
        ...(config.openai.serviceTier ? { service_tier: config.openai.serviceTier } : {}),
        ...(config.openai.reasoningEffort
          ? { reasoning: { effort: config.openai.reasoningEffort } }
          : {}),
        ...(config.openai.maxOutputTokens
          ? { max_output_tokens: config.openai.maxOutputTokens }
          : {})
      }
    }
  }
});

/** 挨拶の指示に付ける event_id。応答の `client_event_id` と突き合わせる */
export const GREETING_EVENT_ID = 'greeting';

/**
 * 最初に自分から話しかけてもらうための指示。
 *
 * GPT-Live には Realtime の `response.create` にあたるターン起動が無く、
 * いつ話すかはモデルが決める。挨拶から始めたい場合は
 * `session.started` の後に「先に話してから聞く」と指示を足す。
 *
 * これだけでは話し始めない。`session.instructions.appended` を待ってから
 * buildGreetingCue() を送るところまでが 1 セット。
 *
 * @param {string} [text] 読み上げてほしい挨拶
 */
export const buildGreeting = (
  text = 'こんにちは。チャッピーです。今日はどのようなお話をしましょうか？'
) => ({
  type: 'session.instructions.append',
  event_id: GREETING_EVENT_ID,
  delegation_id: null,
  content: [
    '日本語で話してください。',
    `相手が話し始める前に、まず次の文章をそのまま読み上げてください: 「${text}」`,
    'その後は相手の発話を聞いてください。'
  ].join('\n')
});

/**
 * 挨拶の指示を受け取ったモデルに、実際に話し始めてもらう合図。
 *
 * 指示を足しただけでは相手が話しかけてくるまで黙ったままになる。
 * `session.instructions.appended` を受けてからこれを送ると口火を切る。
 */
export const buildGreetingCue = () => ({
  type: 'session.commentary.append',
  event_id: 'greeting_cue',
  delegation_id: null,
  content: '指示のとおり、今すぐ会話を始めてください。'
});
