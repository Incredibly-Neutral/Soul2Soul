import { S2SJob } from "../../rendering";

export type ActionResult<T> =
  | { ok: true;  action: string; data: T }
  | { ok: false; action: string; error: string };

export interface PrepInput  { publication: string; contentIds: string[]; configCid?: string }
export interface PrepData   { jobs: S2SJob[] }