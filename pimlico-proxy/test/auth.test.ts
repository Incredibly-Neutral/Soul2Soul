import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';

import { AuthError, verifyJwt } from '../src/auth.js';

const SECRET = 'test-secret-that-is-long-enough-32';
const OTHER_SECRET = 'another-secret-that-is-long-enough-';
const NOW = 1_700_000_000;

function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(header: object, payload: object, secret = SECRET): string {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function tokenParts(token: string): readonly [string, string, string] {
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'expected a three-part token');
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? ''];
}

function expectAuthError(fn: () => unknown, matcher: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AuthError, `expected AuthError, got ${String(error)}`);
    assert.match(error.message, matcher);
    return true;
  });
}

describe('verifyJwt', () => {
  test('returns the subject of a valid token', () => {
    const token = sign({ alg: 'HS256', typ: 'JWT' }, { sub: 'user-1', exp: NOW + 60 });

    assert.deepEqual(verifyJwt(token, SECRET, { now: NOW }), { userId: 'user-1' });
  });

  test('accepts a token whose exp equals now exactly', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW });

    assert.deepEqual(verifyJwt(token, SECRET, { now: NOW }), { userId: 'user-1' });
  });

  test('accepts a fractional now below exp', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW });

    assert.deepEqual(verifyJwt(token, SECRET, { now: NOW - 0.5 }), { userId: 'user-1' });
  });

  test('defaults now to the current wall clock', () => {
    const token = sign(
      { alg: 'HS256' },
      { sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 60 },
    );

    assert.deepEqual(verifyJwt(token, SECRET), { userId: 'user-1' });
  });

  test('rejects a token signed with a different secret', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW + 60 }, OTHER_SECRET);

    expectAuthError(() => verifyJwt(token, SECRET, { now: NOW }), /bad signature/);
  });

  test('rejects a tampered payload', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW + 60 });
    const [header, , signature] = tokenParts(token);
    const forgedPayload = base64url(JSON.stringify({ sub: 'admin', exp: NOW + 60 }));
    const forged = `${header}.${forgedPayload}.${signature}`;

    expectAuthError(() => verifyJwt(forged, SECRET, { now: NOW }), /bad signature/);
  });

  test('rejects a signature of the wrong length without throwing RangeError', () => {
    const [header, payload] = tokenParts(sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW + 60 }));

    expectAuthError(
      () => verifyJwt(`${header}.${payload}.AAAA`, SECRET, { now: NOW }),
      /bad signature/,
    );
  });

  test('rejects alg "none"', () => {
    const token = `${base64url(JSON.stringify({ alg: 'none' }))}.${base64url(
      JSON.stringify({ sub: 'user-1', exp: NOW + 60 }),
    )}.`;

    expectAuthError(() => verifyJwt(token, SECRET, { now: NOW }), /malformed token/);

    const unsigned = sign({ alg: 'none' }, { sub: 'user-1', exp: NOW + 60 });
    expectAuthError(() => verifyJwt(unsigned, SECRET, { now: NOW }), /unsupported alg/);
  });

  test('rejects a missing alg and a non-HS256 alg', () => {
    expectAuthError(
      () => verifyJwt(sign({}, { sub: 'user-1', exp: NOW + 60 }), SECRET, { now: NOW }),
      /unsupported alg/,
    );
    expectAuthError(
      () =>
        verifyJwt(sign({ alg: 'RS256' }, { sub: 'user-1', exp: NOW + 60 }), SECRET, { now: NOW }),
      /unsupported alg/,
    );
  });

  test('rejects a token with missing exp', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1' });

    expectAuthError(() => verifyJwt(token, SECRET, { now: NOW }), /token expired/);
  });

  test('rejects a non-numeric exp', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: String(NOW + 60) });

    expectAuthError(() => verifyJwt(token, SECRET, { now: NOW }), /token expired/);
  });

  test('rejects an expired token', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW - 1 });

    expectAuthError(() => verifyJwt(token, SECRET, { now: NOW }), /token expired/);
  });

  test('rejects a token with missing or empty sub', () => {
    const missing = sign({ alg: 'HS256' }, { exp: NOW + 60 });
    expectAuthError(() => verifyJwt(missing, SECRET, { now: NOW }), /missing subject/);

    const empty = sign({ alg: 'HS256' }, { sub: '', exp: NOW + 60 });
    expectAuthError(() => verifyJwt(empty, SECRET, { now: NOW }), /missing subject/);
  });

  test('rejects a wrong issuer', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW + 60, iss: 'someone-else' });

    expectAuthError(
      () => verifyJwt(token, SECRET, { now: NOW, issuer: 'https://auth.example.com' }),
      /wrong issuer/,
    );
  });

  test('rejects a wrong audience', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW + 60, aud: 'other-service' });

    expectAuthError(
      () => verifyJwt(token, SECRET, { now: NOW, audience: 'pimlico-proxy' }),
      /wrong audience/,
    );
  });

  test('accepts a valid token with matching issuer and audience', () => {
    const token = sign(
      { alg: 'HS256' },
      {
        sub: 'user-1',
        exp: NOW + 60,
        iss: 'https://auth.example.com',
        aud: ['other-service', 'pimlico-proxy'],
      },
    );

    assert.deepEqual(
      verifyJwt(token, SECRET, {
        now: NOW,
        issuer: 'https://auth.example.com',
        audience: 'pimlico-proxy',
      }),
      { userId: 'user-1' },
    );
  });

  test('rejects a two-part token', () => {
    const [header, payload] = tokenParts(sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW + 60 }));

    expectAuthError(
      () => verifyJwt(`${header}.${payload}`, SECRET, { now: NOW }),
      /malformed token/,
    );
  });

  test('rejects an empty or over-long segment count', () => {
    expectAuthError(() => verifyJwt('', SECRET, { now: NOW }), /malformed token/);
    expectAuthError(() => verifyJwt('a.b.c.d', SECRET, { now: NOW }), /malformed token/);
    expectAuthError(() => verifyJwt('a..c', SECRET, { now: NOW }), /malformed token/);
  });

  test('rejects a non-JSON header or payload without leaking the token', () => {
    const header = base64url(JSON.stringify({ alg: 'HS256' }));
    const payload = base64url(JSON.stringify({ sub: 'user-1', exp: NOW + 60 }));
    const signature = createHmac('sha256', SECRET).update(`${header}.not-json`).digest('base64url');

    expectAuthError(
      () => verifyJwt(`${header}.not-json.${signature}`, SECRET, { now: NOW }),
      /malformed token/,
    );

    expectAuthError(
      () => verifyJwt(`${base64url('not-json')}.${payload}.${signature}`, SECRET, { now: NOW }),
      /malformed token/,
    );
  });

  test('never puts the token or secret in the error message', () => {
    const token = sign({ alg: 'HS256' }, { sub: 'user-1', exp: NOW + 60 }, OTHER_SECRET);

    try {
      verifyJwt(token, SECRET, { now: NOW });
      assert.fail('expected AuthError');
    } catch (error) {
      assert.ok(error instanceof AuthError);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes(SECRET), false);
    }
  });
});
