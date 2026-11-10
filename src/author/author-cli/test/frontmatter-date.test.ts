import { describe, expect, it } from 'vitest';

import { frontmatterDateToUnix } from '../src/lib/frontmatter';

// Literal epochs pin the UTC reading: a parser that used local time would
// return a different number on any machine whose zone is not UTC.
const CREATED = 1_614_834_367; // 2021-03-04T05:06:07Z

describe('frontmatterDateToUnix', () => {
  it('reads the writer\'s own format (no zone) as UTC', () => {
    expect(frontmatterDateToUnix('2021-03-04T05:06:07')).toBe(CREATED);
    expect(new Date(CREATED * 1000).toISOString().slice(0, 19)).toBe('2021-03-04T05:06:07');
  });

  it('accepts a Z suffix and fractional seconds', () => {
    expect(frontmatterDateToUnix('2021-03-04T05:06:07Z')).toBe(CREATED);
    expect(frontmatterDateToUnix('2021-03-04T05:06:07.000Z')).toBe(CREATED);
    expect(frontmatterDateToUnix('2021-03-04T05:06:07.123Z')).toBe(CREATED);
    expect(frontmatterDateToUnix('2021-03-04T05:06:07.999')).toBe(CREATED);
  });

  it('honours an explicit offset instead of ignoring it', () => {
    expect(frontmatterDateToUnix('2021-03-04T06:06:07+01:00')).toBe(CREATED);
    expect(frontmatterDateToUnix('2021-03-04T05:06:07+00:00')).toBe(CREATED);
    expect(frontmatterDateToUnix('2021-03-03T23:06:07-06:00')).toBe(CREATED);
  });

  it('accepts a date-only value as midnight UTC', () => {
    expect(frontmatterDateToUnix('2021-03-04')).toBe(1_614_816_000);
  });

  it('accepts a Date', () => {
    expect(frontmatterDateToUnix(new Date((CREATED + 0.4) * 1000))).toBe(CREATED);
    expect(frontmatterDateToUnix(new Date('invalid'))).toBeUndefined();
  });

  it('rejects malformed and impossible values', () => {
    for (const value of [
      'yesterday',
      '2021-03',
      '2021-03-04T05:06',
      '2021-03-04T25:00:00',
      '2021-03-04T05:61:00',
      '2021-13-01T00:00:00',
      '2021-02-31T00:00:00',
      '  ',
      '',
    ]) {
      expect(frontmatterDateToUnix(value), value).toBeUndefined();
    }
    for (const value of [undefined, null, 42, true, {}]) {
      expect(frontmatterDateToUnix(value)).toBeUndefined();
    }
  });
});
