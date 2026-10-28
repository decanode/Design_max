// A stand-in for Google's Gemini API, used only by the end-to-end tests. The real @google/generative-ai SDK talks to it over HTTP
// (the API is started with GEMINI_API_BASE_URL pointing here), so the whole path (prompt building, SDK, parsing) is exercised.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_GEMINI_PORT ?? 4300);
const seen = [];

const charter = (user) => {
  const sponsor = /Sponsor:\n([^\n]*)/.exec(user)?.[1] ?? 'Unknown sponsor';
  return {
    executiveSummary: `GEMINI-MOCK summary for sponsor ${sponsor}: late vendor payments will be fixed by an automated payment run.`,
    objectives: ['Pay 95% of invoices on time', 'Halve vendor disputes'],
    scope: ['Automated payment run', 'Vendor self-service portal'],
    outOfScope: ['Payroll'],
    stakeholders: [{ name: sponsor, role: 'Sponsor', interest: 'Cash flow' }],
    milestones: [{ name: 'Charter approved', timing: 'Week 1' }, { name: 'Go-live', timing: 'Week 12' }],
    risks: [{ risk: 'Poor vendor master data', impact: 'High', mitigation: 'Cleanse before build' }],
  };
};
const wbs = () => ({
  phases: [
    { title: 'Design', description: 'Design the solution', deliverables: [{ title: 'Blueprint', description: 'Agreed design', workPackages: [{ title: 'Run design workshop', description: '', effortDays: 2 }, { title: 'Write the blueprint', description: '', effortDays: 3 }] }] },
    { title: 'Build', description: 'Build it', deliverables: [{ title: 'Payment run', description: '', workPackages: [{ title: 'Configure the payment run', description: 'Config', effortDays: 5 }] }, { title: 'Vendor portal', description: '', workPackages: [{ title: 'Build the portal', description: '', effortDays: 8 }] }] },
  ],
});

createServer((req, res) => {
  if (req.url === '/health') return res.writeHead(200).end('ok');
  if (req.url === '/__requests') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(seen));
  if (req.url === '/__reset') { seen.length = 0; return res.writeHead(200).end('ok'); }
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const system = body.systemInstruction?.parts?.[0]?.text ?? '', user = body.contents?.[0]?.parts?.[0]?.text ?? '';
    seen.push({ url: req.url, key: req.headers['x-goog-api-key'], system: system.slice(0, 120), user, json: body.generationConfig?.responseMimeType });
    if (user.includes('FORCE-FAIL')) return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'mock failure' } }));
    const kind = system.includes('Work Breakdown Structure') ? wbs() : system.includes('Project Charter') ? charter(user) : { ok: true };
    // a little latency, so loading states are real
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(kind) }] }, finishReason: 'STOP' }] })), 600);
  });
}).listen(PORT, () => console.log(`mock Gemini on :${PORT}`));
