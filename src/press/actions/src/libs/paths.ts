// Where an item's page lands in the publication tree — one implementation,
// imported by the render action (which writes the page) and by prep (which
// reports the same path so a removal targets a page that exists).

import { S2SBody, S2STemplateConfig } from '@s2s/soul2soul-shared/lit-actions';

/**
 * `localePaths[locale] ?? localePaths.default ?? ''` plus the template path,
 * with `{slug}` substituted for a plaintext item. Returns `/` for a template
 * with no path.
 */
export const createPath = (
  body: S2SBody,
  templateConfig: S2STemplateConfig,
  localePaths?: Record<string, string>,
): string => {
  if (templateConfig.path == null) return '/';
  const prefix = localePaths ? (localePaths[body.locale] ?? localePaths.default ?? '') : '';

  let path = prefix + templateConfig.path;

  if (!body.encryption && body.slug && path.includes('{slug}')) {
    path = path.replace('{slug}', body.slug);
  }

  return path;
};
