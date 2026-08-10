import { describe, it, expect } from 'vitest';
import {
  transformContent,
  sectionsTransform,
  DEFAULT_CONTENT_TRANSFORMS,
} from './content-transforms';

describe('sectionsTransform', () => {
  it('turns a section directive with attributes into a <section> element', () => {
    const input = '<!-- section class="aside">hello world<!-- /section>';
    expect(sectionsTransform(input)).toBe('<section class="aside">hello world</section>');
  });

  it('attributes pass through raw as a string', () => {
    const input = '<!-- section data-x="1" data-y="2">content<!-- /section -->';
    expect(sectionsTransform(input)).toBe('<section data-x="1" data-y="2">content</section>');
  });

  it('accepts `<!--section` without a space', () => {
    const input = '<!--section class="aside">no space<!-- /section>';
    expect(sectionsTransform(input)).toBe('<section class="aside">no space</section>');
  });

  it('handles an attribute-less opener with a `>` closer and a `-->` closer', () => {
    const input = '<!-- section>no attrs<!-- /section -->';
    expect(sectionsTransform(input)).toBe('<section>no attrs</section>');
  });

  it('accepts both `>` and `-->` closers on the opener', () => {
    expect(sectionsTransform('<!-- section>a<!-- /section>')).toBe('<section>a</section>');
    expect(sectionsTransform('<!-- section -->b<!-- /section -->')).toBe('<section>b</section>');
  });

  it('accepts both `>` and `-->` closers on the closer', () => {
    expect(sectionsTransform('<!-- section>a<!-- /section>')).toBe('<section>a</section>');
    expect(sectionsTransform('<!-- section>a<!-- /section -->')).toBe('<section>a</section>');
  });

  it('transforms multiple sections in one pass', () => {
    const input =
      '<!-- section class="a">A<!-- /section> and <!--section class="b">B<!-- /section -->';
    expect(sectionsTransform(input)).toBe(
      '<section class="a">A</section> and <section class="b">B</section>',
    );
  });

  it('leaves an unrelated HTML comment untouched', () => {
    const input = 'before<!-- just a comment -->after';
    expect(sectionsTransform(input)).toBe(input);
  });

  it('leaves a lone opener without a closer untouched', () => {
    const input = '<!-- section class="aside">no closer here';
    expect(sectionsTransform(input)).toBe(input);
  });

  it('does not match a section-like word (e.g. sectioning)', () => {
    const input = '<!-- sectioning --> still here';
    expect(sectionsTransform(input)).toBe(input);
  });

  it('preserves a nested non-section comment inside a section', () => {
    const input = '<!-- section>outer <!-- inner --> inner<!-- /section>';
    expect(sectionsTransform(input)).toBe('<section>outer <!-- inner --> inner</section>');
  });

  it('returns a non-string input unchanged', () => {
    const input = 12345 as unknown as string;
    expect(sectionsTransform(input)).toBe(12345);
  });
});

describe('transformContent (default stage)', () => {
  it('applies the built-in sections transform', () => {
    const input = '<!-- section class="aside">hi<!-- /section>';
    expect(transformContent(input)).toBe('<section class="aside">hi</section>');
  });

  it('returns content with no directive unchanged', () => {
    const input = 'plain markdown **content** with no directives';
    expect(transformContent(input)).toBe(input);
  });

  it('returns an empty string unchanged', () => {
    expect(transformContent('')).toBe('');
  });

  it('returns non-string input unchanged', () => {
    const input = { some: 'object' } as unknown as string;
    expect(transformContent(input)).toBe(input);
  });

  it('the default stage is an ordered list seeded with the sections transform', () => {
    expect(Array.isArray(DEFAULT_CONTENT_TRANSFORMS)).toBe(true);
    expect(DEFAULT_CONTENT_TRANSFORMS).toContain(sectionsTransform);
  });
});
