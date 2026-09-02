/**
 * Tests for path mapping (IPFS tree path → local filename).
 */
import { describe, it, expect } from 'vitest';
import { mapPath } from '../src/mirror.js';

describe('mapPath', () => {
  it('maps root entry to index.html', () => {
    expect(mapPath('')).toBe('index.html');
  });

  it('maps root entry (null-like) to index.html', () => {
    // The function handles empty strings
    expect(mapPath('')).toBe('index.html');
  });

  it('preserves simple file paths', () => {
    expect(mapPath('about.html')).toBe('about.html');
  });

  it('preserves nested file paths', () => {
    expect(mapPath('blog/post.html')).toBe('blog/post.html');
  });

  it('preserves deep paths', () => {
    expect(mapPath('assets/images/logo.png')).toBe('assets/images/logo.png');
  });

  it('preserves paths with dots', () => {
    expect(mapPath('styles/main.min.css')).toBe('styles/main.min.css');
  });
});
