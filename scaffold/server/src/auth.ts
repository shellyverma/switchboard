import {
  createHash,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
  type JsonWebKey as NodeJsonWebKey,
} from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { getRedis } from './redis.js';

const stateTtlSeconds = 5 * 60;
const sessionTtlSeconds = 8 * 60 * 60;
const sessionCookieName = 'switchboard_session';

export type WorkspaceMembership = {
  id: string;
  role: 'admin' | 'agent';
};

export type AuthenticatedUser = {
  sub: string;
  workspaces: WorkspaceMembership[];
};

type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

type LoginState = {
  verifier: string;
  nonce: string;
};

let discoveryPromise: Promise<OidcDiscovery> | undefined;

export async function startLogin(_req: Request, res: Response): Promise<void> {
  const discovery = await getDiscovery();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const stored = await getRedis().set(
    stateKey(state),
    JSON.stringify({ verifier, nonce } satisfies LoginState),
    'EX',
    stateTtlSeconds,
    'NX',
  );
  if (stored !== 'OK') throw new Error('Could not persist OIDC login state');

  const authorizationUrl = new URL(discovery.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.oidc.clientId,
    redirect_uri: config.oidc.redirectUri,
    scope: 'openid profile email',
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  res.redirect(302, authorizationUrl.toString());
}

export async function finishLogin(req: Request, res: Response): Promise<void> {
  const code = queryValue(req.query.code);
  const state = queryValue(req.query.state);
  if (!code || !state) {
    res.status(400).send('Missing authorization code or state');
    return;
  }

  const redis = getRedis();
  const storedState = await redis.getdel(stateKey(state));
  if (!storedState) {
    res.status(400).send('Invalid or expired login state');
    return;
  }

  let loginState: LoginState;
  try {
    const parsed: unknown = JSON.parse(storedState);
    if (!isRecord(parsed) || typeof parsed.verifier !== 'string' || typeof parsed.nonce !== 'string') {
      res.status(400).send('Invalid login state');
      return;
    }
    loginState = { verifier: parsed.verifier, nonce: parsed.nonce };
  } catch {
    res.status(400).send('Invalid login state');
    return;
  }

  const discovery = await getDiscovery();
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.oidc.redirectUri,
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: loginState.verifier,
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`OIDC token endpoint returned ${tokenResponse.status}`);
  }

  const tokenBody: unknown = await tokenResponse.json();
  if (!isRecord(tokenBody) || typeof tokenBody.id_token !== 'string') {
    throw new Error('OIDC token response did not contain an ID token');
  }

  const user = await verifyIdToken(tokenBody.id_token, loginState.nonce, discovery);
  const sessionId = randomBytes(32).toString('base64url');
  await getRedis().set(
    sessionKey(sessionId),
    JSON.stringify(user),
    'EX',
    sessionTtlSeconds,
  );

  const secure = config.oidc.redirectUri.startsWith('https://') ? '; Secure' : '';
  res.setHeader(
    'set-cookie',
    `${sessionCookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionTtlSeconds}${secure}`,
  );
  res.redirect(302, config.webOrigin);
}

export async function getAuthenticatedUser(req: Request): Promise<AuthenticatedUser | undefined> {
  const sessionId = readCookie(req.headers.cookie, sessionCookieName);
  if (!sessionId) return undefined;

  const key = sessionKey(sessionId);
  const serialized = await getRedis().get(key);
  if (!serialized) return undefined;

  let user: unknown;
  try {
    user = JSON.parse(serialized);
  } catch {
    await getRedis().del(key);
    return undefined;
  }
  if (!isAuthenticatedUser(user)) {
    await getRedis().del(key);
    return undefined;
  }

  await getRedis().expire(key, sessionTtlSeconds);
  return user;
}

export function getMembership(
  user: AuthenticatedUser,
  workspaceId: string,
): WorkspaceMembership | undefined {
  return user.workspaces.find((membership) => membership.id === workspaceId);
}

async function getDiscovery(): Promise<OidcDiscovery> {
  if (!discoveryPromise) {
    discoveryPromise = (async () => {
      const issuer = config.oidc.issuer.replace(/\/$/, '');
      const response = await fetch(`${issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`OIDC discovery returned ${response.status}`);
      const value: unknown = await response.json();
      if (
        !isRecord(value) ||
        value.issuer !== config.oidc.issuer ||
        typeof value.authorization_endpoint !== 'string' ||
        typeof value.token_endpoint !== 'string' ||
        typeof value.jwks_uri !== 'string'
      ) {
        throw new Error('OIDC discovery document is invalid');
      }
      return {
        issuer: value.issuer,
        authorization_endpoint: value.authorization_endpoint,
        token_endpoint: value.token_endpoint,
        jwks_uri: value.jwks_uri,
      };
    })();
  }

  try {
    return await discoveryPromise;
  } catch (error) {
    discoveryPromise = undefined;
    throw error;
  }
}

async function verifyIdToken(
  token: string,
  expectedNonce: string,
  discovery: OidcDiscovery,
): Promise<AuthenticatedUser> {
  const [encodedHeader, encodedClaims, encodedSignature, extra] = token.split('.');
  if (!encodedHeader || !encodedClaims || !encodedSignature || extra !== undefined) {
    throw new Error('OIDC ID token is malformed');
  }

  const header: unknown = decodeJson(encodedHeader);
  const claims: unknown = decodeJson(encodedClaims);
  if (!isRecord(header) || header.alg !== 'RS256' || typeof header.kid !== 'string') {
    throw new Error('OIDC ID token uses an unsupported signing key');
  }
  if (!isRecord(claims)) throw new Error('OIDC ID token claims are invalid');

  const jwksResponse = await fetch(discovery.jwks_uri);
  if (!jwksResponse.ok) throw new Error(`OIDC JWKS endpoint returned ${jwksResponse.status}`);
  const jwks: unknown = await jwksResponse.json();
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) throw new Error('OIDC JWKS is invalid');
  const jwk = jwks.keys.find(
    (key): key is Record<string, unknown> =>
      isRecord(key) && key.kid === header.kid && key.kty === 'RSA',
  );
  if (!jwk || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error('OIDC signing key was not found');
  }

  const publicJwk: NodeJsonWebKey = { kty: 'RSA', n: jwk.n, e: jwk.e };
  const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' });
  const signedContent = Buffer.from(`${encodedHeader}.${encodedClaims}`);
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (!verifySignature('RSA-SHA256', signedContent, publicKey, signature)) {
    throw new Error('OIDC ID token signature is invalid');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (
    claims.iss !== discovery.issuer ||
    !Array.isArray(audiences) ||
    !audiences.includes(config.oidc.clientId) ||
    typeof claims.exp !== 'number' ||
    claims.exp <= nowSeconds ||
    (typeof claims.nbf === 'number' && claims.nbf > nowSeconds) ||
    claims.nonce !== expectedNonce ||
    typeof claims.sub !== 'string' ||
    !Array.isArray(claims.workspaces)
  ) {
    throw new Error('OIDC ID token claims failed validation');
  }

  const workspaces: WorkspaceMembership[] = [];
  for (const membership of claims.workspaces) {
    if (
      !isRecord(membership) ||
      typeof membership.id !== 'string' ||
      (membership.role !== 'admin' && membership.role !== 'agent')
    ) {
      throw new Error('OIDC workspace claim is invalid');
    }
    workspaces.push({ id: membership.id, role: membership.role });
  }

  return { sub: claims.sub, workspaces };
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function isAuthenticatedUser(value: unknown): value is AuthenticatedUser {
  return (
    isRecord(value) &&
    typeof value.sub === 'string' &&
    Array.isArray(value.workspaces) &&
    value.workspaces.every(
      (membership) =>
        isRecord(membership) &&
        typeof membership.id === 'string' &&
        (membership.role === 'admin' || membership.role === 'agent'),
    )
  );
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  const pair = cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return pair?.slice(name.length + 1);
}

function queryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stateKey(state: string): string {
  return `switchboard:oidc-state:${state}`;
}

function sessionKey(sessionId: string): string {
  return `switchboard:session:${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
