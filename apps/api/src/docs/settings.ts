import { z } from 'zod';
import { pool } from '../db.js';
import type { Typography } from '../docgen/template.js';

/** Fonts the exported Word file may use. A reader without the font falls back as Word normally does. */
export const FONTS = ['Calibri', 'Arial', 'Verdana', 'Tahoma', 'Segoe UI', 'Times New Roman', 'Georgia', 'Cambria', 'Courier New', 'Consolas'] as const;
export const STACK_SETS = ['sap', 'dotnet', 'java', 'node', 'generic'] as const;

export const DocSettings = z.object({
  displayName: z.string().trim().max(120),         // project name shown on documents
  clientName: z.string().trim().max(120),
  headerText: z.string().trim().max(160),
  footerText: z.string().trim().max(160),
  confidentiality: z.string().trim().max(80),
  docNumberFormat: z.string().trim().min(1).max(80).refine((f) => /\{(PROJECT|TICKET|TYPE|VERSION)\}/.test(f), 'Use at least one of {PROJECT}, {TICKET}, {TYPE}, {VERSION}'),
  bodyFont: z.enum(FONTS), headingFont: z.enum(FONTS),
  bodySize: z.number().min(8).max(14),
  h1Size: z.number().min(12).max(28), h2Size: z.number().min(11).max(24), h3Size: z.number().min(10).max(20),
  templateStack: z.enum(STACK_SETS).nullable(),    // null = follow the project's allowed technology
  qaGate: z.boolean(),
  blockApprovalOnOpenComments: z.boolean(),         // approval cannot be requested while review comments are unresolved                             // TUT and CRC must be approved before Development -> QA
}).strict();
export type DocSettings = z.infer<typeof DocSettings>;

export const BUILT_IN: DocSettings = {
  displayName: '', clientName: '', headerText: '', footerText: '', confidentiality: 'Confidential',
  docNumberFormat: '{PROJECT}-{TICKET}-{TYPE}', bodyFont: 'Calibri', headingFont: 'Calibri',
  bodySize: 11, h1Size: 18, h2Size: 14, h3Size: 12, templateStack: null, qaGate: false, blockApprovalOnOpenComments: false,
};

export const PlatformDefaults = DocSettings.partial().omit({ qaGate: true, displayName: true, clientName: true, templateStack: true });
const parsePartial = (j: unknown) => { const r = DocSettings.partial().safeParse(j); return r.success ? r.data : {}; };

export async function platformDefaults(): Promise<Partial<DocSettings>> {
  return parsePartial((await pool.query('SELECT settings FROM platform_doc_defaults WHERE id=1')).rows[0]?.settings ?? {});
}
export async function projectOverrides(projectId: string): Promise<Partial<DocSettings>> {
  return parsePartial((await pool.query('SELECT settings FROM project_doc_settings WHERE project_id=$1', [projectId])).rows[0]?.settings ?? {});
}
/** Built-in defaults, overridden by the platform's, overridden by the project's. Each layer overrides only what it sets. */
export async function effectiveSettings(projectId: string): Promise<DocSettings> {
  return { ...BUILT_IN, ...await platformDefaults(), ...await projectOverrides(projectId) };
}

export async function saveProjectSettings(projectId: string, patch: Partial<DocSettings>, userId: string) {
  const merged = { ...await projectOverrides(projectId), ...patch };
  await pool.query(
    `INSERT INTO project_doc_settings (project_id, settings, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (project_id) DO UPDATE SET settings=$2, updated_by=$3, updated_at=now()`, [projectId, JSON.stringify(merged), userId]);
  return effectiveSettings(projectId);
}
export async function savePlatformDefaults(patch: Partial<DocSettings>, userId: string) {
  const merged = { ...await platformDefaults(), ...patch };
  await pool.query('UPDATE platform_doc_defaults SET settings=$1, updated_by=$2, updated_at=now() WHERE id=1', [JSON.stringify(merged), userId]);
  return platformDefaults();
}

export const typographyOf = (s: DocSettings): Typography => ({
  bodyFont: s.bodyFont, headingFont: s.headingFont, bodySizePt: s.bodySize, headingSizesPt: { h1: s.h1Size, h2: s.h2Size, h3: s.h3Size },
});

export const docNumber = (fmt: string, v: { project: string; ticket: string; type: string; version: number }) =>
  fmt.replace(/\{PROJECT\}/g, v.project.replace(/\s+/g, '').slice(0, 12).toUpperCase()).replace(/\{TICKET\}/g, v.ticket)
     .replace(/\{TYPE\}/g, v.type).replace(/\{VERSION\}/g, `v${v.version}`);

/** When a project turns the gate on, a ticket may leave Development for QA only with approved TUT and CRC. */
export async function qaGateProblem(client: { query: (s: string, p: unknown[]) => Promise<{ rows: any[] }> }, ticketId: string): Promise<string | null> {
  const t = (await client.query('SELECT project_id FROM tickets WHERE id=$1', [ticketId])).rows[0];
  if (!t) return null;
  const on = (await client.query(`SELECT settings->>'qaGate' g FROM project_doc_settings WHERE project_id=$1`, [t.project_id])).rows[0]?.g === 'true';
  if (!on) return null;
  const done = new Set((await client.query(`SELECT DISTINCT kind FROM approval_requests WHERE ticket_id=$1 AND status='approved' AND kind IN ('TUT','CRC')`, [ticketId])).rows.map((r) => r.kind));
  const missing = ['TUT', 'CRC'].filter((k) => !done.has(k));
  return missing.length ? `This project requires an approved ${missing.join(' and ')} before QA` : null;
}
