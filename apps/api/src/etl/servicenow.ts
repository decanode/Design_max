import type { Extractor, Fetcher, LegacyRecord, LegacyUser } from './types.js';

export interface SnowConfig {
  instanceUrl: string; username: string; password: string;
  tables?: string[]; pageSize?: number; fetch?: Fetcher;
}

export const SNOW_TABLES = ['incident', 'problem', 'change_request'];

export class ServiceNowExtractor implements Extractor {
  constructor(private cfg: SnowConfig) {}
  private f = () => this.cfg.fetch ?? fetch;
  private headers() {
    return { Authorization: 'Basic ' + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64'), Accept: 'application/json' };
  }
  private async get(path: string, params: Record<string, string>): Promise<any[]> {
    const url = new URL(path, this.cfg.instanceUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.f()(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`ServiceNow ${res.status} ${res.statusText}`);
    return ((await res.json()) as any).result;
  }

  /** sys_user sys_id -> identity (cached; email is what maps to Entra ID). */
  private userCache = new Map<string, LegacyUser>();
  private async resolveUser(ref: any): Promise<LegacyUser | undefined> {
    const id = typeof ref === 'object' ? ref?.value : ref;
    if (!id) return undefined;
    if (!this.userCache.has(id)) {
      const [u] = await this.get(`/api/now/table/sys_user`, { sysparm_query: `sys_id=${id}`, sysparm_fields: 'sys_id,email,name', sysparm_limit: '1' });
      this.userCache.set(id, { legacyId: id, email: u?.email || undefined, name: u?.name });
    }
    return this.userCache.get(id);
  }

  async *extract(): AsyncGenerator<LegacyRecord> {
    const size = this.cfg.pageSize ?? 100;
    for (const table of this.cfg.tables ?? SNOW_TABLES) {
      for (let offset = 0; ; offset += size) {
        const rows = await this.get(`/api/now/table/${table}`, {
          sysparm_limit: String(size), sysparm_offset: String(offset), sysparm_query: 'ORDERBYsys_created_on' });
        if (!rows.length) break;
        const ids = rows.map((r) => r.sys_id).join(',');
        const journals = await this.get(`/api/now/table/sys_journal_field`, {
          sysparm_query: `element_idIN${ids}^element=comments^ORelement=work_notes` });
        const atts = await this.get(`/api/now/attachment`, { sysparm_query: `table_name=${table}^table_sys_idIN${ids}` });
        for (const r of rows) {
          yield {
            source: 'servicenow', legacyId: r.number, type: table,
            title: r.short_description, description: r.description || undefined,
            status: String(r.state),
            reporter: await this.resolveUser(r.caller_id ?? r.opened_by),
            assignee: await this.resolveUser(r.assigned_to),
            resolutionNotes: r.close_notes || r.resolution_notes || undefined,
            comments: journals.filter((j) => j.element_id === r.sys_id).map((j) => ({
              legacyId: `snow:${j.sys_id}`, body: j.value, createdAt: j.sys_created_on,
              author: { legacyId: j.sys_created_by } })),
            attachments: atts.filter((a) => a.table_sys_id === r.sys_id).map((a) => ({
              legacyId: `snow:${a.sys_id}`, filename: a.file_name, mimeType: a.content_type,
              size: Number(a.size_bytes), url: `${this.cfg.instanceUrl}/api/now/attachment/${a.sys_id}/file` })),
          };
        }
        if (rows.length < size) break;
      }
    }
  }
}
