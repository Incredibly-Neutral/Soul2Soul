import { describe, it, expect } from 'vitest';
import { addressOf } from './address';
import { LEGACY_AUTHOR_PREFIX } from '../../../../shared/dist/manuscript/identity/author-address';

// The one normaliser, tested where it lives: the prefix an item or page was
// pinned in before the author became bare is stripped by shared's
// authorAddress; what is left is this module's residual (is it an address at
// all?).

const ADDR = '0x1111111111111111111111111111111111111111';

describe('addressOf', () => {
  it('accepts the bare form, lowercased', () => {
    expect(addressOf('0xAbCdEf0123456789012345678901234567890123')).toBe(
      '0xabcdef0123456789012345678901234567890123',
    );
    expect(addressOf(ADDR)).toBe(ADDR);
  });

  it('accepts the pre-change prefixed form', () => {
    expect(addressOf(`${LEGACY_AUTHOR_PREFIX}${ADDR}`)).toBe(ADDR);
    expect(
      addressOf(`${LEGACY_AUTHOR_PREFIX.toUpperCase()}0xAbCdEf0123456789012345678901234567890123`),
    ).toBe('0xabcdef0123456789012345678901234567890123');
  });

  it('returns null for anything that is not an address', () => {
    expect(addressOf('not-an-address')).toBeNull();
    expect(addressOf(`${LEGACY_AUTHOR_PREFIX}nothex`)).toBeNull();
    expect(addressOf(`${LEGACY_AUTHOR_PREFIX}safe:${ADDR}`)).toBeNull();
    expect(addressOf(`0x${'11'.repeat(19)}`)).toBeNull(); // short
    expect(addressOf('')).toBeNull();
    expect(addressOf(undefined)).toBeNull();
    expect(addressOf(null)).toBeNull();
    expect(addressOf(42)).toBeNull();
  });

  it('does not treat a deal author and an item author of different forms as different', () => {
    expect(addressOf(`${LEGACY_AUTHOR_PREFIX}${ADDR}`)).toBe(addressOf(ADDR));
  });
});
