import { describe, it, expect } from 'vitest';
import { addressOf, identityOf } from './address';

// The one normaliser, tested where it lives: the prefix an item or page was
// pinned in before the author became bare is stripped by shared's
// authorAddress; what is left is this module's residual (is it an address at
// all?) and the write-side rule (never rewrite a value that is not one).

const ADDR = '0x1111111111111111111111111111111111111111';

describe('addressOf', () => {
  it('accepts the bare form, lowercased', () => {
    expect(addressOf('0xAbCdEf0123456789012345678901234567890123')).toBe(
      '0xabcdef0123456789012345678901234567890123',
    );
    expect(addressOf(ADDR)).toBe(ADDR);
  });

  it('accepts the pre-change prefixed form', () => {
    expect(addressOf(`did:ethr:${ADDR}`)).toBe(ADDR);
    expect(addressOf(`DID:ETHR:0xAbCdEf0123456789012345678901234567890123`)).toBe(
      '0xabcdef0123456789012345678901234567890123',
    );
  });

  it('returns null for anything that is not an address', () => {
    expect(addressOf('not-an-address')).toBeNull();
    expect(addressOf('did:ethr:nothex')).toBeNull();
    expect(addressOf('did:ethr:safe:0x1111111111111111111111111111111111111111')).toBeNull();
    expect(addressOf(`0x${'11'.repeat(19)}`)).toBeNull(); // short
    expect(addressOf('')).toBeNull();
    expect(addressOf(undefined)).toBeNull();
    expect(addressOf(null)).toBeNull();
    expect(addressOf(42)).toBeNull();
  });

  it('does not treat a deal author and an item author of different forms as different', () => {
    expect(addressOf(`did:ethr:${ADDR}`)).toBe(addressOf(ADDR));
  });
});

describe('identityOf', () => {
  it('writes the address for either pinned form', () => {
    expect(identityOf(ADDR)).toBe(ADDR);
    expect(identityOf(`did:ethr:${ADDR}`)).toBe(ADDR);
  });

  it('passes a value that is not an address through untouched', () => {
    // The write side must not strip a shape it does not understand into
    // something that looks like an address.
    const didKey = 'did:ethr:safe:0x1111111111111111111111111111111111111111';
    expect(identityOf(didKey)).toBe(didKey);
    expect(identityOf('')).toBe('');
  });
});
