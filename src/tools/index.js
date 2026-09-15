import * as getWeather from './get-weather.js';

/**
 * 利用可能なツール。ここに 1 行足すだけで
 * delegation.responses.tools への送信と実行の振り分けの両方に反映される。
 */
const MODULES = [getWeather];

const REGISTRY = new Map(MODULES.map((module) => [module.definition.name, module]));

/** delegation.responses.tools にそのまま載せられるツール定義の配列 */
export const toolDefinitions = MODULES.map((module) => module.definition);

/**
 * ツールを実行し、function_call_output にそのまま載せられる結果を返す。
 * ハンドラ内の例外はここで握り、モデルに伝わる形へ変換する。
 *
 * @param {string} name ツール名
 * @param {string} rawArguments OpenAI から届く JSON 文字列
 * @param {{ config: object, callUuid: string, log: import('fastify').FastifyBaseLogger }} context
 * @returns {Promise<{ output: unknown, skipResponse: boolean }>}
 */
export const executeTool = async (name, rawArguments, context) => {
  const module = REGISTRY.get(name);
  if (!module) {
    context.log.warn({ name }, '未知のツールが呼び出されました');
    return { output: { error: `未知のツール ${name} です。` }, skipResponse: false };
  }

  let args;
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
  } catch (error) {
    context.log.error({ name, err: error }, 'ツール引数の JSON を解析できませんでした');
    return { output: { error: 'ツールの引数を解析できませんでした。' }, skipResponse: false };
  }

  try {
    const output = await module.handler(args, context);
    const succeeded = !(output && typeof output === 'object' && 'error' in output);
    return {
      output,
      skipResponse: Boolean(module.skipResponseOnSuccess) && succeeded
    };
  } catch (error) {
    context.log.error({ name, err: error }, 'ツールの実行に失敗しました');
    return {
      output: { error: `${name} の実行に失敗しました: ${error.message}` },
      skipResponse: false
    };
  }
};
