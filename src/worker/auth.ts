import {
  createRemoteJWKSet,
  jwtVerify,
  errors,
  type JWTVerifyGetKey,
} from 'jose';
export interface Bindings {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ENV?: string;
  LOCAL_AUTH_MOCK?: string;
  APP_ORIGIN?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUD?: string;
  ACCESS_SERVICE_TOKEN_IDS?: string;
  ACCESS_IMPORT_TOKEN_IDS?: string;
  OWNER_EMAILS?: string;
}
export class AuthError extends Error {
  constructor(
    public status: 401 | 403 | 503,
    public code: string,
  ) {
    super(code);
  }
}
const keysets = new Map<string, JWTVerifyGetKey>();
export async function authenticate(
  request: Request,
  env: Bindings,
  agent: boolean,
  keyOverride?: JWTVerifyGetKey,
  onPrincipal?: (principal: string) => void,
  onImport?: (allowed: boolean) => void,
): Promise<'access' | 'local_mock'> {
  if (env.APP_ENV === 'local' && env.LOCAL_AUTH_MOCK === 'true') {
    onPrincipal?.('local:synthetic-owner');
    return 'local_mock';
  }
  const {
    ACCESS_ISSUER: issuer,
    ACCESS_AUD: audience,
    ACCESS_SERVICE_TOKEN_IDS: serviceIds,
    ACCESS_IMPORT_TOKEN_IDS: importIds,
    OWNER_EMAILS: owners,
  } = env;
  if (
    !issuer ||
    !audience?.trim() ||
    audience !== audience.trim() ||
    /[\s,]/.test(audience) ||
    !owners
      ?.split(',')
      .every((owner) => /^[^\s@,]+@[^\s@,]+$/.test(owner.trim())) ||
    (serviceIds !== undefined &&
      !serviceIds.split(',').every((id) => /^[^\s,]+$/.test(id.trim()))) ||
    (importIds !== undefined &&
      !importIds
        .split(',')
        .every((id) => /^[^\s,]+$/.test(id.trim()) && id.trim() !== '*')) ||
    !env.APP_ORIGIN
  )
    throw new AuthError(503, 'AUTH_NOT_CONFIGURED');
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
    if (
      issuerUrl.protocol !== 'https:' ||
      !issuerUrl.hostname.endsWith('.cloudflareaccess.com') ||
      issuerUrl.pathname !== '/' ||
      issuerUrl.search ||
      issuerUrl.hash ||
      issuerUrl.username ||
      issuerUrl.password
    )
      throw new Error();
  } catch {
    throw new AuthError(503, 'AUTH_NOT_CONFIGURED');
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new AuthError(401, 'UNAUTHENTICATED');
  let keys = keyOverride ?? keysets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuerUrl));
    keysets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'aud', 'iss'],
    });
    // Cloudflare application-token docs: both identities have type=app;
    // service tokens have common_name=Client ID and an empty sub.
    // Only classify verified claims. Mixed/incomplete shapes fail closed.
    const service =
      payload.type === 'app' &&
      payload.sub === '' &&
      typeof payload.common_name === 'string' &&
      /^[^\s,]+$/.test(payload.common_name) &&
      !Object.hasOwn(payload, 'email');
    const human =
      payload.type === 'app' &&
      typeof payload.sub === 'string' &&
      payload.sub.trim().length > 0 &&
      !Object.hasOwn(payload, 'common_name') &&
      typeof payload.email === 'string' &&
      owners
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .includes(payload.email.toLowerCase());
    if (agent ? !service : !human) throw new AuthError(403, 'FORBIDDEN');
    if (
      service &&
      serviceIds !== undefined &&
      !serviceIds
        .split(',')
        .map((s) => s.trim())
        .includes(payload.common_name as string)
    )
      throw new AuthError(403, 'FORBIDDEN');
    onPrincipal?.(`${issuer}|${service ? payload.common_name : payload.sub}`);
    onImport?.(
      service &&
        (importIds
          ?.split(',')
          .map((id) => id.trim())
          .includes(payload.common_name as string) ??
          false),
    );
    return 'access';
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (
      error instanceof errors.JWTClaimValidationFailed &&
      error.claim === 'aud'
    )
      throw new AuthError(403, 'FORBIDDEN');
    throw new AuthError(401, 'UNAUTHENTICATED');
  }
}
