/**
 * Canned binary results — one per action, from SPEC-author-cli §Binary API reference, plus the
 * awkward shapes: the failure envelope, a degenerate `{}`, and a *future* result carrying
 * unknown scalars and an unknown nested object (open-shape rule: scalars pass through, nested
 * is dropped, nothing throws).
 */

export const NOTE = '/home/joera/notes/manuscript.md';
export const PUBLICATION = 'polyphony.soul2soul.eth';

export const uploadResult = {
  action: 'upload',
  note: NOTE,
  publication: PUBLICATION,
  subdomain: 'polyphony',
  objectId: '0x9f2c1a',
  kuboCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  ipfsUrl: 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  gatewayUrl: 'https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  frontmatterWritten: true,
} as const;

export const offerResult = {
  action: 'offer',
  note: NOTE,
  publication: PUBLICATION,
  subdomain: 'polyphony',
  objectId: '0x9f2c1a',
  kuboCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  txHash: '0x5d0e1c2b3a49586778899aabbccddeeff00112233445566778899aabbccddeeff',
} as const;

export const previewResult = {
  action: 'preview',
  note: NOTE,
  publication: PUBLICATION,
  subdomain: 'polyphony',
  objectId: '0x9f2c1a',
  kuboCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  render: {
    cid: 'bafkreirender000000000000000000000000000000000000000000000000',
    path: 'preview/manuscript/index.html',
    previewUrl: 'https://preview.soul2soul.eth/polyphony/manuscript',
  },
} as const;

export const publishResult = {
  action: 'publish',
  note: NOTE,
  publication: PUBLICATION,
  subdomain: 'polyphony',
  objectId: '0x9f2c1a',
  kuboCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  txHash: '0x5d0e1c2b3a49586778899aabbccddeeff00112233445566778899aabbccddeeff',
  render: {
    cid: 'bafkreirender000000000000000000000000000000000000000000000000',
    path: 'preview/manuscript/index.html',
    previewUrl: 'https://preview.soul2soul.eth/polyphony/manuscript',
    prodUrl: 'https://polyphony.soul2soul.eth/manuscript',
  },
} as const;

export const revokeResult = {
  action: 'revoke',
  note: NOTE,
  publication: PUBLICATION,
  subdomain: 'polyphony',
  objectId: '0x9f2c1a',
  txHash: '0x5d0e1c2b3a49586778899aabbccddeeff00112233445566778899aabbccddeeff',
  render: {
    cid: 'bafkreirender000000000000000000000000000000000000000000000000',
    path: 'preview/manuscript/index.html',
    previewUrl: 'https://preview.soul2soul.eth/polyphony/manuscript',
  },
} as const;

export const newPublicationResult = {
  action: 'new',
  name: 'polyphony',
  safeAddress: '0x1111111111111111111111111111111111111111',
  configCid: null,
  owners: [],
  authors: ['0x2222222222222222222222222222222222222222'],
  devRepository: 'joera/polyphony',
  branch: 'main',
  feed: '0x0000000000000000000000000000000000000000',
} as const;

export const authorAddressResult = {
  action: 'author.address',
  address: '0x3333333333333333333333333333333333333333',
  eoa: '0x4444444444444444444444444444444444444444',
  salt: 's2s_0x4444444444444444444444444444444444444444',
  chain: 'base',
  deployed: false,
} as const;

export const configPathResult = {
  path: '/home/joera/.config/s2s/config.json',
  env: {
    user: '/home/joera/.config/s2s/.env',
    userExists: true,
    project: '/home/joera/code/s2s/.env',
  },
} as const;

export const failureEnvelope = {
  ok: false,
  error: "missing rpcL2 — run 's2s config set rpcL2 <url>' or set S2S_RPC_L2",
} as const;

export const emptyResult = {} as const;

export const futureResult = {
  action: 'upload',
  note: NOTE,
  publication: PUBLICATION,
  subdomain: 'polyphony',
  objectId: '0x9f2c1a',
  kuboCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  frontmatterWritten: true,
  // Unknown scalars — must be passed through in the detail view.
  authorContract: '0x5555555555555555555555555555555555555555',
  authorGenesis: '0xgenesis-unknown',
  durabilityLegs: 3,
  degraded: false,
  // Unknown nested object — must be ignored, not fatal.
  tel: { spans: ['a', 'b'], sampled: true },
} as const;

/** A stdout blob where a progress line leaked into the document (see SPEC-author.md drift). */
export const contaminatedStdout =
  'uploading manuscript.md to kubo…\npinning via filecoin (best effort)\n' +
  JSON.stringify(uploadResult) +
  '\n✓ done\n';
