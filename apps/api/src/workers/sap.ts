import type { EmbedItem } from '../etl/vectorize.js';

/** Thin seam over an RFC library (e.g. node-rfc, installed with the SAP NW RFC SDK in the target env). */
export interface RfcClient { call(fm: string, params: Record<string, unknown>): Promise<Record<string, any>> }

/** Reads rows from a table through RFC_READ_TABLE. */
async function readTable(rfc: RfcClient, table: string, fields: string[], where?: string): Promise<Record<string, string>[]> {
  const r = await rfc.call('RFC_READ_TABLE', {
    QUERY_TABLE: table, DELIMITER: '|', FIELDS: fields.map((f) => ({ FIELDNAME: f })),
    OPTIONS: where ? [{ TEXT: where }] : [] });
  return (r.DATA as { WA: string }[]).map((d) => {
    const cells = d.WA.split('|').map((c) => c.trim());
    return Object.fromEntries(fields.map((f, i) => [f, cells[i] ?? '']));
  });
}

/** ST03N usage stats arrive by a customer-specific FM; injected so usage ranking is optional. */
export type UsageProvider = () => Promise<Record<string, number>>;

export async function extractSapMetadata(rfc: RfcClient, usage?: UsageProvider, where = "NAME LIKE 'Z%' OR NAME LIKE 'Y%'"): Promise<EmbedItem[]> {
  const [progs, tcodes, hits] = await Promise.all([
    readTable(rfc, 'TRDIR', ['NAME', 'SUBC', 'CNAM'], where),
    readTable(rfc, 'TSTC', ['TCODE', 'PGMNA']),
    usage?.() ?? Promise.resolve({} as Record<string, number>),
  ]);
  const byProg = new Map<string, string[]>();
  for (const t of tcodes) byProg.set(t.PGMNA, [...(byProg.get(t.PGMNA) ?? []), t.TCODE]);
  return progs.map((p) => ({
    sourceType: 'sap_metadata' as const, sourceRef: `program:${p.NAME}`,
    content: [`ABAP program ${p.NAME} (type ${p.SUBC}, author ${p.CNAM})`,
      byProg.has(p.NAME) ? `Transactions: ${byProg.get(p.NAME)!.join(', ')}` : '',
      hits[p.NAME] != null ? `Usage count: ${hits[p.NAME]}` : ''].filter(Boolean).join('\n'),
  }));
}
