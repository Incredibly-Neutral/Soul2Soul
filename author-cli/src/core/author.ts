// ============================================================================
// Author write path — the CLI port of neutralpress' publishToPublication.
//
// Flow (upload/publish):  parse note → buildSignedContentItem (shared) →
//   Kubo upload (2-space JSON to match the Filecoin CAR rootCid) →
//   on-chain makeOffer → frontmatter write-back → durability legs.
//
// Flow (revoke):          on-chain retract FIRST (author-caller path, fully
//   withdraws), then a remove-plumbing re-render so the revoked path stops
//   resolving on the production site.
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';

import {
  buildSignedContentItem,
  parseMarkdownNote,
  renderwithLitActions,
  revokedPathFor,
  runFilecoinLeg,
  subdomainOf,
  toDidEthr,
  toPreviewLabel,
} from '@s2s/soul2soul-shared';
import type { ParsedNote } from '@s2s/soul2soul-shared';
import type { Address } from 'viem';

import { createFilecoinStorage } from '../adapters/filecoin';
import { KUBO_CID_KEY, resolveKuboCid, upsertFrontmatter } from '../lib/frontmatter';
import { UsageError } from '../lib/errors';
import { authorSafeState } from './author-safe';
import { requireSetting } from './config';
import { assertCiphertext, buildEncryptFn, fetchStoredItem } from './encrypt';
import { ipfsUri } from '../lib/ipfs-link';
import type { CliContext } from './context';
import { PublicationService } from './service';

// ===========================================================================
// Shared result types
// ===========================================================================

export interface RenderOutcome {
  cid: string;
  path: string;
  /** ipfs://<rootCid>/<path> style human-readable preview link. */
  previewUrl: string;
  /** Production ENS-based link (publish only). */
  prodUrl: string | undefined;
  /** ipfs://<rootCid> gateway-agnostic link. */
  ipfsUrl: string;
}

export interface AuthorWriteResult {
  /** Stable on-chain identity (genesis objectId). */
  objectId: string;
  /** Kubo root CID of the signed content JSON. */
  kuboCid: string;
  /** Publication ENS name (e.g. name.soul2soul.eth). */
  publication: string;
  subdomain: string;
  /** makeOffer transaction hash on L2 — present only when the run offered on-chain. */
  txHash: string | undefined;
  /** Present when the command ran the render pipeline. */
  render: RenderOutcome | undefined;
  /** Whether the note file's frontmatter was updated. */
  frontmatterWritten: boolean;
}

export interface AuthorWriteOptions {
  /** Run the render pipeline (preview or prod depending on publish). */
  render: boolean;
  /** true → live prod update (prod render + durability pins); false → preview render only. */
  publish: boolean;
  /** true → also append the on-chain makeOffer. `upload`/`preview` stay off-chain. */
  offer: boolean;
  /** Revocation remove entries (render path only). */
  remove?: { path: string; replacedBy?: string }[];
  /**
   * Allow replacing a previously-encrypted genesis with a plaintext body
   * (`--allow-plaintext`). Without it, a republish that drops `encryption: true`
   * is refused — see `guardEncryptionDowngrade`.
   */
  allowPlaintext?: boolean;
}

// ===========================================================================
// Author flow
// ===========================================================================

/**
 * Parse, sign, upload, and append a note to a publication. `render` runs the
 * preview/prod render pipeline; `publish` gates which one. Durability
 * (Pinata/Filebase/Filecoin) is fired fire-and-forget on real uploads.
 */
export async function authorWrite(
  ctx: CliContext,
  notePath: string,
  publication: string,
  opts: AuthorWriteOptions,
): Promise<AuthorWriteResult> {
  const raw = readFileSync(notePath, 'utf8');
  const parsed = await parseMarkdownNote(raw, notePath);

  // Resolve the encrypt function FIRST, before any chain/IPFS work: a note with
  // `encryption: true` and no usable Lit key/PKP must fail closed with a usage
  // error, not upload a plaintext (or error-string) body. `upload`, `preview`
  // and `publish` all land here, so this one place covers them. (`propose` does
  // not re-sign: it verifies the target item instead — see proposeContent.)
  const encryptFn = buildEncryptFn(ctx, parsed, notePath);

  // Refuse a silent downgrade (encrypted genesis → plaintext body).
  await guardEncryptionDowngrade(ctx, parsed, notePath, opts);

  // The author id is the author Safe, not the EOA — that is what the plugin
  // writes (`did:ethr:${author.safe}`) and what the manuscript's owner is.
  // The proof.signer inside the item still records the EOA that signed it.
  // Resolved before the service so an on-chain append can be sent by the Safe.
  const author = await authorSafeState(ctx);
  if (!author.deployed) {
    ctx.out.warn(
      `author Safe ${author.address} is not deployed — run \`s2s author init\` (the id is still valid, but nothing can verify ownership yet)`,
    );
  }

  // `upload` is off-chain: the publication contributes only its name, which is
  // derived locally. Resolving the Safe + modules is needed to offer on-chain
  // or to render — so a publication that does not exist yet (or an ENS name
  // with no address record) must not block an upload.
  const needsChain = opts.offer || opts.render;
  const service = needsChain
    ? await PublicationService.init(
        {
          l1: ctx.l1,
          l2: ctx.l2,
          l2Runner: ctx.l2Runner,
          ensRegistry: ctx.ensRegistry,
          ipfs: ctx.ipfs,
          // Only the append is an author write, and it must carry the Safe as
          // msg.sender — so the bundler-backed runner is only built when the
          // run actually offers on chain.
          ...(opts.offer
            ? { author: { address: author.address, runner: await ctx.authorRunner() } }
            : {}),
        },
        publication,
      )
    : undefined;
  const subdomain = service?.subdomain ?? subdomainOf(publication);

  const now = Math.floor(Date.now() / 1000);
  const custom = { ...parsed.custom };
  if (parsed.summary !== undefined) custom.summary = parsed.summary;

  const signedItem = await buildSignedContentItem(
    {
      specVersion: '1',
      postType: parsed.postType,
      mediaType: 'text/markdown',
      parent: String(parsed.parent),
      position: String(parsed.position),
      publication: subdomain,
      locale: parsed.locale,
      createdAt: now,
      base: parsed.slug,
      tags: parsed.tags,
      attributes: undefined,
    },
    { title: parsed.title, slug: parsed.slug, content: parsed.content, custom },
    ctx.signer,
    encryptFn,
    toDidEthr(author.address),
  );

  const objectId = parsed.genesis ?? signedItem.objectId;
  // 2-space JSON.stringify is load-bearing: filecoin-pin builds the CAR from
  // the same serialized bytes, so Kubo CID == Filecoin rootCid (CID parity).
  const kuboCid = await ctx.ipfs.addToKubo(JSON.stringify(signedItem, null, 2), 'content.json');
  ctx.out.log(`✓ uploaded ${kuboCid} (${objectId.slice(0, 12)}… → ${subdomain})`);

  // On-chain append only when asked (`propose`/`publish`). A bare `upload`
  // stays off-chain — ipfs + pins only; the offer is a separate step.
  let txHash: string | undefined;
  if (opts.offer) {
    if (!service) throw new Error('internal: on-chain offer requested without a resolved publication');
    txHash = await service.makeOffer(objectId, kuboCid);
    ctx.out.log(`✓ proposed ${objectId.slice(0, 12)}… → ${subdomain} (tx ${txHash.slice(0, 12)}…)`);
  }

  // Frontmatter write-back: genesis+author on first publish; modified_date and
  // the last upload's CID always (the CID is what `propose` offers on-chain).
  const updates: Record<string, string> = {
    modified_date: new Date().toISOString().slice(0, 19),
    [KUBO_CID_KEY]: kuboCid,
  };
  if (!parsed.genesis) {
    updates.genesis = objectId;
    updates.author = signedItem.public.author;
  }
  const frontmatterWritten = writeNoteFrontmatter(notePath, updates);

  // Durability — real upload/publish only (never preview-only renders).
  if (opts.publish) {
    scheduleDurability(ctx, publication, signedItem, kuboCid, author.address);
  }

  let render: RenderOutcome | undefined;
  if (opts.render) {
    if (!service) throw new Error('internal: render requested without a resolved publication');
    // The render action's `authorSafeAddress` is the AUTHOR Safe (neutralpress
    // passes `user.safe`); passing the publication Safe makes the action check
    // `isOwner` on the wrong contract.
    render = await renderContent(ctx, service, publication, objectId, author.address, opts);
  }

  return {
    objectId,
    kuboCid,
    publication,
    subdomain,
    txHash,
    render,
    frontmatterWritten,
  };
}

export interface ProposeResult {
  /** Stable on-chain identity (frontmatter `genesis`, else `content_id`). */
  objectId: string;
  /** The CID anchored on-chain. */
  kuboCid: string;
  /** Publication ENS name (e.g. name.soul2soul.eth). */
  publication: string;
  subdomain: string;
  /** makeOffer transaction hash on L2. */
  txHash: string;
}

/**
 * On-chain offer only — the `propose` step split out of `upload`. The content
 * must already be on IPFS (run `upload` first: it writes `genesis` and
 * `kubo_cid` back to the note). `kuboCid` is the explicit `--cid` when given,
 * else the CID `upload` stored in the note's frontmatter. No re-upload, no
 * render, no durability, no frontmatter write.
 */
export async function proposeContent(
  ctx: CliContext,
  notePath: string,
  publication: string,
  kuboCidFlag: string | undefined,
  opts: { allowPlaintext?: boolean } = {},
): Promise<ProposeResult> {
  const raw = readFileSync(notePath, 'utf8');
  const parsed = await parseMarkdownNote(raw, notePath);

  const objectId = parsed.genesis ?? parsed.contentId;
  if (!objectId) {
    throw new UsageError(
      `cannot propose ${notePath}: no on-chain identity (frontmatter \`genesis\` or \`content_id\`). Run \`s2s author upload\` first.`,
    );
  }

  const kuboCid = resolveKuboCid(kuboCidFlag, parsed.frontmatter);
  if (!kuboCid) {
    throw new UsageError(
      `cannot propose ${notePath}: no content CID (no \`--cid\` given and no \`${KUBO_CID_KEY}\` in the frontmatter). Run \`s2s author upload\` first, or pass --cid.`,
    );
  }

  // `propose` anchors an EXISTING CID, so the note's flag is not what gets
  // published — the stored item is. Both directions are checked, before any
  // chain call:
  //   - note says encrypted: the anchored item (`--cid` included) must itself
  //     declare `body.encryption: true` and carry a decryptable body;
  //   - note says plaintext: the previous revision of the same genesis must
  //     not have been encrypted (the same question `upload` asks, same guard —
  //     otherwise `propose --cid <plaintext>` re-opens the downgrade).
  await guardEncryptionDowngrade(ctx, parsed, notePath, opts);
  if (parsed.encryption) {
    await assertStoredItemEncrypted(ctx, kuboCid, notePath);
  }

  // The write is sent by the author Safe: the module keys genesisAuthor and the
  // whitelist on it, and the plugin does the same (`user.safe`).
  const author = await authorSafeState(ctx);
  if (!author.deployed) {
    throw new UsageError(
      `cannot propose ${notePath}: the author Safe ${author.address} is not deployed — run \`s2s author init\` first`,
    );
  }
  warnOnAuthorMismatch(ctx, notePath, parsed.frontmatter.author, author.address);

  const service = await PublicationService.init(
    {
      l1: ctx.l1,
      l2: ctx.l2,
      l2Runner: ctx.l2Runner,
      ensRegistry: ctx.ensRegistry,
      ipfs: ctx.ipfs,
      author: { address: author.address, runner: await ctx.authorRunner() },
    },
    publication,
  );

  const txHash = await service.makeOffer(objectId, kuboCid);
  ctx.out.log(`✓ proposed ${objectId.slice(0, 12)}… → ${service.subdomain} (tx ${txHash.slice(0, 12)}…)`);

  return {
    objectId,
    kuboCid,
    publication,
    subdomain: service.subdomain,
    txHash,
  };
}

// ===========================================================================
// Encryption guards on existing content
// ===========================================================================

/**
 * Refuse to propose a CID whose stored item is plaintext when the note asks for
 * encryption. Also refuses an item that cannot be read or whose encrypted body
 * does not meet the read-path contract — proposing either would anchor
 * something the render path cannot decrypt.
 */
async function assertStoredItemEncrypted(
  ctx: CliContext,
  kuboCid: string,
  notePath: string,
): Promise<void> {
  const stored = await fetchStoredItem(ctx.ipfs, kuboCid, notePath);
  if (!stored.encryption) {
    throw new UsageError(
      `refusing to propose ${notePath}: ${kuboCid} declares \`encryption: false\` but the note has \`encryption: true\`. Re-upload the note (\`s2s author upload\`) so the offered CID is encrypted.`,
    );
  }
  if (stored.body === undefined) {
    throw new UsageError(
      `refusing to propose ${notePath}: ${kuboCid} says \`encryption: true\` but has no string body`,
    );
  }
  assertCiphertext(stored.body);
}

/**
 * Refuse to republish or re-offer a genesis as plaintext when its previous
 * revision was encrypted.
 *
 * `parsed.encryption` only reflects the CURRENT frontmatter, so a dropped,
 * renamed or mistyped key would put a plaintext body where a ciphertext one
 * was. This guard is load-bearing precisely because the two revisions are NOT
 * distinguishable from the outside: `plaintextHash` is computed over the
 * canonical plaintext before `encryptFn` runs
 * (`shared/src/identity/sign-content.ts:53-73`), so both revisions share
 * `objectId`, `plaintextHash` and therefore the author's signature — only
 * `body` and `body.encryption` differ. The previous item's flag is the only
 * trustworthy record; it is read from the CID the last upload recorded.
 *
 * Everything that prevents the check from happening FAILS CLOSED, and the
 * failure says which of the three situations it is: no recorded CID (least is
 * known — a note with an identity but no `kubo_cid` can hide an encrypted
 * revision), a CID that does not resolve (a stale/hand-edited `kubo_cid`), or a
 * gateway that is unreachable/slow. `fetchFromKubo` is an ordinary HTTPS call to
 * `ctx.config.kuboGateway` (repo default `ipfs.transport-union.dev`) bounded by
 * the shared 60s `MFS_TIMEOUTS.cp` — that ceiling is on the now-blocking
 * default path, and it cannot be shortened from here because `fetchFromKubo`
 * takes no signal/options; a client-side race would only leak the pending
 * fetch. No retry is attempted. `--allow-plaintext` is the escape hatch for all
 * three (a confirmed downgrade, or a read the author cannot complete plus a
 * deliberate decision to proceed).
 *
 * The one silent path is a note with no identity at all (`genesis` or
 * `content_id`): there is no previous revision, so there is nothing to compare
 * against.
 */
async function guardEncryptionDowngrade(
  ctx: CliContext,
  parsed: ParsedNote,
  notePath: string,
  opts: { allowPlaintext?: boolean },
): Promise<void> {
  if (parsed.encryption || opts.allowPlaintext) return;

  // The identity is what makes "a previous revision" a meaningful idea. Legacy
  // notes carry `content_id` instead of `genesis`; both are keyed here so a
  // plaintext re-publish through either route is checked.
  const identity = parsed.genesis ?? parsed.contentId;
  if (typeof identity !== 'string' || identity.trim() === '') return;

  const recordedCid = parsed.frontmatter[KUBO_CID_KEY];
  const previousCid = typeof recordedCid === 'string' ? recordedCid.trim() : '';
  if (previousCid === '') {
    // Least is known in this state, so it is not a warning: a note with an
    // identity but no recorded CID can hide an encrypted previous revision, and
    // the warning channel is stderr, which the plugin never renders on a
    // success envelope.
    throw new UsageError(
      `refusing to publish ${notePath}: identity ${identity} has no recorded \`${KUBO_CID_KEY}\`, so the previous revision cannot be checked for encryption and this note has \`encryption: false\`. Re-add the CID, restore \`encryption: true\`, or pass --allow-plaintext to publish a plaintext revision anyway.`,
    );
  }

  let stored: Awaited<ReturnType<typeof fetchStoredItem>>;
  try {
    stored = await fetchStoredItem(ctx.ipfs, previousCid, notePath);
  } catch (err) {
    // `fetchFromKubo` throws "Failed to fetch from IPFS: <status>" for a non-2xx
    // answer and the AbortSignal error for the (60s, shared MFS_TIMEOUTS.cp)
    // ceiling — different problems, different remedies.
    const detail = describePreviousReadFailure(err);
    throw new UsageError(
      `refusing to publish ${notePath}: could not read the previous revision ${previousCid} of identity ${identity} to check whether it is encrypted — ${detail.reason}. This note has \`encryption: false\`, so publishing could replace a ciphertext body with plaintext. ${detail.remedy}`,
    );
  }
  if (stored.encryption) {
    throw new UsageError(
      `refusing to republish ${notePath}: the previous item ${previousCid} for identity ${identity} is encrypted, and this note has \`encryption: false\` — that would publish the body in the clear. Restore \`encryption: true\`, or pass --allow-plaintext if the downgrade is intentional.`,
    );
  }
}

/**
 * Split a failed previous-revision read into a cause and the remedy for it.
 *
 * The read is the now-blocking default path, so a stale CID (author error, fix
 * the note), a gateway fault and a timeout (environment, retry later or accept
 * the risk) must not be reported as the same thing.
 *
 * Limit of the classification: it can only use the HTTP status and the abort
 * signal, because `S2SIPFSMethods.fetchFromKubo` discards the response body
 * (`shared/src/ipfs/index.ts:337-342`). A Kubo 500 whose body says "block was
 * not found locally" is therefore reported as a gateway fault; surfacing it as
 * a stale CID needs that body, which is a `shared/` change.
 */
function describePreviousReadFailure(err: unknown): { reason: string; remedy: string } {
  const message = err instanceof Error ? err.message : String(err);

  const status = /Failed to fetch from IPFS:\s*(\d{3})\b/.exec(message)?.[1] ?? '';
  if (status.startsWith('4')) {
    return {
      reason: `the recorded \`${KUBO_CID_KEY}\` does not resolve (${message})`,
      remedy: `Fix or remove the stale \`${KUBO_CID_KEY}\` in the frontmatter, then re-run.`,
    };
  }
  if (/abort|timeout/i.test(message)) {
    return {
      reason: `the gateway read timed out (${message})`,
      remedy: 'Re-run once the gateway is responsive, or pass --allow-plaintext if you accept a plaintext revision.',
    };
  }
  return {
    reason: `the gateway could not be reached (${message})`,
    remedy: 'Re-run once the gateway is reachable, or pass --allow-plaintext if you accept a plaintext revision.',
  };
}

// ===========================================================================
// Render pipeline
// ===========================================================================

async function renderContent(
  ctx: CliContext,
  service: PublicationService,
  publication: string,
  objectId: string,
  authorSafeAddress: Address,
  opts: AuthorWriteOptions,
): Promise<RenderOutcome> {
  const signature = await ctx.signer.signMessage('lit actions auth');
  const litUsageKey = requireSetting(ctx.config.litUsageKey, 'LIT_USAGE_KEY');

  const res = await renderwithLitActions(
    !opts.publish,
    ctx.lit,
    signature,
    litUsageKey,
    ctx.protocolInfo,
    null,
    authorSafeAddress,
    publication,
    [objectId],
    undefined,
    ctx.rpcs,
    undefined,
    opts.remove !== undefined && opts.remove.length > 0 ? opts.remove : undefined,
    undefined,
    ctx.config.kuboToken ? `Bearer ${ctx.config.kuboToken}` : undefined,
  );

  if (!res.success) {
    throw new Error(`render failed: ${String(res.error ?? 'unknown render error')}`);
  }
  const cid = res.cid;
  if (!cid) {
    throw new Error('render reported success but produced no root CID');
  }

  const previewUrl = `https://${toPreviewLabel(cid)}.ipfs.transport-union.dev/${res.path}`;
  const ipfsUrl = `${ipfsUri(cid)}/${res.path}`;
  const prodUrl = opts.publish ? `https://${publication}/${res.path}` : undefined;

  return { cid, path: res.path, previewUrl, ipfsUrl, prodUrl };
}

// ===========================================================================
// Durability
// ===========================================================================

/**
 * Fire-and-forget 4-way backup: Kubo (done in authorWrite) + Filebase + Pinata
 * remote pins + Filecoin hot-storage leg. Failures are surfaced as warnings on
 * stderr — never fatal to the append.
 */
function scheduleDurability(
  ctx: CliContext,
  publication: string,
  signedItem: unknown,
  kuboCid: string,
  /** The author Safe — the Filecoin piece's author attribution, not the EOA. */
  authorSafe: Address,
): void {
  void (async () => {
    try {
      const result = await ctx.ipfs.backupToProviders(kuboCid, {
        providers: ['filebase', 'pinata'],
        filecoin: (_cid) =>
          runFilecoinLeg(
            'article',
            async () => {
              const storage = await createFilecoinStorage(ctx.config);
              if (!storage) {
                throw new Error(
                  'Filecoin storage not configured — set S2S_FILECOIN_SESSION_KEY or S2S_FILECOIN_PRIVATE_KEY',
                );
              }
              // The Filecoin CAR is keyed by the publication's Safe, so this is
              // the one durability leg that needs on-chain resolution. Resolve
              // it here (not up front) so an upload to a publication that does
              // not exist yet still completes its pins.
              const service = await PublicationService.init(
                {
                  l1: ctx.l1,
                  l2: ctx.l2,
                  l2Runner: ctx.l2Runner,
                  ensRegistry: ctx.ensRegistry,
                  ipfs: ctx.ipfs,
                },
                publication,
              );
              return storage.uploadJson(
                signedItem,
                // Both identities, and both Safes: the piece is attributed to the
                // publication and to the author — never to the signing EOA.
                [service.getMultiSig(), authorSafe],
                'article',
              );
            },
            {
              onFailure: (message) => {
                ctx.out.warn(`Filecoin backup failed: ${message}`);
              },
            },
          ),
        onFilecoinMismatch: (rootCid) => {
          ctx.out.warn(
            `Filecoin CID mismatch: kubo ${kuboCid.slice(0, 12)}… ≠ filecoin ${rootCid.slice(0, 12)}…`,
          );
        },
      });
      if (!result.filebase && !result.pinata && result.filecoin !== 'ok') {
        ctx.out.warn('no backup provider confirmed the content');
      }
    } catch (err) {
      ctx.out.warn(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

// ===========================================================================
// Revoke
// ===========================================================================

export interface RevokeResult {
  /** On-chain genesis of the revoked content. */
  objectId: string;
  /** Publication ENS name (e.g. name.soul2soul.eth). */
  publication: string;
  subdomain: string;
  /** retract transaction hash on L2. */
  txHash: string;
  /** Result of the remove-plumbing re-render. */
  render: RenderOutcome | undefined;
}

/**
 * Revoke a publication's content on-chain FIRST (author-caller path fully
 * withdraws from deals and/or offers), then re-render the removed path so the
 * production site stops resolving it.
 */
export async function revokeContent(
  ctx: CliContext,
  notePath: string,
  publication: string,
): Promise<RevokeResult> {
  const raw = readFileSync(notePath, 'utf8');
  const parsed = await parseMarkdownNote(raw, notePath);
  const genesis = parsed.genesis;
  if (!genesis) {
    throw new Error(`note ${notePath} has no genesis — nothing to revoke on-chain`);
  }

  // `retract` is authorized as the genesis author, i.e. the author Safe.
  const author = await authorSafeState(ctx);
  warnOnAuthorMismatch(ctx, notePath, parsed.frontmatter.author, author.address);

  const service = await PublicationService.init(
    {
      l1: ctx.l1,
      l2: ctx.l2,
      l2Runner: ctx.l2Runner,
      ensRegistry: ctx.ensRegistry,
      ipfs: ctx.ipfs,
      author: { address: author.address, runner: await ctx.authorRunner() },
    },
    publication,
  );
  const authorSafeAddress = author.address;

  // 1. Retract first — removes the version from deals/offers.
  const txHash = await service.retract(genesis);
  ctx.out.log(`✓ retracted ${genesis.slice(0, 12)}… (tx ${txHash.slice(0, 12)}…)`);

  // 2. Remove-plumbing re-render so the published site stops resolving it.
  const localePaths = await service.localePathsOf();
  const removePath = revokedPathFor(parsed.slug, parsed.locale, localePaths);
  ctx.out.log(`removing ${removePath} from the rendered tree…`);

  const render = await renderContent(
    ctx,
    service,
    publication,
    genesis,
    authorSafeAddress,
    { render: true, publish: true, offer: false, remove: [{ path: removePath }] },
  );

  return {
    objectId: genesis,
    publication,
    subdomain: service.subdomain,
    txHash,
    render,
  };
}

// ===========================================================================
// Internal helper
// ===========================================================================

/**
 * The frontmatter `author:` is the author Safe (`did:ethr:0x…`). A note whose
 * recorded author is a different address can still be *uploaded*, but the module
 * will only accept the write from its `genesisAuthor`, so say so up front rather
 * than let `OnlySafe()` explain it after a failed send.
 */
function warnOnAuthorMismatch(
  ctx: CliContext,
  notePath: string,
  declaredAuthor: unknown,
  authorSafe: Address,
): void {
  if (typeof declaredAuthor !== 'string') return;
  const declared = declaredAuthor.replace(/^did:ethr:/i, '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(declared)) return;
  if (declared.toLowerCase() === authorSafe.toLowerCase()) return;
  ctx.out.warn(
    `note ${notePath} records author ${declared}, but this machine's author Safe is ${authorSafe} — the module only accepts writes from the genesis author`,
  );
}

function writeNoteFrontmatter(notePath: string, updates: Record<string, string>): boolean {
  const raw = readFileSync(notePath, 'utf8');
  const next = upsertFrontmatter(raw, updates);
  if (next === raw) return false;
  writeFileSync(notePath, next, 'utf8');
  return true;
}
