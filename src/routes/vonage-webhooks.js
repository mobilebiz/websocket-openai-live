import { buildWebSocketUrl } from '../config.js';

/**
 * Vonage から呼ばれる Webhook (/event, /answer)。
 * @type {import('fastify').FastifyPluginAsync<{ config: object }>}
 */
export default async function vonageWebhookRoutes(fastify, { config }) {
  // 通話イベントの通知先。ログに残すだけ
  fastify.all('/event', async (request, reply) => {
    request.log.info({ event: request.body }, 'Vonage イベント');
    return reply.send('OK');
  });

  // 着信に対して NCCO を返す
  fastify.all('/answer', async (request, reply) => {
    const params = { ...(request.query ?? {}), ...(request.body ?? {}) };
    const caller = params.from || 'unknown';
    const called = params.to || 'unknown';
    const uuid = params.uuid ?? '';
    const direction = params.direction === 'outbound' ? 'outbound' : 'inbound';

    request.log.info({ caller, called, uuid, direction }, '/answer が呼ばれました');

    const ncco = [
      {
        action: 'connect',
        endpoint: [
          {
            type: 'websocket',
            uri: buildWebSocketUrl(config, '/media-stream', { caller, called, uuid, direction }),
            // GPT-Live と同じレートにしておくとリサンプリングが要らない
            contentType: `audio/l16;rate=${config.audioRate}`
          }
        ]
      }
    ];

    return reply.type('application/json').send(ncco);
  });
}
