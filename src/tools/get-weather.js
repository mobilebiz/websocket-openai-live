const CURRENT_URL = 'https://api.openweathermap.org/data/2.5/weather';
const FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';

/** 予報 API がカバーする日数 (3 時間刻みで 5 日ぶん) */
const MAX_DAYS_AHEAD = 4;

/**
 * OpenWeatherMap は地名の接尾辞に厳しい。
 * 「釧路」「高知」では引けず、「釧路市」「高知県」なら引ける。
 * モデルがどちらの言い方をしてくるか分からないので、順に試す。
 */
const LOCATION_SUFFIXES = ['市', '県', '府', '都'];

/** すでに接尾辞が付いていれば補わない */
const HAS_SUFFIX = /[都道府県市区町村]$/;

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
        description:
          '市区町村名または都道府県名。ユーザーが言った地名をそのまま渡してください, e.g. 東京都, 高知県, 釧路市'
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
 * OpenWeatherMap を叩く。地名が見つからなければ接尾辞を補って retry する。
 *
 * @returns {Promise<{ data: object, name: string } | { error: string }>}
 */
const fetchWeather = async (base, location, apiKey, log) => {
  const candidates = HAS_SUFFIX.test(location)
    ? [location]
    : [location, ...LOCATION_SUFFIXES.map((suffix) => `${location}${suffix}`)];

  for (const name of candidates) {
    const url = new URL(base);
    url.searchParams.set('q', `${name},JP`); // 国コードを付けて検索精度を上げる
    url.searchParams.set('appid', apiKey);
    url.searchParams.set('units', 'metric');
    url.searchParams.set('lang', 'ja');

    const response = await fetch(url);

    if (response.ok) return { data: await response.json(), name };
    if (response.status !== 404) {
      log.error({ status: response.status, name }, '天気情報の取得に失敗しました');
      return { error: `天気情報の取得に失敗しました (${response.status})。` };
    }
  }

  return {
    error: `${location} の天気情報が見つかりませんでした。市区町村名か都道府県名を指定してください。`
  };
};

/** その日ぶんの予報エントリを抜き出す */
const entriesOfDay = (forecast, daysAhead) => {
  const offset = forecast.city?.timezone ?? 0;
  const target = addDays(localDate(Math.floor(Date.now() / 1000), offset), daysAhead);
  return {
    offset,
    target,
    entries: (forecast.list ?? []).filter((entry) => localDate(entry.dt, offset) === target)
  };
};

/** 3 時間刻みのエントリから、その日の最低・最高気温を出す */
const temperatureRange = (entries) => {
  const temps = entries.map((entry) => entry.main.temp);
  return { min: Math.round(Math.min(...temps)), max: Math.round(Math.max(...temps)) };
};

/** 正午に最も近いエントリを代表として選ぶ */
const nearestNoon = (entries, offset) =>
  entries.reduce((best, entry) =>
    Math.abs(((entry.dt + offset) % 86400) - 43200) <
    Math.abs(((best.dt + offset) % 86400) - 43200)
      ? entry
      : best
  );

/**
 * 今日の実況を取る。
 *
 * 実況 API の temp_min / temp_max は観測時点の振れ幅でしかなく、
 * その日の最低・最高気温ではない (同じ値になることが多く、読み上げると誤解を招く)。
 * 予報からその日の範囲を補って添える。
 */
const fetchCurrent = async (location, apiKey, log) => {
  const [current, forecast] = await Promise.all([
    fetchWeather(CURRENT_URL, location, apiKey, log),
    fetchWeather(FORECAST_URL, location, apiKey, log)
  ]);

  if (current.error) return current;

  const { data, name } = current;
  const date = localDate(data.dt, data.timezone ?? 0);

  let range = '';
  if (!forecast.error) {
    const { entries } = entriesOfDay(forecast.data, 0);
    if (entries.length > 0) {
      const { min, max } = temperatureRange(entries);
      range = `、この先の予想は最低${min}℃〜最高${max}℃`;
    }
  }

  return {
    summary:
      `${name}の${date}の天気は${data.weather[0].description}、` +
      `現在の気温は${data.main.temp}℃${range}、` +
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
  const forecast = await fetchWeather(FORECAST_URL, location, apiKey, log);
  if (forecast.error) return forecast;

  const { offset, target, entries } = entriesOfDay(forecast.data, daysAhead);

  if (entries.length === 0) {
    return {
      error: `${forecast.name}の${dayLabel(daysAhead)}（${target}）の予報は取得できませんでした。予報は${MAX_DAYS_AHEAD}日先までです。`
    };
  }

  const { min, max } = temperatureRange(entries);
  const noon = nearestNoon(entries, offset);

  return {
    summary:
      `${forecast.name}の${dayLabel(daysAhead)}（${target}）の天気は${noon.weather[0].description}、` +
      `気温は最低${min}℃〜最高${max}℃、` +
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

  // strict でも値の範囲までは縛れないので、ここで弾く
  const days = Number.isInteger(daysAhead) ? daysAhead : 0;
  if (days < 0 || days > MAX_DAYS_AHEAD) {
    return { error: `天気は今日から${MAX_DAYS_AHEAD}日先までしか取得できません。` };
  }

  return days === 0
    ? fetchCurrent(location, apiKey, log)
    : fetchForecast(location, apiKey, days, log);
};
