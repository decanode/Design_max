import type { Fetcher } from '../etl/types.js';
import type { EmbedItem } from '../etl/vectorize.js';

export interface SharePointConfig { accessToken: string; driveId: string; folderPath?: string; fetch?: Fetcher }

const TEXT_EXT = /\.(md|txt|html?|csv|json)$/i;

/**
 * Ingests text-based SOPs from a SharePoint drive via Microsoft Graph.
 * Binary formats (PDF/DOCX) need a text-extraction step and are reported as skipped.
 */
export async function extractSharePoint(cfg: SharePointConfig): Promise<{ items: EmbedItem[]; skipped: string[] }> {
  const f = cfg.fetch ?? fetch;
  const headers = { Authorization: `Bearer ${cfg.accessToken}` };
  const base = 'https://graph.microsoft.com/v1.0';
  const root = cfg.folderPath ? `/drives/${cfg.driveId}/root:/${cfg.folderPath}:` : `/drives/${cfg.driveId}/root`;
  const items: EmbedItem[] = [], skipped: string[] = [];
  let next: string | undefined = `${base}${root}/children`;
  while (next) {
    const res = await f(next, { headers });
    if (!res.ok) throw new Error(`Graph ${res.status}`);
    const page: any = await res.json();
    for (const it of page.value) {
      if (!it.file) continue;
      if (!TEXT_EXT.test(it.name)) { skipped.push(it.name); continue; }
      const body = await f(`${base}/drives/${cfg.driveId}/items/${it.id}/content`, { headers });
      items.push({ sourceType: 'kb_doc', sourceRef: `sharepoint:${it.id}`, content: `${it.name}\n${(await body.text()).slice(0, 8000)}` });
    }
    next = page['@odata.nextLink'];
  }
  return { items, skipped };
}
