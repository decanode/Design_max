import type { Connector, ConnectorConfig, SourceNow, SourceTicket, SourceUser } from './types.js';

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
  /* ---- sending outcomes back (only the outbound queue calls these) */
  private async find(ref: { key: string; type: string }) {
    const [r] = await this.get(`/api/now/table/${ref.type}`, { sysparm_query: `number=${ref.key}`, sysparm_fields: 'sys_id,state,sys_updated_on', sysparm_limit: '1' });
    if (!r) throw new Error(`ServiceNow has no ${ref.key} in ${ref.type}`);
    return r;
  }
  private async write(method: 'PATCH' | 'POST', path: string, body: BodyInit, headers: Record<string, string>) {
    const res = await this.f()(new URL(path, this.c.baseUrl), { method, body, headers: { Authorization: 'Basic ' + Buffer.from(`${this.c.username}:${this.c.secret}`).toString('base64'), Accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`ServiceNow answered ${res.status} ${res.statusText}`);
  }
  async current(ref: { key: string; type: string }): Promise<SourceNow> { const r = await this.find(ref); return { status: stateName(ref.type, r.state), updatedAt: asIso(r.sys_updated_on) }; }
  async transitionTo(ref: { key: string; type: string }, status: string) {
    const code = Object.entries(STATE_NAMES[ref.type] ?? {}).find(([, name]) => name.toLowerCase() === status.trim().toLowerCase())?.[0];
    if (code === undefined) throw new Error(`ServiceNow ${ref.type} has no state called “${status}”. Known: ${Object.values(STATE_NAMES[ref.type] ?? {}).join(', ')}`);
    const r = await this.find(ref);
    await this.write('PATCH', `/api/now/table/${ref.type}/${r.sys_id}`, JSON.stringify({ state: code }), { 'Content-Type': 'application/json' });
    return { detail: `Set ${ref.key} to ${status}` };
  }
  async addComment(ref: { key: string; type: string }, body: string) {
    const r = await this.find(ref);
    const field = this.c.config.commentField === 'comments' ? 'comments' : 'work_notes';          // internal notes by default: customers do not see them
    await this.write('PATCH', `/api/now/table/${ref.type}/${r.sys_id}`, JSON.stringify({ [field]: body }), { 'Content-Type': 'application/json' });
    return { detail: `Added a ${field === 'comments' ? 'comment' : 'work note'} to ${ref.key}` };
  }
  async attach(ref: { key: string; type: string }, file: { filename: string; mime: string; data: Buffer }) {
    const r = await this.find(ref);
    await this.write('POST', `/api/now/attachment/file?table_name=${encodeURIComponent(ref.type)}&table_sys_id=${r.sys_id}&file_name=${encodeURIComponent(file.filename)}`, new Uint8Array(file.data), { 'Content-Type': file.mime });
    return { detail: `Attached ${file.filename} to ${ref.key}` };
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
