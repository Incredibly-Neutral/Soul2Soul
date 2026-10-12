/**
 * The `src/content/_base.ts`, `_note.ts` and `_vault.ts` modules are fully
 * commented-out legacy code — they export nothing. This file pins that state:
 * the modules must still load (their imports resolve) and must expose no
 * runtime surface. If someone re-enables a broken import, this catches it.
 */

import { describe, it, expect } from 'vitest';
import * as base from '../../src/content/_base';
import * as note from '../../src/content/_note';
import * as vault from '../../src/content/_vault';

describe('legacy content modules (_base/_note/_vault)', () => {
	it('load cleanly and expose no exports (dead, commented-out source)', () => {
		expect(Object.keys(base)).toHaveLength(0);
		expect(Object.keys(note)).toHaveLength(0);
		expect(Object.keys(vault)).toHaveLength(0);
	});
});
