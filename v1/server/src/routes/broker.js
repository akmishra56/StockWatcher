/**
 * Broker connection setup -- operates on whichever connection is currently
 * active (ctx.brokerClient, set by server.js's activateConnection when the
 * active connection's kind is 'broker'). A user connects a broker by: (1)
 * POST /api/data-connections to create the connection + activate it, (2)
 * POST /api/broker/credentials with their App ID/Secret Key/Redirect URI,
 * (3) GET /api/broker/login-url and open it in their own browser to log
 * into their own broker account, (4) POST /api/broker/exchange-code with
 * the auth_code Fyers redirected back with.
 *
 * Deliberately generic ("broker", not "fyers") at the route level even
 * though FyersClient is the only implementation today -- a second broker
 * later reuses these same three routes against whichever BrokerClient is
 * currently active, exactly like BrokerBridge.js reuses its orchestration
 * logic across brokers.
 */
export function registerBrokerRoutes(app, ctx) {
  function requireBrokerClient(reply) {
    if (!ctx.brokerClient) {
      reply.code(400);
      reply.send({ error: 'The active connection is not a broker connection' });
      return null;
    }
    return ctx.brokerClient;
  }

  app.post('/api/broker/credentials', async (req, reply) => {
    const client = requireBrokerClient(reply);
    if (!client) return;
    const { appId, secretKey, redirectUri } = req.body ?? {};
    if (!appId || !secretKey || !redirectUri) {
      reply.code(400);
      return { error: 'appId, secretKey, and redirectUri are required' };
    }
    await client.saveAppCredentials({ appId, secretKey, redirectUri });
    return { ok: true };
  });

  app.get('/api/broker/login-url', async (req, reply) => {
    const client = requireBrokerClient(reply);
    if (!client) return;
    try {
      return { url: await client.getLoginUrl() };
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.post('/api/broker/exchange-code', async (req, reply) => {
    const client = requireBrokerClient(reply);
    if (!client) return;
    const { authCode } = req.body ?? {};
    if (!authCode) {
      reply.code(400);
      return { error: 'authCode is required' };
    }
    try {
      await client.exchangeAuthCode(authCode);
      return { ok: true, authenticated: await client.isAuthenticated() };
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.get('/api/broker/status', async (req, reply) => {
    const client = requireBrokerClient(reply);
    if (!client) return;
    return { label: client.label, authenticated: await client.isAuthenticated() };
  });
}
