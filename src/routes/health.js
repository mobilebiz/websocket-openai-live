/**
 * 死活確認用のルート。
 * @type {import('fastify').FastifyPluginAsync}
 */
export default async function healthRoutes(fastify) {
  fastify.get('/', async () => ({ message: 'Vonage ⇔ OpenAI Live API bridge is running!' }));
  fastify.get('/_/health', async () => 'OK');
}
