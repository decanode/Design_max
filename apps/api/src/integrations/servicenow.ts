import type { Connector, ConnectorConfig, SourceTicket, SourceUser } from './types.js';

export const TABLES = ['incident', 'problem', 'change_request'] as const;
/** ServiceNow's own state numbers, per table, so the screen can show names instead of numbers. */
export const STATE_NAMES: Record<string, Record<string, string>> = {
  incident: { '1': 'New', '2': 'In Progress', '3': 'On Hold', '6': 'Resolved', '7': 'Closed', '8': 'Canceled' },
  problem: { '101': 'New', '102': 'Assess', '103': 'Root Cause Analysis', '104': 'Fix in Progress', '106': 'Resolved', '107': 'Closed' },
  change_request: { '-5': 'New', '-4': 'Assess', '-3': 'Authorize', '-2': 'Scheduled', '-1': 'Implement', '0': 'Review', '3': 'Closed', '4': 'Canceled' },
};
const stateName = (table: string, v: unknown) => STATE_NAMES[table]?.[String(v)] ?? String(v);
const snowTime = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
const asIso = (s?: string) => (s ? `${s.replace(' ', 'T')}Z` : new Date().toISOString());
const PRIORITY: Record<string, string> = { '1': 'Critical', '2': 'High', '3': 'Medium', '4': 'Low', '5': 'Low' };

export class ServiceNowConnector implements Connector {
  constructor(private c: ConnectorConfig) {}
  private f = () => this.c.fetch ?? fetch;
  private async get(path: string, params: Record<string, string>): Promise<any[]> {
    const url = new URL(path, this.c.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers = { Authorization: 'Basic ' + Buffer.from(`${this.c.username}:${this.c.secret}`).toString('base64'), Accept: 'application/json' };
    for (let attempt = 0; ; attempt++) {
      const res = await this.f()(url, { headers });
      if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, process.env.NODE_ENV === 'test' ? 1 : 1000 * (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`ServiceNow answered ${res.status} ${res.statusText}`);
      return ((await res.json()) as any).result;
    }
  }
  async test() {
    await this.get('/api/now/table/sys_user', { sysparm_limit: '1', sysparm_fields: 'sys_id' });
    return { detail: `Connected to ${new URL(this.c.baseUrl).host}` };
  }
  private users = new Map<string, SourceUser>();
  private async who(ref: any): Promise<SourceUser | undefined> {
    const id = typeof ref === 'object' ? ref?.value : ref;
    if (!id) return undefined;
    if (!this.users.has(id)) {
      const [u] = await this.get('/api/now/table/sys_user', { sysparm_query: `sys_id=${id}`, sysparm_fields: 'sys_id,email,name', sysparm_limit: '1' });
      this.users.set(id, { id, email: u?.email || undefined, name: u?.name });
    }
    return this.users.get(id);
  }
  async *pull(since: string | null): AsyncGenerator<SourceTicket> {
    const size = Number(this.c.config.pageSize ?? 100);
    const tables = (Array.isArray(this.c.config.tables) && this.c.config.tables.length ? this.c.config.tables : TABLES) as string[];
    const extra = typeof this.c.config.query === 'string' && this.c.config.query ? `^${this.c.config.query}` : '';
    for (const table of tables) {
      for (let offset = 0; ; offset += size) {
        const rows = await this.get(`/api/now/table/${table}`, { sysparm_limit: String(size), sysparm_offset: String(offset), sysparm_display_value: 'false',
          sysparm_query: `${since ? `sys_updated_on>=${snowTime(since)}^` : ''}ORDERBYsys_updated_on${extra ? '' : ''}${extra}` });
        if (!rows.length) break;
        const ids = rows.map((r) => r.sys_id).join(',');
        const journals = await this.get('/api/now/table/sys_journal_field', { sysparm_query: `element_idIN${ids}^element=comments^ORelement=work_notes` });
        const atts = await this.get('/api/now/attachment', { sysparm_query: `table_name=${table}^table_sys_idIN${ids}` });
        // the audit trail of state changes; some instances do not allow reading it, and the sync still works without it
        const audit = await this.get('/api/now/table/sys_audit', { sysparm_query: `tablename=${table}^fieldname=state^documentkeyIN${ids}^ORDERBYsys_created_on`, sysparm_fields: 'documentkey,oldvalue,newvalue,sys_created_on,user' }).catch(() => []);
        for (const r of rows) {
          yield {
            source: 'servicenow', key: r.number, type: table, title: r.short_description ?? r.number, description: r.description || undefined, status: stateName(table, r.state),
            priority: PRIORITY[String(r.priority)], reporter: await this.who(r.caller_id ?? r.opened_by), assignee: await this.who(r.assigned_to),
            resolutionNotes: r.close_notes || r.resolution_notes || undefined,
            comments: journals.filter((j) => j.element_id === r.sys_id).map((j) => ({ id: `snow:${j.sys_id}`, body: j.value, createdAt: asIso(j.sys_created_on), author: { id: j.sys_created_by } })),
            attachments: atts.filter((a) => a.table_sys_id === r.sys_id).map((a) => ({ id: `snow:${a.sys_id}`, filename: a.file_name, mimeType: a.content_type, size: Number(a.size_bytes), url: `${this.c.baseUrl}/api/now/attachment/${a.sys_id}/file` })),
            createdAt: asIso(r.sys_created_on), updatedAt: asIso(r.sys_updated_on),
            url: `${this.c.baseUrl.replace(/\/$/, '')}/nav_to.do?uri=${table}.do%3Fsys_id%3D${r.sys_id}`,
            history: audit.filter((a) => a.documentkey === r.sys_id).map((a) => ({ at: asIso(a.sys_created_on), from: a.oldvalue ? stateName(table, a.oldvalue) : null, to: stateName(table, a.newvalue), actor: a.user })),
          };
        }
        if (rows.length < size) break;
      }
    }
  }
}
