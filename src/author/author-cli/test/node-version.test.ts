import { describe, expect, it } from 'vitest';

import { MIN_NODE_MAJOR, nodeVersionError } from '../src/lib/node-version';

describe('node version floor', () => {
  it('accepts the floor and everything above it', () => {
    expect(nodeVersionError(`${MIN_NODE_MAJOR}.0.0`)).toBeNull();
    expect(nodeVersionError(`${MIN_NODE_MAJOR + 2}.11.1`)).toBeNull();
  });

  it('names the runtime and the floor when the runtime is too old', () => {
    const message = nodeVersionError('18.20.4');
    expect(message).toContain('18.20.4');
    expect(message).toContain(String(MIN_NODE_MAJOR));
    expect(nodeVersionError(`${MIN_NODE_MAJOR - 1}.99.99`)).not.toBeNull();
  });

  it('stays quiet when the version cannot be read', () => {
    expect(nodeVersionError('')).toBeNull();
    expect(nodeVersionError('v20')).toBeNull();
  });

  it('takes the floor from the argument when one is given', () => {
    expect(nodeVersionError('20.0.0', 22)).not.toBeNull();
    expect(nodeVersionError('22.0.0', 22)).toBeNull();
  });
});
