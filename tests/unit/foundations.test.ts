import { describe, it, expect } from 'vitest';
import { kgToGrams, gramsToKg } from '../../src/shared/units';
import { workoutLocalDate } from '../../src/shared/dates';
import { measurementSchema } from '../../src/shared/contracts';
import { authenticate, type Bindings } from '../../src/worker/auth';
import { generateKeyPair, createLocalJWKSet, exportJWK, SignJWT } from 'jose';
describe('units and local dates (A08)', () => {
  it('preserves missing and explicit zero', () => {
    expect(kgToGrams(null)).toBeNull();
    expect(kgToGrams(0)).toBe(0);
    expect(kgToGrams(1.234)).toBe(1234);
    expect(gramsToKg(1234)).toBe(1.234);
    expect(() => kgToGrams(1.2345)).toThrow();
    expect(() => gramsToKg(-1)).toThrow();
  });
  it('handles midnight and DST instants without manual offsets', () => {
    expect(workoutLocalDate('2026-01-01T23:30:00Z', 'Asia/Shanghai')).toBe(
      '2026-01-02',
    );
    expect(workoutLocalDate('2026-03-08T06:59:00Z', 'America/New_York')).toBe(
      '2026-03-08',
    );
    expect(workoutLocalDate('2026-03-08T07:01:00Z', 'America/New_York')).toBe(
      '2026-03-08',
    );
    expect(() => workoutLocalDate('2026-01-01', 'UTC')).toThrow();
    expect(() => workoutLocalDate('2026-01-01T00:00:00Z', 'invalid')).toThrow();
  });
  it('rejects unknown measurement fields', () => {
    expect(measurementSchema.safeParse({ injected: true }).success).toBe(false);
  });
});
describe('cryptographic Access validation (A12)', () => {
  const env = {
    APP_ENV: 'production',
    ACCESS_ISSUER: 'https://synthetic.cloudflareaccess.com',
    ACCESS_AUD: 'single-app',
    OWNER_EMAILS: 'owner@example.test',
    APP_ORIGIN: 'https://health.example.test',
  } as Bindings;
  it('validates signed documented identities and rejects ambiguous or invalid claims', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const keys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: 'synthetic' }],
    });
    const human = {
      type: 'app',
      sub: 'synthetic-owner',
      email: 'owner@example.test',
    };
    const service = {
      type: 'app',
      sub: '',
      common_name: 'synthetic-client.access',
    };
    const sign = (claims: Record<string, unknown>, overrides = {}) =>
      new SignJWT({
        iss: env.ACCESS_ISSUER!,
        aud: [env.ACCESS_AUD!],
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        ...claims,
        ...overrides,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'synthetic' })
        .sign(privateKey);
    const request = (token: string) =>
      new Request(env.APP_ORIGIN!, {
        headers: { 'Cf-Access-Jwt-Assertion': token },
      });
    await expect(
      authenticate(request(await sign(human)), env, false, keys),
    ).resolves.toBe('access');
    await expect(
      authenticate(request(await sign(service)), env, true, keys),
    ).resolves.toBe('access');
    await expect(
      authenticate(
        request(await sign(service)),
        { ...env, ACCESS_SERVICE_TOKEN_IDS: 'synthetic-client.access' },
        true,
        keys,
      ),
    ).resolves.toBe('access');
    await expect(
      authenticate(
        request(await sign(service)),
        { ...env, ACCESS_SERVICE_TOKEN_IDS: 'other.access' },
        true,
        keys,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authenticate(request(await sign(service)), env, false, keys),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      authenticate(request(await sign(human)), env, true, keys),
    ).rejects.toMatchObject({ status: 403 });
    for (const claims of [
      {},
      { type: 'app', sub: '' },
      { ...human, sub: '' },
      { ...human, sub: ' ' },
      { ...human, email: 'stranger@example.test' },
      { ...human, common_name: service.common_name },
      { ...service, email: human.email },
      { ...service, email: '' },
      { ...service, sub: 'owner' },
      { ...service, common_name: '' },
      { ...service, common_name: null },
      { ...human, common_name: null },
      { ...human, type: 'org' },
      { ...service, type: 'service' },
    ])
      for (const agent of [false, true]) {
        await expect(
          authenticate(request(await sign(claims)), env, agent, keys),
        ).rejects.toMatchObject({
          status: claims.sub === undefined ? 401 : 403,
        });
      }
    for (const overrides of [
      { aud: 'wrong' },
      { iss: 'https://wrong.example.test' },
      { exp: 1 },
      { exp: undefined },
      { nbf: Math.floor(Date.now() / 1000) + 300 },
    ]) {
      await expect(
        authenticate(request(await sign(human, overrides)), env, false, keys),
      ).rejects.toMatchObject({ status: overrides.aud ? 403 : 401 });
    }
    await expect(
      authenticate(request('forged'), env, false, keys),
    ).rejects.toMatchObject({ status: 401 });
    const other = await generateKeyPair('RS256');
    const forged = await new SignJWT(human)
      .setProtectedHeader({ alg: 'RS256', kid: 'synthetic' })
      .setIssuer(env.ACCESS_ISSUER!)
      .setAudience(env.ACCESS_AUD!)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await expect(
      authenticate(request(forged), env, false, keys),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticate(
        new Request(env.APP_ORIGIN!, {
          headers: {
            'Cf-Access-Authenticated-User-Email': human.email,
            'CF-Access-Client-Id': service.common_name,
          },
        }),
        env,
        false,
        keys,
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('fails closed on invalid configuration and never implicitly enables local mock', async () => {
    for (const config of [
      { APP_ENV: 'production', LOCAL_AUTH_MOCK: 'true' },
      {
        ...env,
        ACCESS_AUD: undefined,
        ACCESS_HUMAN_AUD: 'old-human',
        ACCESS_AGENT_AUD: 'old-agent',
      },
      { ...env, ACCESS_AUD: '' },
      { ...env, ACCESS_AUD: 'a,b' },
      { ...env, OWNER_EMAILS: ',' },
      { ...env, ACCESS_SERVICE_TOKEN_IDS: '' },
      { ...env, ACCESS_ISSUER: 'http://synthetic.cloudflareaccess.com' },
    ])
      await expect(
        authenticate(
          new Request('http://localhost'),
          config as Bindings,
          false,
        ),
      ).rejects.toMatchObject({ status: 503 });
    await expect(
      authenticate(
        new Request('http://localhost'),
        { APP_ENV: 'local', LOCAL_AUTH_MOCK: 'true' } as Bindings,
        false,
      ),
    ).resolves.toBe('local_mock');
    await expect(
      authenticate(
        new Request('http://localhost'),
        { APP_ENV: 'local' } as Bindings,
        false,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
});
