import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { pool, runWithContext } from '../db.js';
import { buildApp } from '../app.js';
import { HashEmbedder } from '../etl/vectorize.js';
import { TemplateGenerator } from '../docs/generator.js';
import { createTicket } from '../tickets.js';
import { createConversation, addMessage } from '../chat/service.js';
import { makeProject, makeUser, type TestUser } from '../testAuth.js';
import { signSession } from '../rbac/auth.js';

/**
 * These tests attack the project wall at the DATABASE, without going through any of the application's own checks:
 * what the restricted account can see and change depends only on the project it declares.
 */
const app = buildApp({ generator: new TemplateGenerator(), embedder: new HashEmbedder() });
// A handler that "forgets" its WHERE clause. The database must still keep it inside the caller's project.
app.get('/api/__probe', async () => (await pool.query('SELECT title FROM tickets ORDER BY title')).rows.map((r) => r.title));
let raw: pg.Pool, alpha: string, beta: string, tA: string, tB: string, convA: string, convB: string, userA: TestUser, userB: TestUser;

const as = async <T>(ctx: { projectId?: string | null; platform?: boolean }, sql: string, params: unknown[] = []) => {
  const c = await raw.connect();
  try {
    await c.query('SELECT set_config($1,$2,false), set_config($3,$4,false)', ['app.project_id', ctx.projectId ?? '', 'app.platform', ctx.platform ? 'on' : 'off']);
    return await c.query(sql, params);
  } finally { c.release(); }
};
const n = async (ctx: { projectId?: string; platform?: boolean }, table: string) => (await as(ctx, `SELECT count(*)::int n FROM ${table}`)).rows[0].n as number;

beforeAll(async () => {
  await app.ready();
  raw = new pg.Pool({ connectionString: process.env.DATABASE_URL });          // the restricted application account, with no help from the app
  alpha = await makeProject('RLS Alpha'); beta = await makeProject('RLS Beta');
  userA = await makeUser('Project Admin', undefined, alpha); userB = await makeUser('Project Admin', undefined, beta);
  tA = (await createTicket(alpha, 'RLS alpha ticket')).id; tB = (await createTicket(beta, 'RLS beta ticket')).id;
  convA = (await createConversation(alpha)).id; convB = (await createConversation(beta)).id;
  await addMessage(convA, 'customer', 'a', 'alpha says'); await addMessage(convB, 'customer', 'b', 'beta says');
  await pool.query("INSERT INTO documents (ticket_id, kind, version_number, content_md) VALUES ($1,'FS',1,'alpha doc'), ($2,'FS',1,'beta doc')", [tA, tB]);
  await pool.query("INSERT INTO audit_log (action, detail, project_id) VALUES ('rls.test','{}',$1), ('rls.test','{}',$2), ('rls.test','{}',NULL)", [alpha, beta]);
});
afterAll(async () => { await raw.end(); await app.close(); await pool.end(); });

describe('the restricted application account', () => {
  it('is not a superuser and cannot bypass row-level security; it cannot change the schema or the migration history', async () => {
    const r = (await raw.query('SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0];
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    await expect(raw.query('CREATE TABLE sneaky (x int)')).rejects.toThrow(/permission denied/);
    await expect(raw.query('DROP TABLE tickets')).rejects.toThrow(/must be owner/);
    await expect(raw.query('ALTER TABLE tickets DISABLE ROW LEVEL SECURITY')).rejects.toThrow(/must be owner/);
    await expect(raw.query('SELECT * FROM _migrations')).rejects.toThrow(/permission denied/);
    await expect(raw.query('TRUNCATE tickets')).rejects.toThrow(/permission denied/);
  });
  it('every project table has row-level security switched on', async () => {
    const tables = ['tickets', 'conversations', 'messages', 'requirement_drafts', 'documents', 'approvals', 'approval_requests', 'ticket_transitions', 'ticket_comments', 'attachments', 'approval_workflows', 'approval_levels', 'approval_level_approvers', 'reports', 'dashboards', 'embeddings', 'audit_log'];
    const on = (await raw.query('SELECT relname FROM pg_class WHERE relrowsecurity AND relnamespace = $1::regnamespace', ['public'])).rows.map((r) => r.relname);
    expect(tables.filter((t) => !on.includes(t))).toEqual([]);
  });
});

describe('rows depend only on the project the connection declares', () => {
  it('no declaration shows nothing; a project sees only its own rows; the platform sees all', async () => {
    for (const t of ['tickets', 'conversations', 'messages', 'documents']) expect(await n({}, t), `${t} with no context`).toBe(0);
    expect((await as({ projectId: alpha }, 'SELECT title FROM tickets WHERE title LIKE $1', ['RLS%'])).rows).toEqual([{ title: 'RLS alpha ticket' }]);
    expect((await as({ projectId: beta }, 'SELECT title FROM tickets WHERE title LIKE $1', ['RLS%'])).rows).toEqual([{ title: 'RLS beta ticket' }]);
    expect((await as({ platform: true }, 'SELECT title FROM tickets WHERE title LIKE $1 ORDER BY title', ['RLS%'])).rows.map((r) => r.title)).toEqual(['RLS alpha ticket', 'RLS beta ticket']);
  });

  it('child tables follow their parent: messages, documents and the rest cannot be read across projects', async () => {
    expect((await as({ projectId: alpha }, "SELECT body FROM messages WHERE body LIKE '%says'")).rows).toEqual([{ body: 'alpha says' }]);
    expect((await as({ projectId: alpha }, "SELECT content_md FROM documents WHERE content_md LIKE '% doc'")).rows).toEqual([{ content_md: 'alpha doc' }]);
    expect((await as({ projectId: alpha }, 'SELECT count(*)::int n FROM ticket_transitions WHERE ticket_id = $1', [tB])).rows[0].n).toBe(0);
    expect((await as({ projectId: alpha }, 'SELECT count(*)::int n FROM documents WHERE ticket_id = $1', [tB])).rows[0].n).toBe(0);
  });

  it('writing into, changing or deleting another project\'s rows is refused or silently touches nothing', async () => {
    await expect(as({ projectId: alpha }, 'INSERT INTO tickets (project_id, title) VALUES ($1, $2)', [beta, 'planted'])).rejects.toThrow(/row-level security/);
    await expect(as({ projectId: alpha }, "INSERT INTO documents (ticket_id, kind, version_number, content_md) VALUES ($1,'FS',9,'planted')", [tB])).rejects.toThrow(/row-level security/);
    await expect(as({ projectId: alpha }, 'INSERT INTO messages (conversation_id, sender_role, sender_name, body) VALUES ($1,$2,$3,$4)', [convB, 'customer', 'x', 'planted'])).rejects.toThrow(/row-level security/);
    expect((await as({ projectId: alpha }, "UPDATE tickets SET title='hijacked' WHERE id=$1", [tB])).rowCount).toBe(0);
    expect((await as({ projectId: alpha }, 'DELETE FROM tickets WHERE id=$1', [tB])).rowCount).toBe(0);
    expect((await as({ projectId: alpha }, "UPDATE tickets SET project_id=$2 WHERE id=$1", [tA, beta]).catch((e) => e)).message ?? 'moved').toMatch(/row-level security/);   // cannot move its own ticket out either
    expect((await pool.query('SELECT title FROM tickets WHERE id=$1', [tB])).rows[0].title).toBe('RLS beta ticket');
  });

  it('shared rows: built-in reports and shared knowledge are readable everywhere, but only the platform can change them', async () => {
    expect((await as({ projectId: alpha }, 'SELECT count(*)::int n FROM reports WHERE project_id IS NULL AND is_system')).rows[0].n).toBeGreaterThanOrEqual(9);
    expect((await as({ projectId: alpha }, "UPDATE reports SET name='x' WHERE is_system")).rowCount).toBe(0);
    expect((await as({ projectId: alpha }, 'DELETE FROM reports WHERE is_system')).rowCount).toBe(0);
    await expect(as({ projectId: alpha }, "INSERT INTO embeddings (source_type, source_ref, content) VALUES ('kb_doc','planted-shared','x')")).rejects.toThrow(/row-level security/);
    await as({ platform: true }, "INSERT INTO embeddings (source_type, source_ref, content) VALUES ('kb_doc','rls-shared','x')");
    expect((await as({ projectId: beta }, "SELECT count(*)::int n FROM embeddings WHERE source_ref='rls-shared'")).rows[0].n).toBe(1);
    expect((await as({}, "SELECT count(*)::int n FROM embeddings WHERE source_ref='rls-shared'")).rows[0].n).toBe(1);        // knowledge shared by the platform is public to every project
  });

  it('the audit trail: a project reads only its own entries, and nobody can alter history through the app account', async () => {
    expect((await as({ projectId: alpha }, "SELECT project_id FROM audit_log WHERE action='rls.test'")).rows).toEqual([{ project_id: alpha }]);
    expect((await as({}, "SELECT count(*)::int n FROM audit_log WHERE action='rls.test'")).rows[0].n).toBe(0);
    expect((await as({ platform: true }, "SELECT count(*)::int n FROM audit_log WHERE action='rls.test'")).rows[0].n).toBe(3);
    await expect(as({ projectId: alpha }, "INSERT INTO audit_log (action, project_id) VALUES ('forged', $1)", [beta])).rejects.toThrow(/row-level security/);
    expect((await as({ platform: true }, "UPDATE audit_log SET action='edited' WHERE action='rls.test'")).rowCount).toBe(0);   // no UPDATE policy exists: history is append-only
    expect((await as({ platform: true }, "DELETE FROM audit_log WHERE action='rls.test'")).rowCount).toBe(0);
  });
});

describe('the application stamps every call, so even a handler that forgets its WHERE clause stays inside its project', () => {
  const get = async (u: { id: string }, project?: string) =>
    (await app.inject({ method: 'GET', url: '/api/__probe', headers: { cookie: `dm_session=${signSession(u.id)}${project ? `; dm_project=${project}` : ''}` } })).json() as string[];

  it('an unfiltered query returns only the project in the person\'s session', async () => {
    expect((await get(userA, alpha)).filter((t) => t.startsWith('RLS'))).toEqual(['RLS alpha ticket']);
    expect((await get(userB, beta)).filter((t) => t.startsWith('RLS'))).toEqual(['RLS beta ticket']);
  });

  it('a person with no project gets nothing (fail closed), even though tickets exist', async () => {
    const loner = (await pool.query("INSERT INTO users (email, display_name) VALUES ('rls-loner@t.dev','Loner') RETURNING id")).rows[0].id as string;
    expect(await get({ id: loner })).toEqual([]);
  });

  it('a connection never carries over the previous caller\'s project', async () => {
    const first = await runWithContext({ projectId: alpha }, async () => (await pool.query("SELECT count(*)::int n FROM tickets WHERE title LIKE 'RLS%'")).rows[0].n);
    const second = await runWithContext({}, async () => (await pool.query("SELECT count(*)::int n FROM tickets WHERE title LIKE 'RLS%'")).rows[0].n);
    const third = await runWithContext({ projectId: beta }, async () => (await pool.query("SELECT title FROM tickets WHERE title LIKE 'RLS%'")).rows.map((r) => r.title));
    expect([first, second, third]).toEqual([1, 0, ['RLS beta ticket']]);
    const tx = await runWithContext({ projectId: alpha }, async () => { const c = await pool.connect(); try { return (await c.query("SELECT count(*)::int n FROM tickets WHERE title LIKE 'RLS%'")).rows[0].n; } finally { c.release(); } });
    expect(tx).toBe(1);                                                             // transactions get the same stamp
  });

  it('the Super Admin console runs as the platform; the same person working inside a project is held to that project', async () => {
    const sup = await makeUser('Super Admin', undefined, alpha);
    const projects = (await app.inject({ method: 'GET', url: '/api/platform/projects', headers: { cookie: sup.cookie } })).json() as any[];
    expect(projects.find((p) => p.id === beta)?.tickets).toBe(1);                   // platform view counts Beta's ticket
    expect((await get(sup, alpha)).filter((t) => t.startsWith('RLS'))).toEqual(['RLS alpha ticket']);   // working in Alpha: Beta does not exist
  });
});
