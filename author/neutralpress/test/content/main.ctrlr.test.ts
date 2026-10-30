/**
 * Unit tests for MainController.isValidForPublishing (src/main.ctrlr.ts).
 *
 * The method is a pure guard (`TFile` instance + `.base`/`.md` extension)
 * with no dependencies on the controller's constructor side effects, so we
 * invoke it off the prototype rather than constructing a full MainController
 * (which would spin up oxo-init polling).
 */

import { describe, it, expect } from 'vitest';
import { MainController } from '../../src/main.ctrlr';
import { TFile } from 'obsidian';

function isValid(file: any): boolean {
	return (MainController.prototype as any).isValidForPublishing.call({}, file);
}

function tfile(path: string): TFile {
	const f = new TFile();
	f.path = path;
	return f;
}

describe('MainController.isValidForPublishing', () => {
	it('accepts .md files', () => {
		expect(isValid(tfile('/vault/notes/hello.md'))).toBe(true);
	});

	it('accepts .base files', () => {
		expect(isValid(tfile('/vault/bases/data.base'))).toBe(true);
	});

	it('rejects other extensions and extensionless files', () => {
		expect(isValid(tfile('/vault/note.txt'))).toBe(false);
		expect(isValid(tfile('/vault/readme'))).toBe(false);
	});

	it('rejects null/undefined', () => {
		expect(isValid(null)).toBe(false);
		expect(isValid(undefined)).toBe(false);
	});

	it('rejects plain objects that are not TFile instances', () => {
		expect(isValid({ path: '/vault/a.md' })).toBe(false);
	});
});
