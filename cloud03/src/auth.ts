import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTokenError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Store, Transaction } from './store.js';
import { digest, userPath } from './records.js';

export const scopes = ['studio.read', 'studio.write'];
const opaque = () => randomBytes(32).toString('base64url');
const key = (kind: string, token: string) => `_cloud03_private/${kind}_${digest(token)}`;
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
interface Pending {
  clientId: string; clientName: string; redirectUri: string; scopes: string[];
  codeChallenge: string; resource: string; state?: string; expiresAt: number; cookieHash: string;
}
interface Grant { uid: string; clientId: string; scopes: string[]; resource: string; expiresAt: number; revoked?: boolean }
interface Code extends Pending { uid: string }
interface Token { grant: string; clientId: string; scopes: string[]; expiresAt: number }

export class StudioOAuth implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly resource: URL;
  constructor(private store: Store, readonly origin: string,
    private verifyFirebase: (token: string) => Promise<{ uid: string; email_verified?: boolean }>,
    private activeUser: (uid: string) => Promise<boolean>,
    private now = () => Math.floor(Date.now() / 1000),
    private allowedHosts = ['chatgpt.com', 'chat.openai.com']) {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw Error('Bridge origin must be an HTTPS origin with no path');
    this.resource = new URL('/mcp', origin);
    this.clientsStore = {
      getClient: id => this.store.get<OAuthClientInformationFull>(key('client', id)),
      registerClient: async input => {
        if (!input.redirect_uris.length || input.redirect_uris.length > 10) throw new InvalidClientMetadataError('Invalid redirect URIs');
        for (const raw of input.redirect_uris) {
          const uri = new URL(raw);
          if (uri.protocol !== 'https:' || !this.allowedHosts.includes(uri.hostname) || uri.port || uri.username || uri.password || uri.hash)
            throw new InvalidClientMetadataError('Only configured ChatGPT callback hosts are allowed');
        }
        const client = JSON.parse(JSON.stringify({ ...input, client_id: randomUUID(), client_id_issued_at: this.now() })) as OAuthClientInformationFull;
        await this.store.set(key('client', client.client_id), client);
        return client;
      },
    };
  }
  private checkResource(resource?: URL) {
    if (resource && resource.href !== this.resource.href) throw new InvalidRequestError('Incorrect resource');
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.checkResource(params.resource);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('S256 PKCE required');
    if (!client.redirect_uris.includes(params.redirectUri)) throw new InvalidRequestError('Unregistered callback');
    const requested = params.scopes?.length ? [...new Set(params.scopes)] : [...scopes];
    if (requested.some(s => !scopes.includes(s)) || !requested.includes('studio.read')) throw new InvalidScopeError('Invalid scopes');
    const request = opaque(), cookie = opaque();
    const pending: Pending = { clientId: client.client_id, clientName: client.client_name || 'ChatGPT',
      scopes: requested, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge,
      resource: this.resource.href, expiresAt: this.now() + 600, cookieHash: digest(cookie),
      ...(params.state ? { state: params.state } : {}) };
    await this.store.set(key('pending', request), pending);
    // Firebase Hosting forwards the __session cookie to the function.
    res.cookie('__session', cookie, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 600000, path: '/' });
    res.redirect(302, `${this.origin}/connect?request=${encodeURIComponent(request)}`);
  }
  private async pending(request: string, cookie: string, tx?: Transaction) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(request) || !cookie) throw new InvalidGrantError('Authorization expired');
    const pending = await (tx || this.store).get<Pending>(key('pending', request));
    if (!pending || pending.expiresAt <= this.now() || !same(pending.cookieHash, digest(cookie)))
      throw new InvalidGrantError('Authorization expired');
    return pending;
  }
  async describe(request: string, cookie: string) {
    const p = await this.pending(request, cookie);
    return { name: p.clientName, scopes: p.scopes };
  }
  async approve(request: string, cookie: string, firebaseToken: string, allowWrite: boolean) {
    const identity = await this.verifyFirebase(firebaseToken);
    if (!identity.email_verified) throw new InvalidGrantError('Verified Google account required');
    userPath(identity.uid);
    return this.store.transaction(async tx => {
      const p = await this.pending(request, cookie, tx);
      const code = opaque();
      tx.set(key('code', code), { ...p, uid: identity.uid, expiresAt: this.now() + 120,
        scopes: p.scopes.filter(s => allowWrite || s !== 'studio.write') });
      tx.delete(key('pending', request));
      const redirect = new URL(p.redirectUri);
      redirect.searchParams.set('code', code);
      if (p.state) redirect.searchParams.set('state', p.state);
      return redirect.href;
    });
  }
  async cancel(request: string, cookie: string) {
    return this.store.transaction(async tx => {
      const p = await this.pending(request, cookie, tx);
      tx.delete(key('pending', request));
      const redirect = new URL(p.redirectUri); redirect.searchParams.set('error', 'access_denied');
      if (p.state) redirect.searchParams.set('state', p.state);
      return redirect.href;
    });
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const p = await this.store.get<Code>(key('code', code));
    if (!p || p.clientId !== client.client_id || p.expiresAt <= this.now()) throw new InvalidGrantError('Invalid code');
    return p.codeChallenge;
  }
  private issue(tx: Transaction, grantId: string, grant: Grant): OAuthTokens {
    const access = opaque(), refresh = opaque();
    const expiresAt = Math.min(this.now() + 3600, grant.expiresAt);
    const data: Token = { grant: grantId, clientId: grant.clientId, scopes: grant.scopes, expiresAt };
    tx.set(key('access', access), data);
    tx.set(key('refresh', refresh), { ...data, expiresAt: grant.expiresAt });
    return { access_token: access, token_type: 'Bearer', expires_in: expiresAt - this.now(),
      refresh_token: refresh, scope: grant.scopes.join(' ') };
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string,
    _verifier?: string, redirectUri?: string, resource?: URL) {
    this.checkResource(resource);
    return this.store.transaction(async tx => {
      const p = await tx.get<Code>(key('code', code));
      if (!p || p.clientId !== client.client_id || p.expiresAt <= this.now() || redirectUri !== p.redirectUri)
        throw new InvalidGrantError('Invalid or consumed authorization code');
      const grantId = opaque();
      const grant: Grant = { uid: p.uid, clientId: p.clientId, scopes: p.scopes,
        resource: p.resource, expiresAt: this.now() + 30 * 86400 };
      tx.delete(key('code', code)); tx.set(key('grant', grantId), grant);
      return this.issue(tx, grantId, grant);
    });
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, requested?: string[], resource?: URL) {
    this.checkResource(resource);
    return this.store.transaction(async tx => {
      const token = await tx.get<Token>(key('refresh', refresh));
      if (!token || token.clientId !== client.client_id || token.expiresAt <= this.now()) throw new InvalidGrantError('Invalid refresh token');
      const grant = await tx.get<Grant>(key('grant', token.grant));
      if (!grant || grant.revoked || grant.expiresAt <= this.now() || !await this.activeUser(grant.uid))
        throw new InvalidGrantError('Authorization revoked');
      const narrowed = requested || token.scopes;
      if (narrowed.some(s => !token.scopes.includes(s)) || !narrowed.includes('studio.read')) throw new InvalidScopeError('Scope escalation denied');
      tx.delete(key('refresh', refresh));
      return this.issue(tx, token.grant, { ...grant, scopes: narrowed });
    });
  }
  async verifyAccessToken(access: string): Promise<AuthInfo> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(access)) throw new InvalidTokenError('Invalid token');
    const token = await this.store.get<Token>(key('access', access));
    if (!token || token.expiresAt <= this.now()) throw new InvalidTokenError('Token expired');
    const grant = await this.store.get<Grant>(key('grant', token.grant));
    if (!grant || grant.revoked || grant.expiresAt <= this.now() || !await this.activeUser(grant.uid))
      throw new InvalidTokenError('Authorization revoked');
    return { token: access, clientId: token.clientId, scopes: token.scopes, expiresAt: token.expiresAt,
      resource: new URL(grant.resource), extra: { uid: grant.uid } };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    await this.store.transaction(async tx => {
      const access = await tx.get<Token>(key('access', request.token));
      const refresh = await tx.get<Token>(key('refresh', request.token));
      const token = access || refresh;
      if (!token || token.clientId !== client.client_id) return;
      const grant = await tx.get<Grant>(key('grant', token.grant));
      if (grant) tx.set(key('grant', token.grant), { ...grant, revoked: true });
    });
  }
}
