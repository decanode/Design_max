import { markdownToPm, pmText, type PmNode } from '../docgen/pm.js';

interface Row { content_json?: PmNode | null; content_md?: string | null; content_text?: string | null }

/** The structured content of a stored version. Legacy rows only have Markdown; they are converted on read. */
export const versionPm = (r: Row): PmNode => r.content_json ?? markdownToPm(r.content_md ?? r.content_text ?? '');
export const versionText = (r: Row): string => r.content_text ?? (r.content_json ? pmText(r.content_json) : r.content_md ?? '');

/** Columns to store for new content, from either Markdown (generators, API) or structured content (editor). */
export function toStored(content: string | PmNode): { json: PmNode; text: string } {
  const json = typeof content === 'string' ? markdownToPm(content) : content;
  return { json, text: typeof content === 'string' ? content : pmText(content) };
}
