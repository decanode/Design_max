import { useEffect, useState } from 'react';
import { z } from 'zod';

export type FieldKind = 'text' | 'textarea' | 'select' | 'number' | 'date' | 'checkbox';
export type TypeField = { id: number; key: string; label: string; kind: FieldKind; options: string[]; required: boolean; help: string; position: number };
export type Phase = { id: number; name: string; tone: 'intake' | 'spec' | 'build' | 'review' | 'done'; position: number; enabled: boolean };
export type TicketType = { id: number; key: string; name: string; short: string; description: string; enabled: boolean; isDefault: boolean; fields: TypeField[] };
export type Move = { to: string; gated: string | null };
export type Workflow = {
  projectType: { id: number; key: string; name: string } | null; template: { id: number; key: string; name: string } | null;
  phases: Phase[]; ticketTypes: TicketType[]; moves: Record<number, Record<string, Move[]>>;
};

export const TONE_LABEL: Record<Phase['tone'], string> = { intake: 'Intake', spec: 'Specification', build: 'Delivery', review: 'Review', done: 'Done' };

/** The project's workflow, loaded once per page. */
export function useWorkflow(enabled = true) {
  const [wf, setWf] = useState<Workflow | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    fetch('/api/workflow').then((r) => (r.ok ? r.json() : null)).then((d) => { if (live && d) setWf(d); });
    return () => { live = false; };
  }, [enabled]);
  return wf;
}

/** Consecutive phases of the same kind share a lane, so the lifecycle reads left to right. */
export function lanes(phases: Phase[]) {
  const out: { tone: Phase['tone']; name: string; phases: Phase[] }[] = [];
  for (const p of phases) {
    const last = out[out.length - 1];
    if (last && last.tone === p.tone) last.phases.push(p); else out.push({ tone: p.tone, name: TONE_LABEL[p.tone], phases: [p] });
  }
  return out;
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';
function problem(f: TypeField, v: unknown): string | null {
  if (f.kind === 'checkbox') return null;
  if (isEmpty(v)) return f.required ? `${f.label} is required` : null;
  if (f.kind === 'number') return Number.isFinite(Number(v)) ? null : `${f.label} must be a number`;
  if (f.kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && !Number.isNaN(Date.parse(String(v))) ? null : `${f.label} must be a date`;
  if (f.kind === 'select') return f.options.includes(String(v)) ? null : `Choose ${f.label.toLowerCase()}`;
  return String(v).length > (f.kind === 'textarea' ? 5000 : 500) ? `${f.label} is too long` : null;
}

/** The same rules the server enforces, built from the field definitions, so the form can say what is wrong before you submit. */
export function fieldsSchema(fields: TypeField[]) {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) shape[f.key] = z.preprocess((v) => (v === undefined ? '' : v), z.unknown().superRefine((v, ctx) => { const m = problem(f, v); if (m) ctx.addIssue({ code: 'custom', message: m }); }));   // a field that was never touched still counts
  return z.object(shape);
}

/** What is sent to the server: empty optional fields left out, numbers as numbers. */
export function cleanValues(fields: TypeField[], values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (f.kind === 'checkbox') { if (v === true) out[f.key] = true; continue; }
    if (isEmpty(v)) continue;
    out[f.key] = f.kind === 'number' ? Number(v) : typeof v === 'string' ? v.trim() : v;
  }
  return out;
}
