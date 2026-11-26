/// <reference path="../action_globals.ts" />

import { ActionResult, EvmUpdateData, EvmUpdateInput } from '@s2s/soul2soul-shared/lit-actions';
import { evmRead, evmWrite, toHexString, enableReadCache } from '../libs/evm';
import { getManifest } from '../libs/protocol.factory';
import { getDomainOwnerAndModules } from '../libs/ens.factory';
import { contenthashToIPFS } from '../libs/ipfs.factory';
import { fetchWithTimeout, requireFields, setRpcAuth } from '../libs/helpers';
import { canPublish, canReset, extractSignerAddress } from '../libs/gates';
import { getConfig } from '../render/config.ctrl';
import {
  verifyProvenance,
  sanitizeRemovePath,
  verifyRevocable,
  verifyPathAvailable,
  fetchPageHtml,
  identityOfText,
  type PageIdentity,
} from './verify';

const ACTION = 'evm-update';

// Why a publication with an unresolved module is refused. One sentence, because
// the two outcomes are one refusal to the caller: the factory answered and named
// nothing with code at it, or it did not answer at all (older builds have no
// `moduleAddress`). A failed read is not classified here — see
// libs/ens.factory.ts and GAP-15 — so the RPC cause is appended, not interpreted.
const MODULES_UNRESOLVED =
  'publication modules unresolved: the factory named no module with code at it, or did not answer moduleAddress at all, as an older factory cannot, so a publication from an earlier factory is refused';

const RECORDS_CONTRACT_ABI = [
  'function getText(bytes32 node, string key) view returns (string)',
  'function setText(bytes32 node, string key, string value) nonpayable',
  'function batchSetRecords(bytes32[] nodes, address[] addrs, string[][] keys, string[][] values) nonpayable',
];

// ZERO address for batchSetRecords' `addrs` array — we only set text records
// (the C3 contract skips the address write when addrs[i] == address(0)).
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Reserved auxiliary record key on the canonical publication node that tracks
// the currently-written alias NAMES (JSON array). It is NOT part of resolution
// (the resolver reads `contenthash_wrapped`); it only lets the next update
// clear aliases that have been removed from the list. The canonical node is
// never cleared by this mechanism.
const ALIASES_TRACKING_KEY = 'aliases';

/** Dedupe preserving first-seen order. */
const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];

/**
 * Resolve the ENS write-target node list from the publication config.
 *
 *   * `config.aliases` (non-empty array) → ADDITIVE: [namehash(publication),
 *     ...aliases.map(namehash)] — the canonical publication node is ALWAYS
 *     written; aliases are extra doors to the same contenthash.
 *   * `config.domain` only (legacy field, backward compatible) → SWAP:
 *     [namehash(domain)] — identical to the pre-aliases behaviour (single
 *     write at namehash(domain), canonical node untouched).
 *   * neither → [namehash(publication)] — the default subdomain target.
 */
function resolveWriteTargets(
  config: { domain?: string; aliases?: string[] } | null | undefined,
  publication: string,
): { nodes: string[]; isLegacyDomain: boolean } {
  const aliases =
    Array.isArray(config?.aliases) && (config!.aliases as string[]).length > 0
      ? (config!.aliases as string[]).filter((a) => typeof a === 'string' && a.trim() !== '')
      : undefined;
  if (aliases && aliases.length > 0) {
    return {
      nodes: dedupe([publication, ...aliases]).map((n) => ethers.utils.namehash(n)),
      isLegacyDomain: false,
    };
  }
  if (config && config.domain) {
    return { nodes: [ethers.utils.namehash(config.domain)], isLegacyDomain: true };
  }
  return { nodes: [ethers.utils.namehash(publication)], isLegacyDomain: false };
}

// MFS ops that move content INTO the remote data_gateway Kubo node (cp-root
// copies the whole previous tree; per-file/assets cp and pin-add fetch and
// persist blocks) legitimately take far longer than metadata ops against a
// remote node. 10s was aborting deterministic cp-root runs with a bare
// AbortError; 60s is the realistic bound for a remote gateway.
const TIMEOUTS = {
  mkdir: 5_000,
  cpRoot: 60_000,
  cpFile: 60_000,
  stat: 5_000,
  rm: 5_000,
  pinAdd: 60_000,
  pinLs: 5_000,
};

// A Kubo `files/ls?long=true` entry. Only `Type === 0` (a file) is mirrorable —
// directories are skipped. `files/ls` is flat, so a Name never contains a `/`.
interface TxtEntry {
  Name?: string;
  Type?: number;
  /** Pegged content hash when `long=true`; what `files/stat` used to answer. */
  Hash?: string;
}

/** Kubo's error body for a MFS path that is not there. */
const isMissingMfsPath = (body: string): boolean => /file does not exist/i.test(body);

/**
 * `files/ls` a directory in the temp tree.
 *
 * `null` means the directory does not exist (Kubo's "file does not exist") —
 * the normal case for a site with no `assets/txt`. EVERY other failure (401
 * from the token gate, 502, a timeout, an unparseable body) THROWS: a broken
 * call must never be read as "this site has no txt files", which would publish
 * a site with no /robots.txt — the exact failure this block prevents.
 */
async function lsMfsDir(gateway: string, dirPath: string): Promise<TxtEntry[] | null> {
  const res = await fetchWithTimeout(
    `${gateway}/api/v0/files/ls?arg=${encodeURIComponent(dirPath)}&long=true`,
    { method: 'POST' },
    TIMEOUTS.stat,
  );
  const body = await res.text();
  if (!res.ok) {
    if (isMissingMfsPath(body)) return null;
    throw `Failed to ls ${dirPath}: ${res.status} ${body}`;
  }
  let data: { Entries?: unknown };
  try {
    data = JSON.parse(body) as { Entries?: unknown };
  } catch {
    throw `Failed to ls ${dirPath}: unparseable body`;
  }
  return Array.isArray(data.Entries) ? (data.Entries as TxtEntry[]) : [];
}

/**
 * What `files/stat` says about ONE MFS file. Three outcomes, because a caller
 * must tell "the gateway says there is no such file" (write without an rm)
 * from "the gateway could not answer" (the caller knows more than the gateway
 * does here): a failed call is not an absent file, and a body without a Hash is
 * not an answer either.
 */
type MfsStat = { state: 'hash'; hash: string } | { state: 'absent' } | { state: 'unknown' };

async function statMfsFile(gateway: string, path: string): Promise<MfsStat> {
  try {
    const res = await fetchWithTimeout(
      `${gateway}/api/v0/files/stat?arg=${encodeURIComponent(path)}`,
      { method: 'POST' },
      TIMEOUTS.stat,
    );
    const body = await res.text();
    if (!res.ok) return isMissingMfsPath(body) ? { state: 'absent' } : { state: 'unknown' };
    let data: { Hash?: unknown };
    try {
      data = JSON.parse(body) as { Hash?: unknown };
    } catch {
      return { state: 'unknown' };
    }
    return typeof data.Hash === 'string' && data.Hash !== ''
      ? { state: 'hash', hash: data.Hash }
      : { state: 'unknown' };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * Why an `assets/txt` entry must never be written to — or removed from — the
 * tree root. `null` = safe.
 *
 * Root `index.html` is the site's front page, and this whole path bypasses the
 * provenance/path gate (the content is owner-controlled via `config.assetsCid`),
 * so it is never a txt target in any casing. A name that is not a single path
 * segment (`.`, `..`, or anything containing `/`) is refused before it can touch
 * a root path at all.
 */
function rootTxtSkipReason(name: string): string | null {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    return 'not a file name';
  }
  if (name.toLowerCase() === 'index.html') return 'root index.html is reserved';
  return null;
}

async function main(input: EvmUpdateInput): Promise<ActionResult<EvmUpdateData>> {
  let trace: any[] = [];

  try {
    requireFields(input, ['publication', 'jobs', 'signature', 'authorSafeAddress', 'endpoints']);
    // A revoke with no matching ripple produces jobs.length === 0 but still
    // carries a `remove` entry (the revoked path) that must be processed — do
    // NOT treat "no jobs" as "nothing to do". Only reject when there is neither
    // a job nor a remove entry nor a reset flag (nothing meaningful to write).
    const hasRemove = input.remove && input.remove.length > 0;
    if (!Array.isArray(input.jobs) || (input.jobs.length === 0 && !hasRemove && !input.reset))
      throw 'jobs must be a non-empty array when no remove entries or reset are provided';
    const { publication, jobs, signature, authorSafeAddress, preview, endpoints, remove, reset } =
      input;
    const gateway = endpoints.ipfsGateway;
    const rpcs = endpoints.rpcs;
    // One invocation, one 50-request session. Identical reads (the manifest, the
    // config, the gates, the previous pointer) share a request for the rest of
    // this run; see libs/evm.ts. Turned on before the first read so the prologue
    // is covered too.
    enableReadCache();
    // Auth for Kubo RPC on the data gateway (token-gated writes; sent on reads too).
    setRpcAuth(endpoints.ipfsGatewayAuth);

    const signerAddress = extractSignerAddress(
      ethers.utils.hashMessage('lit actions auth'),
      signature,
    );
    trace.push(`signer: ${signerAddress}`);
    trace.push(`pub: ${publication}`);

    // The manifest first: it carries the factory discovery asks, so the action
    // spends one document read rather than a separate record read plus this one.
    const protocolInfo = await getManifest(rpcs);
    const publicationFactory = protocolInfo.moduleFactory;

    let modules: Awaited<ReturnType<typeof getDomainOwnerAndModules>>;
    try {
      modules = await getDomainOwnerAndModules(publication, rpcs, publicationFactory);
    } catch (error) {
      throw `${MODULES_UNRESOLVED}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const { multisig, configModule, publicationModule } = modules;
    if (!multisig || !configModule || !publicationModule) {
      throw MODULES_UNRESOLVED;
    }

    trace.push(
      `owner: ${multisig}, configModule ${configModule}, publicationModule ${publicationModule}`,
    );

    const canonicalNode = ethers.utils.namehash(publication);

    // canPublish answers the same question for every page in the request, so it
    // is asked at most once however many pages are added. The PROMISE is what is
    // memoised: parallel jobs join the one in flight instead of each issuing the
    // same reads.
    let publishGate: Promise<boolean> | null = null;
    const mayPublish = (): Promise<boolean> => {
      if (!publishGate) {
        publishGate = canPublish(authorSafeAddress, publicationModule, signerAddress, rpcs?.L2);
      }
      return publishGate;
    };

    // Warm-up. One invocation is one 50-request session, and these reads are
    // independent of each other and of the decisions below, so they start here
    // and are awaited further down where the code used to make the calls: the
    // same requests go out, earlier, and every check and every error still
    // happens at the await, in the old order. Each promise carries a no-op catch
    // so a rejection that surfaces first somewhere else cannot become an
    // unhandled rejection — the await still throws it.
    //
    // mayPublish is deliberately NOT warmed: a refresh-only request never asks
    // it, and warming it would spend canPublish's reads on a run that the
    // per-page gate means to leave unasked.
    const resetGate: Promise<boolean> | null = reset
      ? canReset(multisig, signerAddress, rpcs?.L2)
      : null;
    const configPromise = getConfig(undefined, configModule, rpcs?.L2, gateway);
    // `nodes[0]` decides the contenthash_wrapped read and depends on the
    // config, so the write-target resolution rides on the config read rather
    // than waiting for the gate below.
    const writeTargetsPromise = configPromise.then((prevConfig) =>
      resolveWriteTargets(prevConfig, publication),
    );
    const prevEncodedPromise = writeTargetsPromise.then(({ nodes: writeNodes }) =>
      evmRead(
        'L2',
        protocolInfo.ensRecords,
        RECORDS_CONTRACT_ABI,
        'getText',
        [writeNodes[0], 'contenthash_wrapped'],
        rpcs?.L2,
      ),
    );
    // The alias-tracking record is keyed on the canonical node, not the write
    // targets, so it does not wait for the config read at all.
    const prevAliasesPromise = evmRead(
      'L2',
      protocolInfo.ensRecords,
      RECORDS_CONTRACT_ABI,
      'getText',
      [canonicalNode, ALIASES_TRACKING_KEY],
      rpcs?.L2,
    );
    for (const warm of [resetGate, configPromise, prevEncodedPromise, prevAliasesPromise]) {
      warm?.catch(() => undefined);
    }

    // A reset is publication-owner gated (stricter than canPublish): the signer
    // must be an owner of the publication Safe (`multisig`), not merely an owner
    // of a whitelisted author Safe. Everything else is gated PER PAGE in the
    // jobs loop: an ADD needs canPublish, a REFRESH of the page already at its
    // own path needs nothing (it introduces no path and displaces no page), and
    // a remove is a repair that verifyRevocable alone decides. A reset is the
    // one exception to the ADD rule: canReset already judged the signer, so the
    // pages a reset rebuilds are not asked about again.
    if (reset) {
      if (!(await resetGate)) {
        throw 'reset requires publication owner';
      }
    }

    if (!protocolInfo?.pkp) {
      throw 'Failed to fetch protocol info';
    }
    trace.push(`pinfo: ${protocolInfo}`);

    const config = await configPromise;
    trace.push(`config: ${config}`);

    // The WRITE nodes may differ from the publication identity: the config can
    // set either a legacy `domain` (single write-node override, backward
    // compatible) or a list of `aliases` (ADDITIVE — the canonical publication
    // node plus each alias). Only the write targets change here —
    // ownership/discovery (getDomainOwnerAndModules(publication),
    // canPublish/canReset) stays keyed on the original `publication` identity,
    // not the configured domain/aliases.
    const { nodes, isLegacyDomain } = await writeTargetsPromise;
    trace.push(`nodes: ${JSON.stringify(nodes)}`);

    // Read previous contenthash_wrapped on-chain (primary node) — the warmed
    // promise, awaited here exactly where the call used to be made.
    const prevEncoded = await prevEncodedPromise;
    trace.push(`prev: ${prevEncoded}`);

    // Read the previously-tracked alias names (auxiliary 'aliases' record on
    // the canonical publication node, JSON array) so a removed alias can be
    // cleared on the next update. Never throws — a missing/unparseable record
    // simply means there is nothing tracked yet (first run after upgrade).
    let prevAliases: string[] = [];
    try {
      const prevAliasJson = await prevAliasesPromise;
      const parsed = typeof prevAliasJson === 'string' ? JSON.parse(prevAliasJson) : null;
      if (Array.isArray(parsed)) {
        prevAliases = parsed.filter((a: unknown) => typeof a === 'string');
      }
    } catch {}

    const mfsPath = `/temp-${Date.now()}`;

    let newRootCid: string;

    // The run's stated base, when the caller names one. Compared through the
    // shared contenthash helpers, never as raw strings: the same tree spelled
    // as a CIDv0 (Qm…) and a CIDv1 (bafy…) is the same address.
    const baseCid = input.baseCid && input.baseCid !== '' ? input.baseCid : '';

    // A reset forces the fresh `mkdir` branch even when a previous root exists:
    // the old (confused) tree is never copied, so every page dir AND root
    // index.html vanish; assets are still re-copied below; the root is rewritten.
    const hasPrevRoot = Boolean(prevEncoded && prevEncoded.length > 0 && !reset);

    // Decode before anything is copied or written: a base mismatch is a
    // refusal, and the refusal must land before the temp tree is built. Only
    // the branches that read the previous tree decode it, except when a base
    // was stated — then the record is what the base is compared with.
    let prevCid = '';
    if (hasPrevRoot || (baseCid && prevEncoded && prevEncoded.length > 0)) {
      prevCid = contenthashToIPFS(prevEncoded);
    }

    if (baseCid) {
      let sameBase = false;
      try {
        sameBase = prevCid !== '' && toHexString(baseCid) === toHexString(prevCid);
      } catch {
        sameBase = false;
      }
      if (!sameBase) {
        throw (
          `base mismatch: this run's base is ${baseCid}, but the ` +
          `contenthash_wrapped record names ${prevCid || 'no tree'} — this run's ` +
          `base is not what is published; re-read the publication and retry.`
        );
      }
      trace.push(`base: ${baseCid} matches the published tree`);
    }

    if (hasPrevRoot) {
      trace.push(`cp root ${prevCid} → ${mfsPath}`);

      // The copy is a reference copy only when the node already holds the root.
      // If it does not, Kubo goes to the network and the request hangs until this
      // bound, which reads as a timeout rather than "this root is not here any
      // more". Say the second thing: the reader needs to know the tree has to be
      // rebuilt, and a bare timeout does not say that.
      try {
        await fetchWithTimeout(
          `${gateway}/api/v0/files/cp?arg=/ipfs/${prevCid}&arg=${encodeURIComponent(mfsPath)}&parents=true`,
          { method: 'POST' },
          TIMEOUTS.cpRoot,
        );
      } catch {
        throw `previous root ${prevCid} could not be copied within ${TIMEOUTS.cpRoot / 1000}s — this node does not hold it, so it has to be fetched from the network and does not arrive. The publication's tree has to be rebuilt: run reset (publication owner) against ${nodes[0]}, which starts from mkdir and writes a new contenthash.`;
      }
    } else {
      trace.push(`mkdir ${mfsPath}`);
      await fetchWithTimeout(
        `${gateway}/api/v0/files/mkdir?arg=${encodeURIComponent(mfsPath)}&parents=true`,
        { method: 'POST' },
        TIMEOUTS.mkdir,
      );
    }

    // Log what jobs we received
    console.log(
      `[update] jobs: ${JSON.stringify(jobs.map((j: any) => ({ id: j.id?.slice(0, 12), path: j.path, html: j.html?.slice(0, 12) })))}`,
    );

    // What is already at each page's destination. The destination is the page
    // FILE (`/index.html` inside the page's own directory), so the directory
    // listed here is the page's own: one `files/ls` per page, the same single
    // request the `files/stat` it replaced spent. It answers with every entry's
    // hash, which is the one thing the copy below needs before it can overwrite.
    const dirListings = new Map<string, Promise<Map<string, string>>>();
    const hashAt = async (path: string): Promise<string> => {
      const slash = path.lastIndexOf('/');
      const dir = slash <= 0 ? '/' : path.slice(0, slash);
      const name = path.slice(slash + 1);
      let listing = dirListings.get(dir);
      if (!listing) {
        listing = fetchWithTimeout(
          `${gateway}/api/v0/files/ls?arg=${encodeURIComponent(dir)}&long=true`,
          { method: 'POST' },
          TIMEOUTS.stat,
        )
          .then(async (res) => {
            const entries = new Map<string, string>();
            if (!res.ok) return entries;
            const body = (await res.json().catch(() => ({}))) as { Entries?: TxtEntry[] };
            for (const entry of body.Entries ?? []) {
              if (typeof entry.Name === 'string' && typeof entry.Hash === 'string') {
                entries.set(entry.Name, entry.Hash);
              }
            }
            return entries;
          })
          .catch(() => new Map<string, string>());
        dirListings.set(dir, listing);
      }
      return (await listing).get(name) ?? '';
    };

    // A tree with no previous root (or a reset) has nothing at any destination,
    // so the destination reads below are skipped rather than answered by a call.
    const treeIsFresh = !hasPrevRoot;
    // One `files/read` answers both questions about a destination — is a page
    // there, and which identity does it claim — where the identity read plus the
    // `files/ls` (or `files/stat`) cost two. `unknown` keeps an unreadable path
    // on the old path: the listing still decides, exactly as it did before.
    const readMfsText = async (
      path: string,
    ): Promise<{ state: 'present'; text: string } | { state: 'absent' } | { state: 'unknown' }> => {
      try {
        const res = await fetchWithTimeout(
          `${gateway}/api/v0/files/read?arg=${encodeURIComponent(path)}`,
          { method: 'POST' },
          30_000,
        );
        const text = await res.text();
        if (res.ok) return { state: 'present', text };
        return isMissingMfsPath(text) ? { state: 'absent' } : { state: 'unknown' };
      } catch {
        return { state: 'unknown' };
      }
    };

    // Copy delta jobs in parallel — blocks already on the kubo node
    let wrotePage = false;
    trace.push(`cp ${jobs.length} files`);
    await Promise.all(
      (jobs as any[]).map(async (job) => {
        // A revoked item re-renders from a stored body that has lost its slug,
        // so its path can be the template itself. There is no such directory to
        // write; the removal entry does the work.
        if (typeof job.path === 'string' && /\{[a-z_]+\}/i.test(job.path)) {
          trace.push(`skip cp ${job.path}: unresolved template placeholder`);
          return;
        }
        const filePath = job.path === 'index.html' ? 'index.html' : `${job.path}/index.html`;
        const destPath = `${mfsPath}/${filePath}`;
        const sourceCid = job.html;

        // A collection member's job id is synthetic (`bundle:key`); the signed
        // on-chain item — and the identifier addAndSignMetadata writes — is the
        // bundle genesis. Everything that compares against the page's written
        // identifier or asks the chain about the item uses it.
        const signerId = job.sourceId ?? job.id;

        // Per-page gate: classify the job by the page already at its
        // destination. The same identifier means this is a REFRESH — a new
        // render of the content item that owns the path — which needs no
        // permission: it can neither introduce a path nor displace another
        // author's page, and the provenance verification below requires a PKP
        // signature over the genesis named in job.sourceId (or job.id for a plain
        // page) and over the digest of the
        // body, so a refresh can only write the press's own render of that
        // genesis. Anything else is an ADD, and adding content to the
        // publication needs canPublish — unless the request is a reset, which
        // canReset (publication-Safe ownership) has already gated more strictly.
        // A preview writes nothing and is never a refresh, so it still needs
        // canPublish.
        //
        // The source page is cat'd once per job: the bytes verifyProvenance
        // checks are the bytes compared with the destination below.
        let existingPage: PageIdentity | null = null;
        // What the destination read found: its bytes when it is a page, and
        // whether it is there at all (`fresh` = the tree has nothing at any
        // path, `unknown` = the read failed and the listing still decides).
        let pageState: 'present' | 'absent' | 'unknown' | 'fresh' = 'fresh';
        let pageText = '';
        // A preview writes nothing and verifies nothing, so it never cats.
        const sourceHtml: Promise<string> = preview
          ? Promise.resolve('')
          : fetchPageHtml(gateway!, sourceCid);
        if (!preview) {
          // The fast path below can return before anyone awaits it; a run that
          // skips the page must not surface the rejected fetch.
          sourceHtml.catch(() => undefined);
          if (!treeIsFresh) {
            const read = await readMfsText(destPath);
            pageState = read.state;
            if (read.state === 'present') pageText = read.text;
          } else {
            pageState = 'absent';
          }
          existingPage = pageState === 'present' ? identityOfText(pageText) : null;
        }
        const isRefresh = !preview && existingPage?.identifier === signerId;
        if (isRefresh) {
          trace.push(`refresh: ${filePath}`);
        } else if (!reset && !(await mayPublish())) {
          throw 'cannot publish';
        }

        // Provenance verification gate — reject unverified content.
        // The gate RETURNS the page's self-description (identifier, claimed
        // author, canonicalisation, claimed body digest) so the tree rules below
        // can tell a content-bound JCS page from a legacy one whose signature
        // covers only a document skeleton.
        let incomingPageIdentity: PageIdentity | null = null;
        if (!preview) {
          try {
            incomingPageIdentity = await verifyProvenance(
              sourceCid,
              signerId,
              protocolInfo.pkp!,
              gateway!,
              trace,
              sourceHtml,
            );
          } catch (e) {
            throw `Rejected ${job.path}: provenance verify failed — ${typeof e === 'string' ? e : String(e)}`;
          }
        }

        // Decide the overwrite from the destination FILE itself.
        //
        // The destination read already answered whether a page is there and
        // whether its bytes are the source's. Where it did:
        //   * bytes differ  → a different CID follows, so rm then cp, no stat;
        //   * bytes equal   → stat decides: the same hash skips, a different
        //                     hash removes first, and an unanswerable stat also
        //                     removes first — the file was just read, so it is
        //                     there;
        //   * absent        → cp only;
        //   * unreadable    → the directory listing, exactly as before.
        // A PREVIEW has no destination read, so it stats the file it would
        // overwrite (a freshly built tree has nothing to stat).
        let skipCopy = false;
        let removeFirst = false;
        if (preview) {
          if (!treeIsFresh) {
            const stat = await statMfsFile(gateway!, destPath);
            if (stat.state === 'hash') {
              if (stat.hash === sourceCid) skipCopy = true;
              else removeFirst = true;
            } else if (stat.state === 'unknown') {
              // The empty hash that skipped the rm made the cp fail on a path
              // that is in fact occupied. Remove first instead.
              removeFirst = true;
            }
          }
        } else if (pageState === 'absent') {
          // Nothing there: cp only.
        } else if (pageState === 'present' && pageText !== (await sourceHtml)) {
          removeFirst = true;
        } else if (pageState === 'present') {
          const stat = await statMfsFile(gateway!, destPath);
          if (stat.state === 'hash') {
            if (stat.hash === sourceCid) skipCopy = true;
            else removeFirst = true;
          } else if (stat.state === 'unknown') {
            removeFirst = true;
          }
          // absent: cp only — the gateway says the path is free.
        } else {
          // The destination read could not decide: keep the listing fallback.
          const prevHash = await hashAt(destPath);
          if (prevHash && prevHash === sourceCid) skipCopy = true;
          else removeFirst = Boolean(prevHash);
        }

        // Fast path: the destination file already carries the source CID.
        if (skipCopy) {
          trace.push(`skip (unchanged): ${filePath}`);
          return;
        }

        // Path gate — ALWAYS, not only when something is already there: a
        // legacy-signed page must not be introduced onto a free path either
        // (its signature does not bind the body it publishes). See
        // verifyPathAvailable for the three rules.
        if (!preview) {
          await verifyPathAvailable(
            gateway!,
            destPath,
            signerId,
            publicationModule,
            rpcs?.L2,
            incomingPageIdentity,
            existingPage,
          );
        }

        // Remove existing entry so cp can overwrite
        if (removeFirst) {
          await fetchWithTimeout(
            `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(destPath)}`,
            { method: 'POST' },
            TIMEOUTS.rm,
          ).catch((e) => trace.push(`warn: rm failed ${filePath}: ${String(e)}`));
        }

        // Now cp works cleanly
        const url =
          `${gateway}/api/v0/files/cp?` +
          `arg=/ipfs/${encodeURIComponent(sourceCid)}` +
          `&arg=${encodeURIComponent(destPath)}` +
          `&parents=true&flush=false`;
        const res = await fetchWithTimeout(url, { method: 'POST' }, TIMEOUTS.cpFile);
        if (!res.ok) {
          const text = await res.text();
          throw `Failed to cp ${job.path}: ${text}`;
        }
        wrotePage = true;
        trace.push(`✓ ${filePath} (${sourceCid.slice(0, 9)})`);
      }),
    );

    // Remove explicitly listed paths (slug changes, revoked posts)
    if (remove && remove.length > 0) {
      trace.push(`rm ${remove.length} paths`);
      // Build a set of job genesis ids for the replacedBy check. A collection
      // member's job carries the bundle genesis as sourceId: the bundle was
      // updated even when its own postType mapped to no page of its own.
      const jobGenesisSet = new Set<string>();
      for (const job of jobs) {
        jobGenesisSet.add(job.id);
        if (job.sourceId) jobGenesisSet.add(job.sourceId);
      }
      await Promise.all(
        (remove as any[]).map(async (entry: { path: string; replacedBy?: string }) => {
          let cleanPath: string;
          try {
            cleanPath = sanitizeRemovePath(entry.path);
          } catch (e) {
            trace.push(`skip remove ${entry.path}: ${typeof e === 'string' ? e : String(e)}`);
            return;
          }

          // Validate: replacedBy must match a genesis in the incoming job set
          if (entry.replacedBy && !jobGenesisSet.has(entry.replacedBy)) {
            trace.push(
              `skip remove ${entry.path}: replacedBy genesis ${entry.replacedBy?.slice(0, 12)}… not in job set`,
            );
            return;
          }

          // Revoke (no replacedBy): verify no active deal before removing.
          // verifyRevocable reads the page once and re-asks ONLY the chain
          // question, so a lagging replica is retried without re-reading a
          // page that cannot have changed in between.
          if (!entry.replacedBy && !preview) {
            let refusal: unknown;
            try {
              await verifyRevocable(
                gateway!,
                mfsPath,
                cleanPath,
                publicationModule,
                rpcs?.L2,
                3,
                2000,
              );
            } catch (e) {
              refusal = e;
            }
            if (refusal !== undefined) {
              trace.push(
                `skip remove ${entry.path}: ${typeof refusal === 'string' ? refusal : String(refusal)}`,
              );
              return;
            }
          }

          const rmPath = `${mfsPath}/${cleanPath}`;
          let rmFailure: unknown;
          await fetchWithTimeout(
            `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(rmPath)}&recursive=true`,
            { method: 'POST' },
            TIMEOUTS.rm,
          ).catch((e) => {
            rmFailure = e;
          });
          // Only a call that returned is a removal. Claiming `removed:` after a
          // swallowed failure reported a no-op as success: the path stayed in
          // the tree and the caller printed a clean summary.
          if (rmFailure !== undefined) {
            trace.push(`✗ rm failed ${entry.path}: ${String(rmFailure)}`);
            return;
          }
          trace.push(`removed: ${entry.path}`);
        }),
      );
    }

    // Names of the root txt files the PREVIOUS tree carried: read the copied
    // tree's own assets/txt now, before the assets copy below replaces /assets
    // wholesale. A file that has since disappeared from the site repo — or a
    // config that has since lost its assetsCid — must not leave its copy at the
    // root forever. The listing is kept: when the assets are unchanged it IS the
    // new assets/txt listing, so the mirror does not ask for it twice.
    const assetsDestPath = `${mfsPath}/assets`;
    const txtDirPath = `${assetsDestPath}/txt`;
    const previousTxtEntries: TxtEntry[] | null = hasPrevRoot
      ? await lsMfsDir(gateway!, txtDirPath)
      : null;
    const previousRootTxtNames = new Set<string>();
    for (const entry of previousTxtEntries ?? []) {
      if (entry.Type === 0 && typeof entry.Name === 'string') previousRootTxtNames.add(entry.Name);
    }

    // The tree root, listed once. This one request answers every per-name
    // question below — does the name exist, is it a directory, is it already the
    // file we would copy — that used to cost one `files/stat` each. A failure is
    // not fatal and not a claim that the tree is empty: `null` sends every check
    // back to its own `files/stat` (occupantAt), so the outcome is unchanged.
    interface RootEntry {
      Type?: number | string;
      Hash?: string;
      Size?: number;
    }
    let rootEntries: Map<string, RootEntry> | null = null;
    try {
      const listed = await lsMfsDir(gateway!, mfsPath);
      rootEntries = new Map(
        (listed ?? [])
          .filter((e): e is TxtEntry & { Name: string } => typeof e.Name === 'string')
          .map((e) => [e.Name, { Type: e.Type, Hash: e.Hash }]),
      );
    } catch (e) {
      trace.push(`warn: root ls failed, checking names one by one: ${String(e)}`);
    }

    // An empty listing after work was written is a broken answer, not an empty
    // tree: a previous root was copied in, or a job wrote a page, so the root
    // holds at least that much. Discard it — every check then falls back to its
    // own `files/stat` and an unconditional rm, which is what it would have
    // done had the listing failed.
    if (rootEntries && rootEntries.size === 0 && (hasPrevRoot || wrotePage)) {
      trace.push('warn: root ls came back empty after writes, checking names one by one');
      rootEntries = null;
    }

    /** `files/stat` on a root name — the check every caller made before the listing. */
    const occupantAt = async (name: string): Promise<RootEntry | null> => {
      const res = await fetchWithTimeout(
        `${gateway}/api/v0/files/stat?arg=${encodeURIComponent(`${mfsPath}/${name}`)}`,
        { method: 'POST' },
        TIMEOUTS.stat,
      );
      if (!res.ok) return null;
      return (await res.json().catch(() => ({}))) as RootEntry;
    };

    // Copy assets into /assets
    const mirroredRootTxt = new Set<string>();
    if (config.assetsCid) {
      // The listed node IS this assets tree (same hash = same blocks): the rm +
      // cp would rebuild the node already there, so both are skipped and the
      // previous assets/txt listing is the new one. The listing is used only
      // for this positive fact — never to conclude that /assets is absent.
      const listedAssets = rootEntries?.get('assets');
      let txtEntries: TxtEntry[] | null;
      if (listedAssets && listedAssets.Hash === config.assetsCid) {
        trace.push(`✓ assets (${config.assetsCid.slice(0, 9)}) already in place`);
        txtEntries = previousTxtEntries;
      } else {
        trace.push(`cp assets ${config.assetsCid} → ${assetsDestPath}`);

        // Unconditional: a name the listing does not carry is not evidence
        // that /assets is absent, and removing a missing path is harmless.
        await fetchWithTimeout(
          `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(assetsDestPath)}&recursive=true`,
          { method: 'POST' },
          TIMEOUTS.rm,
        ).catch((e) => trace.push(`warn: rm assets failed: ${String(e)}`));
        const assetsUrl =
          `${gateway}/api/v0/files/cp?` +
          `arg=/ipfs/${encodeURIComponent(config.assetsCid)}` +
          `&arg=${encodeURIComponent(assetsDestPath)}` +
          `&parents=true&flush=false`;
        const assetsRes = await fetchWithTimeout(assetsUrl, { method: 'POST' }, TIMEOUTS.cpFile);
        if (!assetsRes.ok) {
          const text = await assetsRes.text();
          throw `Failed to cp assets: ${text}`;
        }
        trace.push(`✓ assets (${config.assetsCid.slice(0, 9)})`);

        txtEntries = await lsMfsDir(gateway!, txtDirPath);
        rootEntries?.set('assets', { Type: 1, Hash: config.assetsCid });
      }

      // Mirror every file in assets/txt (robots.txt, llms.txt, …) to the tree
      // ROOT, so the published site answers both /assets/txt/robots.txt and
      // /robots.txt. The DIRECTORY is the opt-in: any file in it is mirrored.
      if (txtEntries === null) {
        trace.push(`no ${txtDirPath}: no root txt files`);
      } else {
        for (const entry of txtEntries) {
          const txtName = typeof entry.Name === 'string' ? entry.Name : '';
          if (entry.Type !== 0) {
            trace.push(`skip root txt ${txtName}: not a file`);
            continue;
          }
          const reserved = rootTxtSkipReason(txtName);
          if (reserved) {
            trace.push(`skip root txt ${txtName}: ${reserved}`);
            continue;
          }

          const txtDestPath = `${mfsPath}/${txtName}`;
          // The root listing answers what the `files/stat` here used to ask,
          // but only as a POSITIVE fact. When the listing failed (or was
          // discarded) the same question is asked per name.
          const existing = rootEntries ? rootEntries.get(txtName) : await occupantAt(txtName);

          // A page whose slug is this name owns a DIRECTORY here. The page
          // wins: never rm recursively, never cp over it, never throw — the
          // prev tree is re-copied every run, so a wedge here never recovers.
          if (existing && (existing.Type === 1 || existing.Type === 'directory')) {
            trace.push(`skip root txt ${txtName}: a page occupies this path`);
            continue;
          }
          if (existing && typeof entry.Hash === 'string' && existing.Hash === entry.Hash) {
            // The root entry carries the same hash as the assets/txt file, so
            // the cp would write the bytes already there — the outcome of rm +
            // cp is this tree, unchanged, so neither is issued.
            trace.push(`✓ root txt ${txtName} (unchanged)`);
            mirroredRootTxt.add(txtName);
            continue;
          }

          // Kubo files/cp does not overwrite, and the previous-root copy may
          // have put last run's copy here. The rm is unconditional: a name the
          // listing does not carry is not evidence that the path is free, and
          // removing a missing path is harmless.
          await fetchWithTimeout(
            `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(txtDestPath)}`,
            { method: 'POST' },
            TIMEOUTS.rm,
          ).catch((e: unknown) => trace.push(`warn: rm root txt failed ${txtName}: ${String(e)}`));
          if (existing) trace.push(`rm existing root ${txtName}`);

          trace.push(`cp root txt ${txtName}`);
          const txtUrl =
            `${gateway}/api/v0/files/cp?` +
            `arg=${encodeURIComponent(`${txtDirPath}/${txtName}`)}` +
            `&arg=${encodeURIComponent(txtDestPath)}` +
            `&parents=false&flush=false`;
          const cpTxt = () => fetchWithTimeout(txtUrl, { method: 'POST' }, TIMEOUTS.cpFile);
          let txtRes = await cpTxt();
          if (!txtRes.ok) {
            // A path that was taken (a directory the listing did not show, a
            // race) rejects the cp. Clear the path and retry once; a second
            // failure reports the ORIGINAL error.
            const firstError = await txtRes.text();
            await fetchWithTimeout(
              `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(txtDestPath)}`,
              { method: 'POST' },
              TIMEOUTS.rm,
            ).catch((e: unknown) =>
              trace.push(`warn: rm root txt failed ${txtName}: ${String(e)}`),
            );
            txtRes = await cpTxt();
            if (!txtRes.ok) throw `Failed to cp root txt ${txtName}: ${firstError}`;
          }
          trace.push(`✓ root txt ${txtName}`);
          mirroredRootTxt.add(txtName);
          rootEntries?.set(txtName, { Type: 0, Hash: entry.Hash });
        }
      }
    }

    // Stale root txt: a name the previous tree put at the root that is no
    // longer in assets/txt — or that has no assets at all any more — must not
    // linger. Non-recursive on purpose: where a page now owns the path it is a
    // directory, the rm fails and is traced; a page is never deleted to clear a
    // txt file, and a failed rm is never fatal. The rm is unconditional: a name
    // the listing does not carry is not proof the path is gone, and removing a
    // missing path is harmless.
    for (const oldName of previousRootTxtNames) {
      if (mirroredRootTxt.has(oldName)) continue;
      const reserved = rootTxtSkipReason(oldName);
      if (reserved) {
        trace.push(`skip stale root txt ${oldName}: ${reserved}`);
        continue;
      }
      const stalePath = `${mfsPath}/${oldName}`;
      try {
        const staleRes = await fetchWithTimeout(
          `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(stalePath)}`,
          { method: 'POST' },
          TIMEOUTS.rm,
        );
        if (staleRes.ok) {
          rootEntries?.delete(oldName);
          trace.push(`rm stale root ${oldName}`);
        } else {
          trace.push(`warn: rm stale root ${oldName} failed: ${await staleRes.text()}`);
        }
      } catch (e) {
        trace.push(`warn: rm stale root ${oldName} failed: ${String(e)}`);
      }
    }

    // What the root now holds, from the listing that replaced the per-name
    // stats and the debug `files/ls`: printed, not read again. A failed listing
    // already said so above, and re-listing to print it would spend the request
    // this change exists to save.
    if (rootEntries) {
      const entries = [...rootEntries.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
      console.log(
        `[update] MFS tree at ${mfsPath}: ` +
          entries.map(([name, e]) => (e.Type === 1 ? `${name}/` : name)).join(' '),
      );
    }

    // Wrap in try/finally so temp always cleans up (even on evmWrite failure)
    newRootCid = '';

    try {
      // New root CID
      const statRes = await fetchWithTimeout(
        `${gateway}/api/v0/files/stat?arg=${encodeURIComponent(mfsPath)}`,
        { method: 'POST' },
        TIMEOUTS.stat,
      );
      newRootCid = (await statRes.json()).Hash;
      trace.push(`root: ${newRootCid}`);

      await fetchWithTimeout(
        `${gateway}/api/v0/pin/add?arg=${newRootCid}`,
        { method: 'POST' },
        TIMEOUTS.pinAdd,
      ).then(async (res) => {
        if (!res.ok) {
          throw `pin/add ${newRootCid} failed: ${res.status} ${await res.text()}`;
        }
      });

      if (!preview) {
        const encoded = toHexString(newRootCid);
        trace.push(`writing ${encoded} to ${nodes.length} node(s)`);

        // The current alias NAMES (canonical publication name excluded) —
        // persisted to the canonical node's auxiliary 'aliases' record so the
        // next update can clear aliases removed from the list. The legacy
        // `domain` path tracks nothing (keeps today's single-node behaviour).
        const newAliases = isLegacyDomain ? [] : (config?.aliases ?? []);

        // Clear-on-removal: any alias that was previously written but is no
        // longer in the new list gets an EMPTY contenthash_wrapped so it stops
        // resolving instead of going stale (C3 has no delete — an empty value
        // is what getText returns for an unset record). The canonical
        // publication node is NEVER cleared by this mechanism.
        const clearNodes = dedupe(
          prevAliases.filter((a) => !newAliases.includes(a)).map((a) => ethers.utils.namehash(a)),
        ).filter((n) => n !== canonicalNode);
        if (clearNodes.length > 0) {
          trace.push(`clearing ${clearNodes.length} removed alias node(s)`);
        }

        // ONE atomic batchSetRecords tx: contenthash on every write node, '' on
        // every removed-alias node, plus the alias-tracking record on the
        // canonical node. Single tx → single nonce → no parallel evmWrite race
        // (libs/evm.ts nonce race + silent-success footgun is avoided by never
        // issuing parallel writes from the same PKP).
        const allNodes = dedupe([...nodes, ...clearNodes]);
        const addrs = allNodes.map(() => ZERO_ADDRESS);
        const keys = allNodes.map(() => ['contenthash_wrapped'] as string[]);
        const values = allNodes.map((n) =>
          clearNodes.includes(n) ? ([''] as string[]) : ([encoded] as string[]),
        );

        // Persist the current alias list on the canonical node (only when it is
        // a write target — the legacy `domain` path keeps today's single write).
        const canonicalIdx = allNodes.indexOf(canonicalNode);
        if (canonicalIdx !== -1) {
          keys[canonicalIdx] = ['contenthash_wrapped', ALIASES_TRACKING_KEY];
          values[canonicalIdx] = [encoded, JSON.stringify(newAliases)];
        }

        const result = await evmWrite(
          'L2',
          protocolInfo.pkp,
          protocolInfo.ensRecords,
          RECORDS_CONTRACT_ABI,
          'batchSetRecords',
          [allNodes, addrs, keys, values],
          true,
          rpcs?.L2?.[0],
        );
        trace.push(JSON.stringify(result));
        // The on-chain write is the whole point of this action — a failed or
        // reverted contenthash_wrapped write must NEVER be reported as success
        // (the app would show the fresh root while the on-chain record is
        // unchanged). Fail loudly for ALL update writes (normal publishes and
        // reset) so the caller can surface the real cause.
        if (!result?.success) {
          return {
            ok: false,
            action: ACTION,
            error: 'contenthash_wrapped write failed: ' + (result?.error ?? 'unknown error'),
            trace,
          };
        }
      }

      return { ok: true, action: ACTION, data: { cid: newRootCid, trace }, trace };
    } finally {
      // Always clean up temp MFS path
      await fetchWithTimeout(
        `${gateway}/api/v0/files/rm?arg=${encodeURIComponent(mfsPath)}&recursive=true`,
        { method: 'POST' },
        TIMEOUTS.rm,
      ).catch(() => trace.push(`warn: cleanup failed`));
    }
  } catch (e) {
    return { ok: false, action: ACTION, error: typeof e === 'string' ? e : String(e), trace };
  }
}

export { main };
