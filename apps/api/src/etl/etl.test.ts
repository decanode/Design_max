import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { pool } from '../db.js';
import { JiraExtractor, adfToText } from './jira.js';
import { ServiceNowExtractor } from './servicenow.js';
import { mapState } from './transform.js';
import { runMigration } from './pipeline.js';
import { HashEmbedder, similar } from './vectorize.js';
import { fakeJiraFetch, fakeSnowFetch } from './fixtures/fakeHttp.js';
import type { LegacyRecord } from './types.js';

const collect = async (g: AsyncGenerator<LegacyRecord>) => { const o: LegacyRecord[] = []; for await (const r of g) o.push(r); return o; };
const jira = () => new JiraExtractor({ baseUrl: 'https://jira.test', email: 'a', apiToken: 'b', pageSize: 2, fetch: fakeJiraFetch, acceptanceCriteriaField: 'customfield_10040' });
const snow = () => new ServiceNowExtractor({ instanceUrl: 'https://snow.test', username: 'a', password: 'b', tables: ['incident'], fetch: fakeSnowFetch });

describe('extractors', () => {
  it('Jira paginates and normalizes', async () => {
    const recs = await collect(jira().extract());
    expect(recs.map((r) => r.legacyId)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(recs[0].comments[0].body).toBe('looks good');
    expect(recs[0].attachments[0].filename).toBe('spec.pdf');
    expect(recs[0].acceptanceCriteria).toContain('LIFNR');
  });
  it('ServiceNow normalizes incident with journals, attachments, caller', async () => {
    const [r] = await collect(snow().extract());
    expect(r).toMatchObject({ legacyId: 'INC001', reporter: { email: 'carol@corp.com' }, resolutionNotes: expect.stringContaining('fuser') });
    expect(r.comments).toHaveLength(1);
    expect(r.attachments[0].url).toContain('/attachment/at1/file');
  });
  it('rejects non-2xx', async () => {
    const bad = new JiraExtractor({ baseUrl: 'https://x', email: 'a', apiToken: 'b', fetch: async () => new Response('no', { status: 401 }) });
    await expect(collect(bad.extract())).rejects.toThrow(/401/);
  });
});

describe('transform', () => {
  it('maps legacy states to phase gates', () => {
    expect(mapState({ source: 'jira', status: 'Done' })).toBe('Deployed');
    expect(mapState({ source: 'jira', status: 'In Progress' })).toBe('Development');
    expect(mapState({ source: 'servicenow', status: '6' })).toBe('Deployed');
    expect(mapState({ source: 'jira', status: 'Weird' })).toBe('Requirement Verified');
  });
  it('flattens ADF', () => expect(adfToText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] }).trim()).toBe('hi'));
});

describe('pipeline (DB)', () => {
  let projectId: string;
  beforeAll(async () => {
    const legacy = "(SELECT id FROM tickets WHERE legacy_id IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE name = 'etl'))";
    for (const t of ['ticket_transitions', 'ticket_comments', 'attachments']) await pool.query(`DELETE FROM ${t} WHERE ticket_id IN ${legacy}`);
    await pool.query("DELETE FROM tickets WHERE legacy_id IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE name = 'etl')");
    await pool.query("DELETE FROM embeddings WHERE source_type='ticket'");
    projectId = (await pool.query("INSERT INTO projects(name) VALUES('etl') RETURNING id")).rows[0].id;
  });
  afterAll(() => pool.end());

  it('loads Jira + SNOW idempotently, maps users, vectorizes, and finds historical fixes', async () => {
    const emb = new HashEmbedder();
    const a = await runMigration(pool, projectId, jira(), emb);
    const b = await runMigration(pool, projectId, snow(), emb);
    await runMigration(pool, projectId, jira(), emb); // re-run
    expect(a).toMatchObject({ tickets: 3, embedded: 1, failed: [] });
    expect(b.tickets).toBe(1);

    const t = await pool.query("SELECT count(*)::int c FROM tickets WHERE legacy_id IS NOT NULL AND project_id=$1", [projectId]);
    expect(t.rows[0].c).toBe(4);
    const st = await pool.query("SELECT current_state FROM tickets WHERE legacy_id='PROJ-1' AND project_id=$1", [projectId]);
    expect(st.rows[0].current_state).toBe('Deployed');
    const u = await pool.query("SELECT 1 FROM users WHERE email='alice@corp.com'");
    expect(u.rowCount).toBe(1);
    const cm = await pool.query("SELECT count(*)::int c FROM ticket_comments");
    expect(cm.rows[0].c).toBeGreaterThanOrEqual(4);

    const hits = await similar(pool, emb, 'label printer fuser problem', 1);
    expect(hits[0].source_ref).toBe('INC001');
  });
});
