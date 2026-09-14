#!/usr/bin/env node

/**
 * デプロイ直後のマシンを起こしておく。
 *
 * `fly deploy` の直後、マシンは stopped 状態になっている。
 * この状態からの初回リクエストは実測 約 7.5 秒かかり、
 * Vonage の answer_url のタイムアウト (5 秒・上限も 5,000ms で延長不可) に
 * 間に合わず着信が切断される。
 *
 * 一度リクエストを通しておけば、以降のアイドルでは fly.toml の
 * `auto_stop_machines = 'suspend'` が効いて suspended 状態で止まる。
 * suspended からの復帰は実測 約 0.5 秒で、5 秒に十分収まる。
 *
 * 使い方: fly deploy の後に実行する (npm run deploy がやる)
 */

import { spawnSync } from 'node:child_process';

/** stopped からの起動を待つ上限 */
const TIMEOUT_MS = 30_000;

/**
 * マシン一覧を取る。
 *
 * 手元では `fly` だが、GitHub Actions の setup-flyctl は `flyctl` の名前で
 * PATH に置く。どちらでも動くように順に試す。
 */
const readFlyStatus = () => {
  const candidates = [process.env.FLY_BINARY, 'fly', 'flyctl'].filter(Boolean);
  let lastProblem = '見つかりませんでした';

  for (const binary of candidates) {
    const result = spawnSync(binary, ['status', '--json'], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout;

    // 実行できなかった (未インストールなど) 場合は次の候補へ
    lastProblem = result.error?.message ?? result.stderr?.trim() ?? `終了コード ${result.status}`;
  }

  console.error(`fly status の取得に失敗しました (${candidates.join(' / ')}): ${lastProblem}`);
  process.exit(1);
};

let status;
try {
  status = JSON.parse(readFlyStatus());
} catch (error) {
  console.error(`fly status の JSON を解析できませんでした: ${error.message}`);
  process.exit(1);
}

const hostname = status.Hostname;
const machines = status.Machines ?? [];

if (!hostname) {
  console.error('ホスト名を取得できませんでした。');
  process.exit(1);
}

if (machines.length === 0) {
  console.error('マシンが 1 台もありません。');
  process.exit(1);
}

/**
 * 特定のマシンを名指しで起こす。
 * マシンが複数ある場合、ホスト名を叩くだけでは 1 台しか起きないため、
 * fly-force-instance-id でルーティング先を指定する。
 *
 * @param {{ id: string, state: string }} machine
 */
const warmup = async ({ id, state }) => {
  const startedAt = Date.now();
  try {
    const response = await fetch(`https://${hostname}/_/health`, {
      headers: { 'fly-force-instance-id': id },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);

    if (!response.ok) {
      console.error(`✗ ${id} (${state}) が ${response.status} を返しました (${elapsed}秒)`);
      return false;
    }

    console.log(`✓ ${id} (${state}) を起こしました (${elapsed}秒)`);
    return true;
  } catch (error) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.error(`✗ ${id} (${state}) を起こせませんでした (${elapsed}秒): ${error.message}`);
    return false;
  }
};

console.log(`${hostname} のマシン ${machines.length} 台を起こします...`);

const results = await Promise.all(machines.map(warmup));

if (results.some(Boolean)) {
  console.log('ウォームアップが完了しました。以降のアイドルは suspend になります。');
} else {
  console.error('すべてのマシンでウォームアップに失敗しました。');
  console.error('この状態で着信すると、起動が 5 秒に間に合わず切断される可能性があります。');
  process.exit(1);
}
