/**
 * `sanitizeRemovePath` is the only guard between a caller-supplied `remove`
 * entry and an MFS `files/rm`. Every main-level test stubs it out, so the guards
 * themselves are pinned here: a path that climbs out of the temp tree, or that
 * names the tree root, `/assets` or `/index.html`, must be refused before any
 * request is made.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeRemovePath } from './verify';

describe('sanitizeRemovePath', () => {
  it('strips the leading and trailing slashes a caller may write', () => {
    expect(sanitizeRemovePath('/posts/hello/')).toBe('posts/hello');
    expect(sanitizeRemovePath('///posts//hello//')).toBe('posts//hello');
    expect(sanitizeRemovePath('posts/hello')).toBe('posts/hello');
  });

  it('refuses a path traversal segment anywhere in the path', () => {
    expect(() => sanitizeRemovePath('/../etc')).toThrow('Path traversal denied');
    expect(() => sanitizeRemovePath('/posts/../../etc')).toThrow('Path traversal denied');
    expect(() => sanitizeRemovePath('posts/../other')).toThrow('Path traversal denied');
  });

  it('refuses the tree root, /assets and /index.html', () => {
    expect(() => sanitizeRemovePath('/')).toThrow('reserved root');
    expect(() => sanitizeRemovePath('')).toThrow('reserved root');
    expect(() => sanitizeRemovePath('/assets')).toThrow('reserved root');
    expect(() => sanitizeRemovePath('/index.html')).toThrow('reserved root');
  });

  it('allows a path UNDER a reserved name — only the root itself is reserved', () => {
    expect(sanitizeRemovePath('/assets/txt/robots.txt')).toBe('assets/txt/robots.txt');
    expect(sanitizeRemovePath('/index.html/post')).toBe('index.html/post');
  });
});
