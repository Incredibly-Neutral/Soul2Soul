import { describe, expect, it } from 'vitest';

import { TOP_LEVEL_CONTENT_VERBS, authorCommands, findAuthorCommand } from '../src/commands/index';
import { upload } from '../src/commands/upload';
import { offer } from '../src/commands/offer';
import { preview } from '../src/commands/preview';
import { publish } from '../src/commands/publish';
import { revoke } from '../src/commands/revoke';
import type { CommandSpec } from '../src/lib/command';

/**
 * The bare `s2s <verb>` names are an alias for the `s2s author <verb>` form.
 * The list is the alias's single source, so this pins both its exact contents
 * and the fact that every entry resolves, through the same registry, to the
 * very command object the group form reaches.
 */
describe('top-level content verbs', () => {
  const groupForm: Record<string, CommandSpec> = { upload, offer, preview, publish, revoke };

  it('is exactly the five content verbs', () => {
    expect(TOP_LEVEL_CONTENT_VERBS).toEqual(['upload', 'offer', 'preview', 'publish', 'revoke']);
  });

  it('resolves every name to the same command as the author group', () => {
    for (const name of TOP_LEVEL_CONTENT_VERBS) {
      const command = findAuthorCommand(name);
      expect(command).toBe(groupForm[name]);
      expect(authorCommands).toContain(command);
      expect(command?.params).toBe('<note>');
    }
  });
});
