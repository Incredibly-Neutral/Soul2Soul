import { describe, it, expect } from 'vitest';
import { rippleFiresForBody } from './ripple-gate';
import { S2SBody, S2SRipple } from '@s2s/soul2soul-shared/lit-actions';

// ============================================================================
// rippleFiresForBody — trigger-side gate for a ripple.
//
// A ripple fires only if `origins` includes `body.postType` AND every
// `trigger_filters` predicate matches the body (matched on canonical signed
// fields, e.g. `locale`). `trigger_filters` is optional — when absent the
// ripple fires purely on the `origins` match (today's behaviour).
// ============================================================================

const baseBody = {
  id: 't1',
  author: '0xAuthor',
  locale: 'nl',
  parent: '',
  position: '',
  postType: 'post',
  creationDate: '2026-08-13',
  modifiedDate: '2026-08-13',
  tags: [],
  publication: 'test.s2s',
  encryption: false,
  title: 'Title',
  content: 'plain',
} as unknown as S2SBody;

const body = (overrides: Record<string, unknown> = {}) =>
  ({ ...baseBody, ...overrides }) as unknown as S2SBody;

const ripple = (overrides: Partial<S2SRipple> = {}): S2SRipple =>
  ({
    origins: ['post'],
    destination: 'home_nl',
    reference: 'home_nl',
    query: { genesis: '0xabc' },
    filters: [],
    ...overrides,
  }) as S2SRipple;

describe('rippleFiresForBody: origins gate (unchanged)', () => {
  it('fires when origins includes the body postType', () => {
    expect(rippleFiresForBody(ripple(), body())).toBe(true);
  });

  it('does NOT fire when the body postType is not in origins', () => {
    const r = ripple({ origins: ['why', 'how'] });
    expect(rippleFiresForBody(r, body({ postType: 'post' }))).toBe(false);
  });
});

describe('rippleFiresForBody: trigger_filters gate', () => {
  it('(a) fires when every trigger_filters predicate matches the body', () => {
    const r = ripple({ trigger_filters: [{ locale: 'nl' }] });
    expect(rippleFiresForBody(r, body({ locale: 'nl' }))).toBe(true);
  });

  it('(b) does NOT fire when a predicate locale does not match the body locale', () => {
    const r = ripple({ trigger_filters: [{ locale: 'nl' }] });
    expect(rippleFiresForBody(r, body({ locale: 'en' }))).toBe(false);
  });

  it('(c) fires as before when trigger_filters is absent (origins-only match)', () => {
    const r = ripple({ trigger_filters: undefined });
    expect(rippleFiresForBody(r, body({ locale: 'en' }))).toBe(true);
  });

  it('(c) fires as before when trigger_filters is an empty array', () => {
    const r = ripple({ trigger_filters: [] });
    expect(rippleFiresForBody(r, body({ locale: 'en' }))).toBe(true);
  });

  it('does NOT fire unless EVERY trigger_filters predicate matches', () => {
    const r = ripple({ trigger_filters: [{ locale: 'nl' }, { postType: 'why' }] });
    expect(rippleFiresForBody(r, body({ locale: 'nl', postType: 'post' }))).toBe(false);
  });

  it('fires when all predicates of a multi-key predicate match', () => {
    const r = ripple({ trigger_filters: [{ locale: 'nl', postType: 'post' }] });
    expect(rippleFiresForBody(r, body({ locale: 'nl', postType: 'post' }))).toBe(true);
  });
});

describe('rippleFiresForBody: genesis path', () => {
  it('(d) gate still applies when the ripple has a pinned genesis (non-match rejected)', () => {
    const r = ripple({
      query: { genesis: '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063' },
      trigger_filters: [{ locale: 'nl' }],
    });
    // Genesis pins the destination, not the trigger — a non-matching locale
    // must NOT fire even though a genesis is present.
    expect(rippleFiresForBody(r, body({ locale: 'en' }))).toBe(false);
  });

  it('(d) genesis ripple fires when the trigger_filters predicate matches', () => {
    const r = ripple({
      query: { genesis: '0x9a1600a648241726b0470d0b0b85df1d166e0aa74b88789b5f569294baa5a063' },
      trigger_filters: [{ locale: 'nl' }],
    });
    expect(rippleFiresForBody(r, body({ locale: 'nl' }))).toBe(true);
  });
});
