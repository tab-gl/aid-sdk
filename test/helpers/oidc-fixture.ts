import * as http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/**
 * Local OIDC issuer used by tests that need real JWT verification.
 *
 * `jose` fetches remote JWK sets with `node:http`/`node:https` rather than the
 * global `fetch`, so a stubbed `fetch` cannot intercept a JWKS request. This
 * fixture serves authorization, discovery, JWKS, token, revocation and logout
 * endpoints over a real loopback HTTP server, which is exempt from the SDK's HTTPS rule.
 */
export interface OidcFixtureOptions {
  clientId?: string;
  nonce?: string;
  kid?: string;
  /** Lifetime reported by the token endpoint; `null` omits `expires_in`. */
  expiresIn?: number | null;
  /** Optional gate applied to token requests, for race tests. */
  tokenGate?: Promise<void>;
  /** Require codes to have been issued by the fixture's /authorize endpoint. */
  requireAuthorizationCodeRegistration?: boolean;
  /** Lifetime for codes issued by /authorize. Negative values generate expired codes in tests. */
  authorizationCodeLifetimeMs?: number;
  /** Return an OAuth error for selected authorization codes (for provider-error tests). */
  rejectAuthorizationCode?: (code: string) => boolean;
}

interface IssuedAuthorizationCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  expiresAt: number;
  used: boolean;
}

export interface OidcFixture {
  issuer: string;
  jwksUrl: string;
  jwksFetches(): number;
  tokenRequests(): number;
  requests: Array<{ path: string; body?: string }>;
  setJwks(jwks: unknown): void;
  setNonce(nonce: string): void;
  setCodeChallenge(challenge: string): void;
  signIdToken(claims: Record<string, unknown>, kid?: string): Promise<string>;
  close(): Promise<void>;
}

export async function startOidcFixture(options: OidcFixtureOptions = {}): Promise<OidcFixture> {
  const clientId = options.clientId ?? 'client-1';
  const nonce = options.nonce ?? 'nonce-1';
  let nonceOverride: string | undefined;
  const kid = options.kid ?? 'k1';
  const expiresIn = options.expiresIn === undefined ? 3600 : options.expiresIn;

  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  let jwks: unknown = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };
  let expectedCodeChallenge: string | undefined;
  const authorizationCodes = new Map<string, IssuedAuthorizationCode>();
  const usedAuthorizationCodes = new Set<string>();
  let authorizationCodeSequence = 0;
  let jwksFetches = 0;
  let tokenRequests = 0;
  const requests: Array<{ path: string; body?: string }> = [];

  const signIdToken = async (
    claims: Record<string, unknown>,
    tokenKid = kid,
  ): Promise<string> =>
    new SignJWT({ sub: 'user-1', nonce, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: tokenKid })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  let issuer = '';
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] as string;
    const send = (payload: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (path === '/.well-known/openid-configuration') {
      send({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
      });
      return;
    }

    if (path === '/authorize') {
      const authorizationRequest = new URL(req.url ?? '/', issuer);
      const requestedClientId = authorizationRequest.searchParams.get('client_id');
      const redirectUri = authorizationRequest.searchParams.get('redirect_uri');
      const state = authorizationRequest.searchParams.get('state');
      const codeChallenge = authorizationRequest.searchParams.get('code_challenge');
      const nonce = authorizationRequest.searchParams.get('nonce');
      if (authorizationRequest.searchParams.get('response_type') !== 'code' ||
          requestedClientId !== clientId || !redirectUri || !state || !nonce ||
          !codeChallenge || authorizationRequest.searchParams.get('code_challenge_method') !== 'S256') {
        send({ error: 'invalid_request' }, 400);
        return;
      }

      let callback: URL;
      try {
        callback = new URL(redirectUri);
        const secureRedirect = callback.protocol === 'https:' ||
          (callback.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname));
        if (!secureRedirect) {
          send({ error: 'invalid_request' }, 400);
          return;
        }
      } catch {
        send({ error: 'invalid_request' }, 400);
        return;
      }

      const code = `fixture-code-${++authorizationCodeSequence}`;
      authorizationCodes.set(code, {
        clientId: requestedClientId,
        redirectUri: callback.toString(),
        codeChallenge,
        nonce,
        expiresAt: Date.now() + (options.authorizationCodeLifetimeMs ?? 60_000),
        used: false,
      });
      requests.push({ path });
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', state);
      res.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
      res.end();
      return;
    }

    if (path === '/jwks') {
      jwksFetches += 1;
      send(jwks);
      return;
    }

    if (path === '/revoke' || path === '/logout') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }

    if (path === '/token') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(raw);
          requests.push({ path, body: raw });
          tokenRequests += 1;
          const generation = tokenRequests;

          if (options.tokenGate) await options.tokenGate;

          if (form.get('grant_type') === 'refresh_token') {
            send({
              access_token: `refreshed-access-${generation}`,
              refresh_token: `refreshed-refresh-${generation}`,
              token_type: 'Bearer',
              ...(expiresIn === null ? {} : { expires_in: expiresIn }),
            });
            return;
          }

          const code = form.get('code') ?? '';
          const verifier = form.get('code_verifier') ?? '';
          const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
          const issuedCode = authorizationCodes.get(code);
          if (options.requireAuthorizationCodeRegistration && !issuedCode) {
            send({ error: 'invalid_grant', error_description: 'Authorization code was not issued by this provider' }, 400);
            return;
          }
          if (issuedCode && (issuedCode.used || issuedCode.expiresAt <= Date.now())) {
            send({ error: 'invalid_grant', error_description: 'Authorization code is expired or already used' }, 400);
            return;
          }
          if (issuedCode && (form.get('client_id') !== issuedCode.clientId ||
              form.get('redirect_uri') !== issuedCode.redirectUri ||
              codeChallenge !== issuedCode.codeChallenge)) {
            send({ error: 'invalid_grant', error_description: 'Authorization code binding or PKCE verification failed' }, 400);
            return;
          }
          if (expectedCodeChallenge !== undefined && codeChallenge !== expectedCodeChallenge) {
            send({ error: 'invalid_grant', error_description: 'PKCE code_verifier does not match' }, 400);
            return;
          }
          if (usedAuthorizationCodes.has(code) || options.rejectAuthorizationCode?.(code)) {
            send({ error: 'invalid_grant', error_description: 'Authorization code is expired or already used' }, 400);
            return;
          }
          if (issuedCode) issuedCode.used = true;
          usedAuthorizationCodes.add(code);

          send({
            access_token: `access-token-${generation}`,
            id_token: await signIdToken({ nonce: nonceOverride ?? issuedCode?.nonce ?? nonce }),
            refresh_token: `refresh-${generation}`,
            token_type: 'Bearer',
            ...(expiresIn === null ? {} : { expires_in: expiresIn }),
          });
        })();
      });
      return;
    }

    send({ error: 'not_found' }, 404);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${port}`;

  return {
    get issuer() {
      return issuer;
    },
    get jwksUrl() {
      return `${issuer}/jwks`;
    },
    jwksFetches: () => jwksFetches,
    tokenRequests: () => tokenRequests,
    requests,
    setJwks: (next: unknown) => {
      jwks = next;
    },
    setNonce: (next: string) => {
      nonceOverride = next;
    },
    setCodeChallenge: (challenge: string) => {
      expectedCodeChallenge = challenge;
    },
    signIdToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
