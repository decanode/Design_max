import type { Extractor, Fetcher, LegacyRecord, LegacyUser } from './types.js';

export interface JiraConfig {
  baseUrl: string; email: string; apiToken: string;
  jql?: string; pageSize?: number; fetch?: Fetcher;
  acceptanceCriteriaField?: string;   // custom field id, e.g. customfield_10040
}

const user = (u: any): LegacyUser | undefined =>
  u ? { legacyId: u.accountId, email: u.emailAddress, name: u.displayName } : undefined;

/** Flattens Atlassian Document Format (or plain strings) to text. */
export function adfToText(n: any): string {
  if (!n) return '';
  if (typeof n === 'string') return n;
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfToText).join(n.type === 'doc' ? '\n' : '');
  return ['paragraph', 'heading', 'listItem'].includes(n.type) ? inner + '\n' : inner;
}

export class JiraExtractor implements Extractor {
  constructor(private cfg: JiraConfig) {}

  async *extract(): AsyncGenerator<LegacyRecord> {
    const f = this.cfg.fetch ?? fetch;
    const size = this.cfg.pageSize ?? 50;
    const ac = this.cfg.acceptanceCriteriaField;
    const auth = 'Basic ' + Buffer.from(`${this.cfg.email}:${this.cfg.apiToken}`).toString('base64');
    let startAt = 0;
    for (;;) {
      const url = new URL('/rest/api/3/search', this.cfg.baseUrl);
      url.searchParams.set('jql', this.cfg.jql ?? 'issuetype in (Epic, Story, Bug) ORDER BY created ASC');
      url.searchParams.set('startAt', String(startAt));
      url.searchParams.set('maxResults', String(size));
      url.searchParams.set('fields', ['summary', 'description', 'status', 'issuetype', 'reporter', 'assignee', 'resolution', 'comment', 'attachment', ...(ac ? [ac] : [])].join(','));
      const res = await f(url, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`Jira ${res.status} ${res.statusText}`);
      const page: any = await res.json();
      for (const i of page.issues) {
        const fl = i.fields;
        yield {
          source: 'jira', legacyId: i.key, type: fl.issuetype?.name ?? 'Issue', title: fl.summary,
          description: adfToText(fl.description).trim() || undefined,
          status: fl.status?.name ?? 'Unknown',
          reporter: user(fl.reporter), assignee: user(fl.assignee),
          resolutionNotes: fl.resolution?.description || undefined,
          acceptanceCriteria: ac ? adfToText(fl[ac]).trim() || undefined : undefined,
          comments: (fl.comment?.comments ?? []).map((c: any) => ({
            legacyId: `jira:${i.key}:${c.id}`, author: user(c.author), body: adfToText(c.body).trim(), createdAt: c.created })),
          attachments: (fl.attachment ?? []).map((a: any) => ({
            legacyId: `jira:${a.id}`, filename: a.filename, mimeType: a.mimeType, size: a.size, url: a.content })),
        };
      }
      startAt += page.issues.length;
      if (!page.issues.length || startAt >= page.total) return;
    }
  }
}
