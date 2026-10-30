// ============================================================================
// Renderer input types — what the press is asked to build.
//
// S2STemplateData is one page's worth of data handed to a template; S2SJob is
// the unit of work the prep action emits and the render action consumes. Both
// are press vocabulary: they describe a build, not a publication's design
// (that is ../publication) and not the authored thing (that is ../manuscript).
// ============================================================================

import type { S2STemplateConfig } from '../publication/types';

// ============================================================================
// Template Data
// ============================================================================

export interface S2STemplateData {
  id: string;
  controller: string;
  tags: string[];
  parent: number;
  language: string;
  position: number;
  encrypted: string;
  postType: string;
  publications: string[];
  collections?: any;
  path: string;
  base?: string;
  custom: any;
  content: string;
  creationDate: string;
  modifiedDate: string;
}

export interface S2SJob {
  id: string;
  templateConfig: S2STemplateConfig;
  path?: string;
  templateData?: S2STemplateData;
  html: string;
  revoked?: boolean;
}
