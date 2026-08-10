import {
  cleanTemplateString,
  fetchPartialsSourceMap,
  processTemplate,
  replacePartials,
} from './handlebars.factory';

/**
 * FETCHING half of the render pipeline (production only).
 *
 * All gateway/network work lives here: DAG-get the template array, locate the
 * template file for `templateConfig.file`, cat its source, and collect the
 * partial file listing. Returns the raw template source plus the partial file
 * metadata (path/cid) — partial CONTENT is resolved by the caller via
 * `fetchPartialsSourceMap`.
 *
 * Returns `null` on any validation failure or non-OK gateway response.
 */
export const fetchTemplateBundle = async (config: any, templateConfig: any, gateway?: string) => {
  // Validate inputs
  if (!config?.templateCid || !templateConfig?.file) {
    console.error('Missing required config:', {
      templateCid: config?.templateCid,
      file: templateConfig?.file,
    });
    return null;
  }

  // Fetch template array
  const response = await fetch(`${gateway}/api/v0/dag/get?arg=${config.templateCid}`, {
    method: 'POST',
  });

  if (!response.ok) {
    console.error('Template fetch failed:', response.status, response.statusText);
    return null;
  }

  const templateArray = await response.json();
  const templateFile = templateArray.find(
    (t: any) =>
      t.path.endsWith(`/${templateConfig.file}.handlebars`) ||
      t.path.endsWith(`/${templateConfig.file}`),
  );

  if (!templateFile?.cid) {
    console.error('Template file not found:', templateConfig.file);
    return null;
  }

  // Fetch template content
  const templateResponse = await fetch(`${gateway}/api/v0/cat?arg=${templateFile.cid}`, {
    method: 'POST',
  });

  if (!templateResponse.ok) {
    console.error(
      'Template content fetch failed:',
      templateResponse.status,
      templateResponse.statusText,
    );
    return null;
  }

  const templateSource = await templateResponse.text();

  // Find and process partials
  const partials = templateArray.filter(
    (t: any) => t.path.includes('partials/') && t.path.endsWith('.handlebars'),
  );

  return { templateSource, partials };
};

/**
 * PURE render: turns injected template/partial SOURCE into HTML.
 *
 * No gateway, no fetch, no CIDs, no decrypt, no sign. All inputs are injected:
 * `templateSource` (the main template handlebars source), `partialsSourceMap`
 * (`{ name -> source }`), and `templateData`. This is the shared core used by
 * BOTH production `renderHTML` and the dev render action, so preview ≈
 * production by construction.
 */
export const renderHTMLFromSource = (
  templateSource: string,
  partialsSourceMap: { [key: string]: string },
  templateData: any,
): string => {
  try {
    // Clean and process template
    const template = cleanTemplateString(templateSource)
      .replace(/^\"/, '') // Remove leading quote if present
      .replace(/\"$/, '') // Remove trailing quote if present
      .replace(/(?<=>)\"/g, '') // Remove quotes after >
      .replace(/\"(?=<)/g, ''); // Remove quotes before <

    if (!template) {
      console.error('Empty template after cleaning');
      return '';
    }

    // Substitute partials from the injected source map, then run templating
    const result = replacePartials(template, partialsSourceMap, templateData);

    if (!result) {
      console.error('Empty result after processing');
      return '';
    }

    // Clean up whitespace and remove any characters preceding DOCTYPE
    let cleanedResult = result
      .replace(/\n{2,}/g, '\n')
      .replace(/>\s+</g, '>\n<')
      .trim();

    // Remove any characters before <!DOCTYPE - this includes asterisks and other unexpected characters
    const doctypePattern = /<!DOCTYPE/i;
    const doctypeMatch = doctypePattern.exec(cleanedResult);

    if (doctypeMatch && doctypeMatch.index > 0) {
      // Remove everything before the DOCTYPE declaration
      cleanedResult = cleanedResult.substring(doctypeMatch.index);
    }

    return cleanedResult;
  } catch (error) {
    console.error('Error in renderer:', error);
    return '';
  }
};

export const renderHTML = async (
  config: any,
  templateConfig: any,
  templateData: any,
  gateway?: string,
) => {
  try {
    // Fetch step (production-only, gateway-bound)
    const bundle = await fetchTemplateBundle(config, templateConfig, gateway);
    if (!bundle) return '';

    // Resolve partial CIDs -> source map via the gateway (NOT in the pure path)
    const partialsSourceMap = await fetchPartialsSourceMap(bundle.partials, gateway);

    // Pure render step from injected sources
    return renderHTMLFromSource(bundle.templateSource, partialsSourceMap, templateData);
  } catch (error) {
    console.error('Error in renderer:', error);
    return '';
  }
};
