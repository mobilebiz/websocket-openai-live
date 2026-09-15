import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// プロジェクトルート (src/ の 1 つ上)
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Vonage と GPT-Live の両方が扱えるサンプリングレート。
 *
 * GPT-Live は `audio/pcm` の 16000 / 24000 を受け付け、フォーマットは入出力共通で 1 つだけ。
 * Vonage は `audio/l16;rate=` で 8000 / 16000 / 24000 を指定できる。
 * 同じ値に揃えておけばリサンプリングが要らない (両者とも PCM16LE モノラル)。
 *
 * 8000 は GPT-Live 側が pcm ではなく pcmu / pcma しか受け付けないため除外している。
 */
export const SUPPORTED_AUDIO_RATES = [16000, 24000];

const DEFAULT_SYSTEM_MESSAGE = [
  'あなたの名前はチャッピーです。落ち着いた物腰の電話応対のアシスタントです。',
  '常に敬語（ですます調）で話し、砕けた言い回しやタメ口は使いません。',
  '会話はすべて日本語で行います。ユーザーが言語を指定した場合はその言語で話してください。',
  '電話越しの会話なので、一度に話す量は短くまとめ、相手が話し始めたら話すのをやめてください。',
  '相槌は控えめに打ちます。',
  '天気・ニュース・調べ物など、その場で答えられない依頼はバックエンドに委譲してください。'
].join('\n');

const DEFAULT_BACKEND_MESSAGE = [
  'あなたは電話応対アシスタントの後ろで動く調査担当です。',
  '会話の相手には直接話しかけません。音声側のモデルが読み上げるための情報を簡潔に返してください。',
  '回答は事実ベースで、電話で読み上げやすい短さの敬語（ですます調）でまとめてください。'
].join('\n');

/**
 * ルート直下のテキストファイルを読む。存在しない・空なら既定値を返す。
 * @param {string} fileName
 * @param {string} fallback
 * @param {(message: string) => void} warn
 */
const loadTextFile = (fileName, fallback, warn) => {
  const file = path.join(ROOT_DIR, fileName);
  try {
    const content = fs.readFileSync(file, 'utf8').trim();
    if (content) return content;
    warn(`${fileName} が空です。既定のメッセージを使用します。`);
  } catch (error) {
    warn(`${fileName} を読み込めませんでした (${error.message})。既定のメッセージを使用します。`);
  }
  return fallback;
};

/**
 * 環境変数から設定オブジェクトを組み立てる。
 * dotenv の読み込みは呼び出し側 (index.js) の責務。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ warn?: (message: string) => void }} [options]
 */
export const loadConfig = (env = process.env, { warn = () => {} } = {}) => ({
  rootDir: ROOT_DIR,
  // VCR は待ち受けポートを VCR_PORT で指定してくる
  port: Number(env.VCR_PORT ?? env.PORT ?? 3000),
  host: env.HOST ?? '0.0.0.0',

  logLevel: env.LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'silent' : 'info'),
  // 本番では構造化ログのまま、ローカルでは pino-pretty で整形する
  prettyLogs: env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test',

  // 自分自身のホスト名。ngrok / Fly.io で払い出されるもの (プロトコルの有無はどちらでもよい)
  serverUrl: env.SERVER_URL ?? '',

  // Vonage と GPT-Live で共通のサンプリングレート
  audioRate: Number(env.AUDIO_RATE ?? 16000),

  openai: {
    apiKey: env.OPENAI_API_KEY ?? '',
    // 音声会話を担当するモデル
    model: env.OPENAI_MODEL ?? 'gpt-live-1',
    voice: env.OPENAI_VOICE ?? 'marin',
    // 推論とツールを担当するバックエンドモデル (responses delegation)
    backendModel: env.OPENAI_BACKEND_MODEL ?? 'gpt-5.6-luna',

    // ここから下は委譲した処理の応答速度に効く。会話そのものの速度は変わらない。
    // 電話は待たされた数秒がそのまま体験に響くので、既定を遅延寄りにしている

    // auto / default / flex / priority。priority が Fast mode
    serviceTier: env.OPENAI_SERVICE_TIER ?? 'priority',
    // minimal / low / medium / high。低いほど考える時間が短い
    reasoningEffort: env.OPENAI_REASONING_EFFORT ?? 'low',
    // 出力の上限 (最小 16)。空なら指定しない
    maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS ? Number(env.OPENAI_MAX_OUTPUT_TOKENS) : null
  },

  // get_weather が使う OpenWeatherMap の API キー
  openWeatherApiKey: env.OPEN_WEATHER_API_KEY ?? '',

  // 会話スタイルの指示 (session.instructions)
  systemMessage: loadTextFile('system-message.txt', DEFAULT_SYSTEM_MESSAGE, warn),
  // 業務ルールの指示 (delegation.responses.instructions)
  backendMessage: loadTextFile('backend-message.txt', DEFAULT_BACKEND_MESSAGE, warn)
});

/**
 * ホスト名を比較・組み立てできる形に揃える。
 * SERVER_URL はプロトコル付きでも省略でも受け付けるため、
 * 素朴に文字列比較すると `https://x` と `x` を別物と見なしてしまう。
 * @param {string} value
 */
export const normalizeHost = (value) =>
  String(value ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

/**
 * 起動を止めるべき設定不足を列挙する。
 * @param {ReturnType<typeof loadConfig>} config
 * @returns {string[]} 問題点のリスト (空なら問題なし)
 */
export const validateConfig = (config) => {
  const problems = [];

  if (!config.openai.apiKey) problems.push('OPENAI_API_KEY が設定されていません。');
  if (!config.openai.model) problems.push('OPENAI_MODEL が設定されていません。');

  if (!SUPPORTED_AUDIO_RATES.includes(config.audioRate)) {
    problems.push(`AUDIO_RATE は ${SUPPORTED_AUDIO_RATES.join(' か ')} のみ指定できます。`);
  }

  // 生の値ではなく正規化後で判定する。'   ' や 'https://' は真値だが
  // ホスト名としては空で、通すと wss:///media-stream を吐いてしまう
  const serverHost = normalizeHost(config.serverUrl);
  if (!serverHost) {
    problems.push('SERVER_URL が設定されていません。');
  } else if (/^http:\/\//i.test(String(config.serverUrl).trim())) {
    // Vonage の NCCO で指定できる WebSocket は wss:// のみなので、
    // ws:// を組み立てても接続できない。設定ミスとして弾く
    problems.push('SERVER_URL に http:// は指定できません。https のホスト名を指定してください。');
  }

  return problems;
};

/**
 * SERVER_URL から WebSocket URL を組み立てる。
 * @param {ReturnType<typeof loadConfig>} config
 * @param {string} pathname
 * @param {Record<string, string>} [query]
 */
export const buildWebSocketUrl = (config, pathname, query = {}) => {
  const host = normalizeHost(config.serverUrl);
  const search = new URLSearchParams(query).toString();
  return `wss://${host}${pathname}${search ? `?${search}` : ''}`;
};
