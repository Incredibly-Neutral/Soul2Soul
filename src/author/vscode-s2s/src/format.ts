/**
 * Pure result formatting: result object → summary lines / detail rows.
 *
 * Consumes the known fields from SPEC-author-cli's Binary API reference and nothing else.
 * Open-shape rule: known fields are rendered; extra *scalars* are passed through in the detail
 * view; unknown nested objects are ignored; nothing is ever fatal.
 *
 * No `vscode` import — this is the unit-test target.
 */

export type ResultObject = Record<string, unknown>;

export interface Summary {
  /** Sanity check: what the binary says it did. */
  action: string | undefined;
  /** One line: verb + subject + duration. */
  title: string;
  /** Up to three identity lines that matter for this action. */
  lines: string[];
  /** The only URL that may be opened — always a `render.*` value the binary returned. */
  url: string | undefined;
  /** Value the UI may copy when the user opted into it. */
  copy: string | undefined;
}

const VERBS: Record<string, string> = {
  upload: 'uploaded',
  offer: 'offered',
  preview: 'previewed',
  publish: 'published',
  revoke: 'revoked',
  new: 'created publication',
  'author.address': 'author address',
  'author.init': 'author safe',
  'config.set': 'config set',
  'config.get': 'config get',
  'config.unset': 'config unset',
  'config.list': 'config list',
  'config.path': 'config path',
};

/** Display order for the detail view; anything not listed is appended alphabetically. */
const KNOWN_ORDER = [
  'action',
  'note',
  'publication',
  'subdomain',
  'objectId',
  'kuboCid',
  'ipfsUrl',
  'gatewayUrl',
  'txHash',
  'safeAddress',
  'configCid',
  'address',
  'eoa',
  'salt',
  'chain',
  'deployed',
  'frontmatterWritten',
  'render',
  'name',
  'owners',
  'authors',
  'devRepository',
  'branch',
  'feed',
  'key',
  'value',
  'file',
  'local',
  'path',
  'env',
  'error',
] as const;

const KNOWN = new Set<string>(KNOWN_ORDER);

function isPlainObject(value: unknown): value is ResultObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string we are willing to show: present and non-empty. */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function scalarText(value: string | number | boolean): string {
  if (typeof value === 'string') return value;
  return String(value);
}

export function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '';
  if (durationMs < 1000) return ` · ${Math.round(durationMs)}ms`;
  return ` · ${(durationMs / 1000).toFixed(1)}s`;
}

function renderField(result: ResultObject, key: string): string | undefined {
  const render = result['render'];
  return isPlainObject(render) ? str(render[key]) : undefined;
}

/** The result's own verb, for the summary line. */
function verbFor(action: string | undefined, result: ResultObject): string {
  if (action !== undefined) {
    const known = VERBS[action];
    if (known !== undefined) return known;
  }
  if (result['ok'] === false) return 's2s failed';
  return action ?? 's2s result';
}

/** Subject of the sentence: the note basename when the binary named one. */
function subjectFor(result: ResultObject): string {
  const note = str(result['note']);
  if (note !== undefined) return basename(note);
  return str(result['name']) ?? str(result['key']) ?? '';
}

/**
 * Per-action identity lines. Deliberately terse: the detail view carries everything.
 */
function identityLines(action: string | undefined, result: ResultObject): string[] {
  const lines: string[] = [];

  switch (action) {
    case 'upload': {
      const cid = str(result['kuboCid']);
      if (cid !== undefined) lines.push(`kubo cid  ${cid}`);
      break;
    }
    case 'offer': {
      const cid = str(result['kuboCid']);
      if (cid !== undefined) lines.push(`kubo cid  ${cid}`);
      const tx = str(result['txHash']);
      if (tx !== undefined) lines.push(`offer tx  ${tx}`);
      break;
    }
    case 'preview': {
      const url = renderField(result, 'previewUrl');
      if (url !== undefined) lines.push(`preview  ${url}`);
      break;
    }
    case 'publish': {
      const url = renderField(result, 'prodUrl') ?? renderField(result, 'previewUrl');
      if (url !== undefined) lines.push(`published  ${url}`);
      const tx = str(result['txHash']);
      if (tx !== undefined) lines.push(`offer tx  ${tx}`);
      break;
    }
    case 'revoke': {
      const tx = str(result['txHash']);
      if (tx !== undefined) lines.push(`revoke tx  ${tx}`);
      break;
    }
    case 'new': {
      const safe = str(result['safeAddress']);
      if (safe !== undefined) lines.push(`safe  ${safe}`);
      const config = str(result['configCid']);
      if (config !== undefined) lines.push(`config cid  ${config}`);
      break;
    }
    case 'author.address':
    case 'author.init': {
      const address = str(result['address']);
      if (address !== undefined) lines.push(`safe  ${address}`);
      if (action === 'author.init') {
        const tx = str(result['txHash']);
        lines.push(tx === undefined ? 'safe  already deployed' : `deploy tx  ${tx}`);
      }
      break;
    }
    default: {
      for (const key of ['key', 'value', 'path', 'file'] as const) {
        const value = result[key];
        if (isScalar(value)) lines.push(`${key}  ${scalarText(value)}`);
      }
      break;
    }
  }

  // Context line, when the binary resolved a publication for us.
  const publication = str(result['publication']);
  if (publication !== undefined && lines.length < 3) lines.push(`publication  ${publication}`);

  return lines.slice(0, 3);
}

function openableUrl(action: string | undefined, result: ResultObject): string | undefined {
  if (action === 'preview') return renderField(result, 'previewUrl');
  if (action === 'publish')
    return renderField(result, 'prodUrl') ?? renderField(result, 'previewUrl');
  return undefined;
}

export function formatResult(result: ResultObject, options: { durationMs?: number } = {}): Summary {
  const action = str(result['action']);

  if (result['ok'] === false) {
    return {
      action,
      title: formatFailure(result),
      lines: [],
      url: undefined,
      copy: undefined,
    };
  }

  const subject = subjectFor(result);
  const head = `${verbFor(action, result)}${subject.length > 0 ? ` ${subject}` : ''}`;

  return {
    action,
    title: `${head}${formatDuration(options.durationMs)}`,
    lines: identityLines(action, result),
    url: openableUrl(action, result),
    copy: action === 'upload' ? str(result['kuboCid']) : undefined,
  };
}

/** The failure envelope's `error`, verbatim — it is written for humans and points at the fix. */
export function formatFailure(result: ResultObject): string {
  return str(result['error']) ?? 's2s reported a failure without an error message';
}

/**
 * Detail view rows: known fields in a fixed order, `render.*` flattened, then extra scalars
 * alphabetically. Unknown nested objects are skipped (open-shape rule).
 */
export function detailRows(result: ResultObject): string[] {
  const rows: string[] = [];

  for (const key of KNOWN_ORDER) {
    const value = result[key];
    if (value === undefined) continue;

    if (key === 'render') {
      if (!isPlainObject(value)) continue;
      for (const renderKey of ['cid', 'path', 'previewUrl', 'prodUrl']) {
        const renderValue = value[renderKey];
        if (isScalar(renderValue)) rows.push(`render.${renderKey}: ${scalarText(renderValue)}`);
      }
      continue;
    }

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      rows.push(`${key}: ${value.map((item) => scalarText(String(item))).join(', ')}`);
      continue;
    }

    if (isScalar(value)) rows.push(`${key}: ${scalarText(value)}`);
  }

  const extras = Object.keys(result)
    .filter((key) => !KNOWN.has(key))
    .filter((key) => isScalar(result[key]))
    .sort();

  for (const key of extras) {
    const value = result[key];
    if (isScalar(value)) rows.push(`${key}: ${scalarText(value)}`);
  }

  return rows;
}
