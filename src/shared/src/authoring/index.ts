// ============================================================================
// Authoring — pure, host-agnostic logic shared by every authoring host
// (neutralpress Obsidian plugin, headless author-cli, …).
//
// Only reachable via the root barrel (`shared/src/index.ts`). Intentionally
// NOT re-exported from `./lit-actions` (INV-7: that entry stays dependency-
// light and zod-free — authoring pulls in yaml/marked/slugify).
// ============================================================================

export * from './tags';
export * from './note';
export * from './links';
export * from './revoke';
export * from './publication';
