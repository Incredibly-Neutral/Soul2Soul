import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findActionByName, removePreviousAction } from './swap-action.js';

type RemoveFn = (groupId: number, hashedCid: string) => Promise<{ success: boolean }>;

function makeLit(overrides: { removeActionFromGroup?: RemoveFn } = {}) {
  return {
    removeActionFromGroup:
      overrides.removeActionFromGroup ?? (vi.fn(async () => ({ success: true })) as RemoveFn),
  };
}

describe('swap-action removal diagnostics', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  describe('findActionByName', () => {
    it('returns the matching entry by name', () => {
      const actions = [
        { name: 'prep', cid: 'cidA', hashedCid: 'hashA' },
        { name: 'render', cid: 'cidB', hashedCid: 'hashB' },
      ];
      expect(findActionByName(actions, 'render')).toEqual({
        name: 'render',
        cid: 'cidB',
        hashedCid: 'hashB',
      });
    });

    it('returns undefined when no entry matches (first deploy or post-rename)', () => {
      expect(findActionByName([{ name: 'prep', cid: 'cidA', hashedCid: 'hashA' }], 'render')).toBeUndefined();
      expect(findActionByName(undefined, 'render')).toBeUndefined();
    });
  });

  describe('removePreviousAction', () => {
    it('skips removal and logs the reason when there is no previous action', async () => {
      const lit = makeLit();

      await removePreviousAction(lit as never, 14, undefined, 'render');

      expect(lit.removeActionFromGroup).not.toHaveBeenCalled();
      const skipped = logSpy.mock.calls
        .map((args: unknown[]) => args.join(' '))
        .find((line: string) => line.includes("removeActionFromGroup skipped: no previous 'render' action in config (first deploy or post-rename)"));
      expect(skipped).toBeTruthy();
    });

    it('surfaces the real error (name + message, group, hashed_cid) when removal rejects', async () => {
      const lit = makeLit({
        removeActionFromGroup: vi.fn(async () => {
          throw new Error('HTTP 500: internal server error');
        }) as unknown as RemoveFn,
      });

      await removePreviousAction(
        lit as never,
        14,
        { name: 'render', cid: 'cidOld', hashedCid: '0xdeadbeef' },
        'render',
      );

      expect(lit.removeActionFromGroup).toHaveBeenCalledWith(14, '0xdeadbeef');
      const failed = errSpy.mock.calls
        .map((args: unknown[]) => args.join(' '))
        .find((line: string) => line.startsWith('removeActionFromGroup FAILED'));
      expect(failed).toBeTruthy();
      expect(failed).toContain('group=14');
      expect(failed).toContain('hashed_cid=0xdeadbeef');
      expect(failed).toContain('Error: HTTP 500: internal server error');
    });

    it('calls removeActionFromGroup with the old hashed cid on success', async () => {
      const lit = makeLit();

      await removePreviousAction(
        lit as never,
        14,
        { name: 'render', cid: 'cidOld', hashedCid: '0xdeadbeef' },
        'render',
      );

      expect(lit.removeActionFromGroup).toHaveBeenCalledWith(14, '0xdeadbeef');
      expect(errSpy).not.toHaveBeenCalled();
    });
  });
});
