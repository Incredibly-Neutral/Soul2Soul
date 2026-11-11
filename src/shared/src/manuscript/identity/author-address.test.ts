import { describe, it, expect } from 'vitest';
import { accountAddress, authorAddress, LEGACY_AUTHOR_PREFIX } from './author-address';

const ADDR = '0x1111111111111111111111111111111111111111';
const CHECKSUMMED = '0xAbCdEf0123456789012345678901234567890123';

describe('authorAddress', () => {
  it('lowercases a bare address', () => {
    expect(authorAddress(CHECKSUMMED)).toBe(CHECKSUMMED.toLowerCase());
    expect(authorAddress(ADDR)).toBe(ADDR);
  });

  it('strips the pre-change prefix, case-insensitively', () => {
    expect(authorAddress(`${LEGACY_AUTHOR_PREFIX}${ADDR}`)).toBe(ADDR);
    expect(authorAddress(`${LEGACY_AUTHOR_PREFIX.toUpperCase()}${CHECKSUMMED}`)).toBe(
      CHECKSUMMED.toLowerCase(),
    );
  });
});

describe('accountAddress', () => {
  it('reads the address a CAIP-10 account id names, as carried', () => {
    expect(accountAddress(`eip155:8453:${ADDR}`)).toBe(ADDR);
    expect(accountAddress(`eip155:8453:${CHECKSUMMED}`)).toBe(CHECKSUMMED);
  });

  it('passes a bare address through, case included', () => {
    expect(accountAddress(ADDR)).toBe(ADDR);
    expect(accountAddress(CHECKSUMMED)).toBe(CHECKSUMMED);
  });

  it('reads a pre-change prefixed value through authorAddress()', () => {
    expect(accountAddress(`${LEGACY_AUTHOR_PREFIX}${ADDR}`)).toBe(ADDR);
    expect(accountAddress(`${LEGACY_AUTHOR_PREFIX}${CHECKSUMMED}`)).toBe(CHECKSUMMED.toLowerCase());
  });

  it('reads the same address from every shape that names it', () => {
    expect(accountAddress(`eip155:8453:${ADDR}`)).toBe(accountAddress(ADDR));
    expect(accountAddress(`${LEGACY_AUTHOR_PREFIX}${ADDR}`)).toBe(accountAddress(ADDR));
  });

  it('leaves a value that names no account alone', () => {
    expect(accountAddress('')).toBe('');
    expect(accountAddress('not-an-address')).toBe('not-an-address');
    expect(accountAddress('eip155:8453:not-an-address')).toBe('not-an-address');
  });
});
