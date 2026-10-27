/** Fake fetch serving canned Jira / ServiceNow responses (incl. pagination). */
const adf = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const jiraIssue = (n: number, status: string) => ({
  key: `PROJ-${n}`,
  fields: {
    summary: `Story ${n}`, description: adf(`Description ${n}`), status: { name: status }, issuetype: { name: 'Story' },
    reporter: { accountId: 'acc-1', emailAddress: 'Alice@Corp.com', displayName: 'Alice' },
    assignee: { accountId: 'acc-2', displayName: 'Bob' },
    resolution: { description: n === 1 ? 'Fixed by rebuilding the MM01 material master BAPI wrapper' : '' },
    customfield_10040: adf(n === 1 ? 'Given a vendor, when saved, then an SAP LIFNR is returned' : ''),
    comment: { comments: [{ id: `c${n}`, author: { accountId: 'acc-2', displayName: 'Bob' }, body: adf('looks good'), created: '2024-01-01T00:00:00Z' }] },
    attachment: [{ id: `a${n}`, filename: 'spec.pdf', mimeType: 'application/pdf', size: 10, content: `https://jira.test/att/a${n}` }],
  },
});

export const fakeJiraFetch: typeof fetch = async (input) => {
  const u = new URL(String(input));
  const start = Number(u.searchParams.get('startAt'));
  const all = [jiraIssue(1, 'Done'), jiraIssue(2, 'In Progress'), jiraIssue(3, 'Weird')];
  const issues = all.slice(start, start + Number(u.searchParams.get('maxResults')));
  return Response.json({ total: all.length, issues });
};

export const fakeSnowFetch: typeof fetch = async (input) => {
  const u = new URL(String(input));
  const q = u.searchParams.get('sysparm_query') ?? '';
  const json = (result: unknown) => Response.json({ result });
  if (u.pathname.endsWith('/sys_user')) return json([{ sys_id: 'u1', email: 'carol@corp.com', name: 'Carol' }]);
  if (u.pathname.endsWith('/sys_journal_field')) return json([{ sys_id: 'j1', element_id: 's1', value: 'work note', sys_created_on: '2024-02-01 10:00:00', sys_created_by: 'carol' }]);
  if (u.pathname.endsWith('/attachment')) return json([{ sys_id: 'at1', table_sys_id: 's1', file_name: 'log.txt', content_type: 'text/plain', size_bytes: '5' }]);
  if (u.pathname.endsWith('/incident') && Number(u.searchParams.get('sysparm_offset')) === 0)
    return json([{ sys_id: 's1', number: 'INC001', short_description: 'Printer down', state: '6', caller_id: { value: 'u1' }, close_notes: 'Replaced fuser unit on label printer' }]);
  void q;
  return json([]);
};
