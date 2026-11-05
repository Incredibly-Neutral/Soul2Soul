// ============================================================================
// Action entry graphs — the invariant that keeps Lit Action bundles loadable.
//
// The action build (press/scripts/lit/build-actions.cjs) marks `ethers`, the
// node builtins and `@lit-protocol/*` as esbuild `external`, because a Lit
// Action isolate has no CommonJS `require`. Any module reachable from one of
// these entries that statically imports an external therefore compiles to a
// top-level `__require(...)` and the whole bundle dies at load with
//
//   Dynamic require of "ethers" is not supported
//
// — a bare `{error}` body from the node, with no action code running at all.
// That is precisely what `import { utils } from 'ethers'` in the identity
// modules did. ethers is a RUNTIME GLOBAL inside an action (and
// rendering/sequence.ts publishes it as one for Node callers); reach for it
// through identity/ethers-ambient.ts, never through an import.
//
// Pure hashing does not need it either: keccak comes from @noble/hashes, which
// bundles.
//
// This test walks the source graph, so it fails at PR time and names the file,
// instead of at publish time with an opaque node error.
// ============================================================================
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const SRC = resolve(__dirname);

/** The shared entry points that get bundled into a Lit Action. */
const ACTION_ENTRIES = ['lit-actions.ts', 'gates/index.ts', 'rendering/action-io.ts'];

/** Externals in the action build: importing one emits a `require` the isolate cannot run. */
const FORBIDDEN = new Set([
  'ethers',
  'crypto',
  'stream',
  'buffer',
  'util',
  'fs',
  'path',
  'node:crypto',
  'node:stream',
  'node:buffer',
  'node:util',
  'node:fs',
  'node:path',
]);

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*['"]([^'"]+)['"]/g;

function resolveSpecifier(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Resolution {
  /** relative file → the bare specifiers it imports */
  bare: Map<string, string[]>;
  unresolved: string[];
}

function walk(entry: string): Resolution {
  const bare = new Map<string, string[]>();
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const queue = [resolve(SRC, entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_RE)) {
      const spec = match[1];
      if (spec.startsWith('.')) {
        const target = resolveSpecifier(file, spec);
        if (target) queue.push(target);
        else unresolved.push(`${relative(SRC, file)} → ${spec}`);
        continue;
      }
      const list = bare.get(relative(SRC, file)) ?? [];
      list.push(spec);
      bare.set(relative(SRC, file), list);
    }
  }

  return { bare, unresolved };
}

describe('action entry graphs (INV-7)', () => {
  for (const entry of ACTION_ENTRIES) {
    it(`${entry} reaches no external import`, () => {
      const { bare, unresolved } = walk(entry);

      expect(unresolved, `unresolvable relative imports from ${entry}`).toEqual([]);

      const offenders = [...bare.entries()]
        .flatMap(([file, specs]) =>
          specs
            .filter((spec) => FORBIDDEN.has(spec) || spec.startsWith('node:'))
            .map((spec) => `${file} imports '${spec}'`),
        )
        .sort();

      expect(
        offenders,
        'a static import of an action-build external becomes a require() and breaks the bundle',
      ).toEqual([]);
    });
  }
});
