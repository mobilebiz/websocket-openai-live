const CURRENT_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';

/** 予報 API がカバーする日数 (3 時間刻みで 5 日ぶん) */
const MAX_DAYS_AHEAD = 4;

/**
 * delegation.responses.tools にそのまま載せる定義 (Responses API の形式)。
 *
 * strict: true にしているので、
 * - parameters の object には additionalProperties: false が必要
 * - properties は全部 required に入れる
 * - 任意の引数は型に null を足して表現する (ここでは days_ahead)
 * を満たしていること。minimum / maximum のような制約は使わず、値の検証はハンドラ側で行う。
 */
export const definition = {
  type: 'function',
  name: 'get_weather',
  description:
    '指定された場所の天気を取得します。今日の実況と、4日先までの予報に対応しています。',
  parameters: {
    type: 'object',
    properties: {
      location: {
        type: 'string',
        description: '都道府県名, e.g. 東京都,大阪,北海道'
      },
      days_ahead: {
        type: ['integer', 'null'],
        description:
          '何日先の天気か。0 または未指定で今日、1 で明日、2 であさって。4 まで指定できます。'
      }
    },
    required: ['location', 'days_ahead'],
    additionalProperties: false
  },
  strict: true
};

/** 読み上げたときに分かりやすい呼び方にする */
const dayLabel = (daysAhead) =>
  ({ 0: '今日', 1: '明日', 2: 'あさって' })[daysAhead] ?? `${daysAhead}日後`;

/** UNIX 時刻を現地時間の YYYY-MM-DD にする */
const localDate = (unixSeconds, offsetSeconds) =>
  new Date((unixSeconds + offsetSeconds) * 1000).toISOString().slice(0, 10);

/** YYYY-MM-DD に日数を足す */
const addDays = (isoDate, days) => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * OpenWeatherMap を叩くための URL を組み立てる。
 * @param {string} base
 * @param {string} location
 * @param {string} apiKey
 */
const buildUrl = (base, location, apiKey) => {
  const url = new URL(base);
  url.searchParams.set('q', `${location},JP`); // 国コードを付けて検索精度を上げる
  url.searchParams.set('appid', apiKey);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('lang', 'ja');
  return url;
};

/**
 * レスポンスの異常を、そのまま読み上げられるメッセージに変換する。
 * @param {Response} response
 * @param {string} location
 * @param {import('fastify').FastifyBaseLogger} log
 */
const toError = (response, location, log) => {
  if (response.status === 404) {
    return {
      error: `${location} の天気情報が見つかりませんでした。正しい都道府県名を指定してください。`
    };
  }
  log.error({ status: response.status }, '天気情報の取得に失敗しました');
  return { error: `天気情報の取得に失敗しました (${response.status})。` };
};

/** 今日の実況を取る */
const fetchCurrent = async (location, apiKey, log) => {
  const response = await fetch(buildUrl(CURRENT_URL, location, apiKey));
  if (!response.ok) return toError(response, location, log);

  const data = await response.json();
  const date = localDate(data.dt, data.timezone ?? 0);

  return {
    summary:
      `${location}の${date}の天気は${data.weather[0].description}、` +
      `現在の気温は${data.main.temp}℃（最低${data.main.temp_min}℃〜最高${data.main.temp_max}℃）、` +
      `湿度${data.main.humidity}%、風速${data.wind.speed}m/sです。`
  };
};

/**
 * 指定日の予報を取る。
 *
 * 予報は 3 時間刻みで届くので、その日のぶんだけ抜き出して
 * 最低・最高気温にまとめ、代表の天気には正午に最も近い時刻のものを使う。
 */
const fetchForecast = async (location, apiKey, daysAhead, log) => {
  const response = await fetch(buildUrl(FORECAST_URL, location, apiKey));
  if (!response.ok) return toError(response, location, log);

  const data = await response.json();
  const offset = data.city?.timezone ?? 0;
  const target = addDays(localDate(Math.floor(Date.now() / 1000), offset), daysAhead);

  const entries = (data.list ?? []).filter((entry) => localDate(entry.dt, offset) === target);

  if (entries.length === 0) {
    return {
      error: `${location}の${dayLabel(daysAhead)}（${target}）の予報は取得できませんでした。予報は${MAX_DAYS_AHEAD}日先までです。`
    };
  }

  const temps = entries.map((entry) => entry.main.temp);
  const noon = entries.reduce((best, entry) => {
    const hour = (entry.dt + offset) % 86400;
    return Math.abs(hour - 43200) < Math.abs(((best.dt + offset) % 86400) - 43200) ? entry : best;
  });

  return {
    summary:
      `${location}の${dayLabel(daysAhead)}（${target}）の天気は${noon.weather[0].description}、` +
      `気温は最低${Math.round(Math.min(...temps))}℃〜最高${Math.round(Math.max(...temps))}℃、` +
      `湿度${noon.main.humidity}%、風速${noon.wind.speed}m/sの見込みです。`
  };
};

/**
 * 天気を取得して読み上げやすい文章にする。
 * @param {{ location: string, days_ahead?: number | null }} args
 * @param {{ config: object, log: import('fastify').FastifyBaseLogger }} context
 */
export const handler = async ({ location, days_ahead: daysAhead }, { config, log }) => {
  const apiKey = config.openWeatherApiKey;
  if (!apiKey) {
    return { error: 'OpenWeatherMap の API キー (OPEN_WEATHER_API_KEY) が設定されていません。' };
  }

  // strict でも値の範囲までは縛れないので、ここで丸める
  const days = Number.isInteger(daysAhead) ? daysAhead : 0;
  if (days < 0 || days > MAX_DAYS_AHEAD) {
    return { error: `天気は今日から${MAX_DAYS_AHEAD}日先までしか取得できません。` };
  }

  return days === 0
    ? fetchCurrent(location, apiKey, log)
    : fetchForecast(location, apiKey, days, log);
};
