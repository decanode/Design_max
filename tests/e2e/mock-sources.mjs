// A stand-in for a customer's Jira, used only by the end-to-end tests. It answers the few calls the connector makes,
// and records every request so a test can prove the app only ever READS from the source tool.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_SOURCES_PORT ?? 4310);
const requests = [];
const state = { 1: 'In Progress', 2: 'Done' };
const bodies = [];
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => res(Buffer.concat(c).toString())); });
const adf = (t) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] });
const issue = (n, status, summary) => ({
  key: `PAY-${n}`,
  fields: { summary, description: adf(`Description of ${summary}`), status: { name: status }, issuetype: { name: 'Bug' }, priority: { name: 'High' },
    reporter: { accountId: 'r1', emailAddress: 'rita@customer.test', displayName: 'Rita Reporter' }, assignee: { accountId: 'a1', displayName: 'Al Assignee' },
    created: '2024-03-01T09:00:00.000+0000', updated: `2024-03-0${n + 1}T09:00:00.000+0000`, comment: { comments: [{ id: '1', author: { accountId: 'a1', displayName: 'Al Assignee' }, body: adf('Looking into it'), created: '2024-03-02T09:00:00.000+0000' }] }, attachment: [] },
  changelog: { histories: [{ created: '2024-03-02T10:00:00.000+0000', author: { displayName: 'Al Assignee' }, items: [{ field: 'status', fromString: 'To Do', toString: status }] }] },
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/health') return res.end('ok');
  if (url.pathname === '/__bodies') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(bodies)); }
  if (url.pathname === '/__requests') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(requests)); }
  requests.push(`${req.method} ${url.pathname}`);
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/rest/api/3/myself') return res.end(JSON.stringify({ displayName: 'Mock Jira bot' }));
  if (url.pathname === '/rest/api/3/search/jql') return res.end(JSON.stringify({ issues: [issue(1, state[1], 'Payment run fails on weekends'), issue(2, state[2], 'Wrong currency on invoices')], isLast: true }));
  const m = /^\/rest\/api\/3\/issue\/PAY-(\d)(\/.*)?$/.exec(url.pathname);
  if (m) {
    const n = Number(m[1]);
    if (req.method === 'GET' && !m[2]) return res.end(JSON.stringify({ fields: { status: { name: state[n] }, updated: `2024-03-0${n + 1}T09:00:00.000+0000` } }));
    if (req.method === 'GET' && m[2] === '/transitions') return res.end(JSON.stringify({ transitions: [{ id: '31', name: 'Finish', to: { name: 'Done' } }] }));
    if (req.method === 'POST' && m[2] === '/transitions') { const b = JSON.parse(await readBody(req)); bodies.push({ path: url.pathname, b }); state[n] = 'Done'; res.statusCode = 204; return res.end(); }
    if (req.method === 'POST' && m[2] === '/comment') { bodies.push({ path: url.pathname, b: JSON.parse(await readBody(req)) }); res.statusCode = 201; return res.end('{}'); }
  }
  res.statusCode = 404; res.end('{}');
}).listen(PORT, () => console.log(`mock sources on ${PORT}`));
