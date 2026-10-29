import { adfToText } from '../etl/jira.js';
import type { Connector, ConnectorConfig, SourceTicket, SourceUser } from './types.js';

const user = (u: any): SourceUser | undefined => (u ? { id: u.accountId ?? u.key ?? u.name, email: u.emailAddress, name: u.displayName ?? u.name } : undefined);
const FIELDS = ['summary', 'description', 'status', 'issuetype', 'reporter', 'assignee', 'resolution', 'comment', 'attachment', 'priority', 'duedate', 'created', 'updated'];

/** Jira Cloud (api v3, nextPageToken) and Jira Data Center / Server (api v2, startAt). Chosen by `config.flavor`. */
export class JiraConnector implements Connector {
  constructor(private c: ConnectorConfig) {}
  private flavor = () => (this.c.config.flavor === 'datacenter' ? 'datacenter' : 'cloud');
  private f = () => this.c.fetch ?? fetch;
  private headers() {
    const token = Buffer.from(`${this.c.username}:${this.c.secret}`).toString('base64');
    return { Authorization: this.flavor() === 'datacenter' && !this.c.username ? `Bearer ${this.c.secret}` : `Basic ${token}`, Accept: 'application/json' };
  }
  private async get(path: string, params: Record<string, string> = {}) {
    const url = new URL(path, this.c.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      const res = await this.f()(url, { headers: this.headers() });
      if (res.status === 429 && attempt < 3) { await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get('retry-after') ?? 1), 5) * (process.env.NODE_ENV === 'test' ? 1 : 1000))); continue; }
      if (!res.ok) throw new Error(`Jira answered ${res.status} ${res.statusText}`);
      return res.json() as Promise<any>;
    }
  }
  async test() {
    const me = await this.get(this.flavor() === 'cloud' ? '/rest/api/3/myself' : '/rest/api/2/myself');
    return { detail: `Signed in as ${me.displayName ?? me.name ?? 'the integration user'}` };
  }
  private jql(since: string | null) {
    const base = String(this.c.config.jql ?? 'issuetype is not EMPTY').replace(/\s+order\s+by\s.*$/i, '').trim();
    const t = since ? ` AND updated >= "${since.replace('T', ' ').slice(0, 16)}"` : '';
    return `(${base})${t} ORDER BY updated ASC`;
  }
  async *pull(since: string | null): AsyncGenerator<SourceTicket> {
    const size = Number(this.c.config.pageSize ?? 50);
    const ac = typeof this.c.config.acceptanceCriteriaField === 'string' ? this.c.config.acceptanceCriteriaField : undefined;
    const fields = [...FIELDS, ...(ac ? [ac] : [])].join(',');
    let token: string | undefined; let startAt = 0;
    for (;;) {
      const page = this.flavor() === 'cloud'
        ? await this.get('/rest/api/3/search/jql', { jql: this.jql(since), fields, expand: 'changelog', maxResults: String(size), ...(token ? { nextPageToken: token } : {}) })
        : await this.get('/rest/api/2/search', { jql: this.jql(since), fields, expand: 'changelog', maxResults: String(size), startAt: String(startAt) });
      for (const i of page.issues ?? []) yield this.map(i, ac);
      startAt += (page.issues ?? []).length;
      token = page.nextPageToken;
      if (!(page.issues ?? []).length) return;
      if (this.flavor() === 'cloud' ? (page.isLast || !token) : startAt >= page.total) return;
    }
  }
  private map(i: any, ac?: string): SourceTicket {
    const fl = i.fields ?? {};
    const history = (i.changelog?.histories ?? []).flatMap((h: any) => (h.items ?? []).filter((x: any) => x.field === 'status').map((x: any) => ({ at: h.created, from: x.fromString ?? null, to: x.toString, actor: h.author?.displayName })))
      .sort((a: any, b: any) => +new Date(a.at) - +new Date(b.at));
    return {
      source: 'jira', key: i.key, type: fl.issuetype?.name ?? 'Issue', title: fl.summary ?? i.key, description: adfToText(fl.description).trim() || undefined,
      status: fl.status?.name ?? 'Unknown', priority: fl.priority?.name, dueDate: fl.duedate ?? undefined, reporter: user(fl.reporter), assignee: user(fl.assignee),
      resolutionNotes: fl.resolution?.description || undefined, acceptanceCriteria: ac ? adfToText(fl[ac]).trim() || undefined : undefined,
      comments: (fl.comment?.comments ?? []).map((c: any) => ({ id: `jira:${i.key}:${c.id}`, author: user(c.author), body: adfToText(c.body).trim(), createdAt: c.created })),
      attachments: (fl.attachment ?? []).map((a: any) => ({ id: `jira:${a.id}`, filename: a.filename, mimeType: a.mimeType, size: a.size, url: a.content })),
      createdAt: fl.created ?? new Date().toISOString(), updatedAt: fl.updated ?? fl.created ?? new Date().toISOString(),
      url: `${this.c.baseUrl.replace(/\/$/, '')}/browse/${i.key}`, history,
    };
  }
}
