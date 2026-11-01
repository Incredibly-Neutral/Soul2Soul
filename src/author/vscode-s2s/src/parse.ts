/**
 * Pure stdout → result-object parsing.
 *
 * The binary promises "stdout carries exactly one document", but its fire-and-forget
 * durability legs can leak human progress onto stdout (SPEC-author.md §Known drift). So:
 * strict first, locate second. The locate path is a bridge, not the contract — if the leak
 * is fixed binary-side, delete `locateObject` and the `contaminated` flag.
 *
 * No `vscode` import. Plain values in, plain values out.
 */

export type ResultObject = Record<string, unknown>;

export type ParseOutcome =
  | { kind: 'result'; result: ResultObject; contaminated: boolean }
  | { kind: 'failure'; message: string };

/** Raw stdout larger than this is not a result, it is a runaway. */
export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

/** Bound the number of `{` positions we will try before giving up. */
const MAX_CANDIDATES = 64;

function isPlainObject(value: unknown): value is ResultObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shape test used only when *locating* an object inside contaminated stdout: a JSON object
 * is a result if it names an action or is a failure envelope.
 */
function looksLikeResult(value: unknown): value is ResultObject {
  if (!isPlainObject(value)) return false;
  return typeof value['action'] === 'string' || value['ok'] === false;
}

function tryParseObject(text: string): ResultObject | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  // A clean document is trusted as-is: `{}` is a degenerate but legitimate open shape.
  return isPlainObject(parsed) ? parsed : undefined;
}

/**
 * Find the end index (`}` inclusive) of the object starting at `start`, honouring strings and
 * escapes. Returns -1 when unbalanced or when nesting exceeds `maxDepth`.
 */
function matchBrace(text: string, start: number, maxDepth = 64): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') {
      depth += 1;
      if (depth > maxDepth) return -1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function locateObject(text: string): ResultObject | undefined {
  let attempts = 0;
  let cursor = text.indexOf('{');

  while (cursor !== -1 && attempts < MAX_CANDIDATES) {
    attempts += 1;
    const end = matchBrace(text, cursor);
    if (end !== -1) {
      const candidate = tryParseObject(text.slice(cursor, end + 1));
      if (looksLikeResult(candidate)) return candidate;
    }
    cursor = text.indexOf('{', cursor + 1);
  }

  return undefined;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function parseResult(stdout: string): ParseOutcome {
  const text = stdout.trim();

  if (text.length === 0) {
    return {
      kind: 'failure',
      message: 's2s printed nothing on stdout — is `s2s.bin` really the s2s binary?',
    };
  }

  const bytes = byteLength(text);
  if (bytes > MAX_STDOUT_BYTES) {
    return {
      kind: 'failure',
      message: `s2s printed ${bytes} bytes on stdout, far more than a result — not a JSON document`,
    };
  }

  const direct = tryParseObject(text);
  if (direct !== undefined) return { kind: 'result', result: direct, contaminated: false };

  const located = locateObject(text);
  if (located !== undefined) return { kind: 'result', result: located, contaminated: true };

  return {
    kind: 'failure',
    message: `s2s printed ${bytes} bytes on stdout but none of it is a JSON result — is \`s2s.bin\` really the s2s binary?`,
  };
}
