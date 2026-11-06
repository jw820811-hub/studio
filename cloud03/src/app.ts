import express from 'express';
import { z } from 'zod';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StudioOAuth, scopes } from './auth.js';
import { consentPage } from './consent.js';
import { createMcp } from './mcp.js';
import { RecordService } from './records.js';

export function createApp(provider: StudioOAuth, records: RecordService) {
  const app = express(); app.disable('x-powered-by');
  // Firebase's trusted front proxy is one hop. Never trust arbitrary forwarded chains.
  app.set('trust proxy', 1);
  app.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin-allow-popups' }); next(); });
  app.get('/health', (_req, res) => res.json({ service: 'woodys-studio-cloud03', version: '0.1.0' }));
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(provider.origin), scopesSupported: scopes,
    resourceServerUrl: provider.resource, resourceName: 'Woody’s Studio' }));
  const cookie = (raw: string | undefined) => {
    const found = raw?.split(';').map(v => v.trim()).find(v => v.startsWith('__session='));
    return found?.slice('__session='.length) || '';
  };
  app.get('/connect', async (req, res) => {
    try {
      const request = z.string().max(100).parse(req.query.request);
      const pending = await provider.describe(request, cookie(req.headers.cookie));
      const page = consentPage(pending.name, pending.scopes, request);
      res.set('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${page.nonce}' https://www.gstatic.com https://apis.google.com; style-src 'nonce-${page.nonce}'; connect-src 'self' https://*.googleapis.com https://www.gstatic.com; frame-src https://woodys-studio.firebaseapp.com https://accounts.google.com; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
      res.type('html').send(page.html);
    } catch { res.status(400).type('text').send('連結已過期，請從 ChatGPT 外掛設定重新開始。'); }
  });
  app.use('/consent', (req, res, next) => {
    if (req.headers.origin !== provider.origin) { res.status(403).json({ error: '請從原連結頁操作。' }); return; }
    next();
  }, express.json({ limit: '16kb' }));
  app.post('/consent/approve', async (req, res) => {
    try {
      const input = z.object({ requestId: z.string().max(100), idToken: z.string().min(1).max(12000), allowWrite: z.boolean() }).strict().parse(req.body);
      const redirect = await provider.approve(input.requestId, cookie(req.headers.cookie), input.idToken, input.allowWrite);
      res.clearCookie('__session', { path: '/', secure: true, sameSite: 'lax' }); res.json({ redirect });
    } catch { res.status(400).json({ error: '無法完成連結，請重新登入並從外掛設定重試。' }); }
  });
  app.post('/consent/cancel', async (req, res) => {
    try {
      const input = z.object({ requestId: z.string().max(100) }).strict().parse(req.body);
      const redirect = await provider.cancel(input.requestId, cookie(req.headers.cookie));
      res.clearCookie('__session', { path: '/', secure: true, sameSite: 'lax' }); res.json({ redirect });
    } catch { res.status(400).json({ error: '連結已過期，請關閉此頁。' }); }
  });
  app.use('/mcp', requireBearerAuth({ verifier: provider, requiredScopes: ['studio.read'],
    expectedResource: provider.resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resource) }));
  app.post('/mcp', express.json({ limit: '64kb' }), async (req, res) => {
    const server = createMcp(records, req.auth!);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Service unavailable' } }); }
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').end());
  app.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (!res.headersSent) res.status(400).json({ error: 'Invalid request' });
  });
  return app;
}
