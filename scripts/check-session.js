#!/usr/bin/env node

/**
 * GPT-Live にセッションだけ張って、session.start が受理されるか確かめる。
 *
 * 電話をかけずに、モデル名・音声・音声フォーマット・ツール定義の妥当性を確認できる。
 * ツール定義に strict を足したときなど、スキーマが弾かれないかの事前確認に使う。
 *
 * 使い方:
 *   npm run check                                          # 手元の .env で確認
 *   fly ssh console -C "node /app/scripts/check-session.js" # 本番の設定で確認
 */

import dotenv from 'dotenv';
import WebSocket from 'ws';

import { loadConfig } from '../src/config.js';
import { buildSessionStart } from '../src/live/session.js';

/** 応答を待つ上限 */
const TIMEOUT_MS = 20_000;

dotenv.config({ quiet: true });

const config = loadConfig(process.env);

if (!config.openai.apiKey) {
  console.error('OPENAI_API_KEY が設定されていません。');
  process.exit(1);
}

const payload = buildSessionStart(config, {
  caller: '+819000000000',
  called: '+815000000000',
  direction: 'inbound'
});

const tools = payload.session.delegation.responses.tools ?? [];

console.log('設定を確認します...');
console.log(`  model        : ${config.openai.model}`);
console.log(`  voice        : ${config.openai.voice}`);
console.log(`  audio        : audio/pcm ${config.audioRate}Hz`);
console.log(`  backendModel : ${config.openai.backendModel}`);
console.log(`  tools        : ${tools.map((tool) => tool.name).join(', ') || 'なし'}`);

const ws = new WebSocket('wss://api.openai.com/v1/live/sessions', {
  headers: {
    Authorization: `Bearer ${config.openai.apiKey}`,
    'User-Agent': 'websocket-openai-live'
  }
});

const timer = setTimeout(() => {
  console.error('✗ 応答がありませんでした。');
  ws.close();
  process.exit(1);
}, TIMEOUT_MS);

const fail = (message) => {
  console.error(`✗ ${message}`);
  clearTimeout(timer);
  ws.close();
  process.exit(1);
};

ws.on('open', () => ws.send(JSON.stringify(payload)));

ws.on('message', (raw) => {
  let event;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return;
  }

  switch (event.type) {
    case 'session.started': {
      console.log(`✓ session.start が受理されました (session ${event.session?.id})`);
      clearTimeout(timer);
      // 課金を止めるため、確認できたらすぐ閉じる
      ws.send(JSON.stringify({ type: 'session.close', event_id: 'close' }));
      break;
    }

    case 'session.closed': {
      console.log(`✓ セッションを閉じました (${event.usage?.seconds ?? 0} 秒)`);
      ws.close();
      process.exit(0);
      break;
    }

    case 'error': {
      fail(`拒否されました: ${JSON.stringify(event.error)}`);
      break;
    }

    default:
      break;
  }
});

ws.on('error', (error) => fail(`接続に失敗しました: ${error.message}`));
