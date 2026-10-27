import type { PmNode } from './pm.js';

/** A heading and everything under it, down to the next heading of the same or a higher level. */
export interface Section { title: string; level: number; nodes: PmNode[] }

const head = (n: PmNode) => n.type === 'heading';
const levelOf = (n: PmNode) => Number(n.attrs?.level ?? 1);
export const textOf = (n: PmNode): string => (n.text ?? '') + (n.content ?? []).map(textOf).join('');

/** Splits at headings of level 1 and 2. Anything before the first heading is the "(Start of document)" section. */
export function splitSections(doc: PmNode): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const n of doc.content ?? []) {
    if (head(n) && levelOf(n) <= 2) { cur = { title: textOf(n).trim(), level: levelOf(n), nodes: [n] }; out.push(cur); }
    else { if (!cur) { cur = { title: '', level: 0, nodes: [] }; out.push(cur); } cur.nodes.push(n); }
  }
  return out.filter((s) => s.nodes.length && (s.title || s.nodes.some((n) => textOf(n).trim() || n.type === 'table')));
}

/** "2.1 Business Requirement:" and "business requirement" are the same section. */
export const normTitle = (t: string) => t.toLowerCase().replace(/^[\s\d.()\-–]+/, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (t: string) => new Set(normTitle(t).split(' ').filter((w) => w.length > 2));
const similarity = (a: string, b: string) => { const x = words(a), y = words(b); if (!x.size || !y.size) return 0; let i = 0; for (const w of x) if (y.has(w)) i++; return i / (x.size + y.size - i); };

export type Match = 'exact' | 'similar' | 'new' | 'missing';
export interface Pair { id: number; title: string; match: Match; draft: Section | null; upload: Section | null }

/** Pairs each section of the uploaded file with the draft section it most likely corresponds to. Nothing is changed here. */
export function pairSections(draft: Section[], upload: Section[]): Pair[] {
  const used = new Set<number>();
  const pick = (u: Section): { i: number; match: Match } | null => {
    const nt = normTitle(u.title);
    const exact = draft.findIndex((d, i) => !used.has(i) && nt && normTitle(d.title) === nt);
    if (exact >= 0) return { i: exact, match: 'exact' };
    let best = -1, score = 0;
    draft.forEach((d, i) => { if (used.has(i) || !d.title) return; const s = similarity(d.title, u.title); if (s > score) { score = s; best = i; } });
    return best >= 0 && score >= 0.5 ? { i: best, match: 'similar' } : null;
  };
  const byDraft = new Map<number, Pair>();
  const extra: Pair[] = [];
  upload.forEach((u) => {
    const p = pick(u);
    if (p) { used.add(p.i); byDraft.set(p.i, { id: 0, title: draft[p.i].title || u.title, match: p.match, draft: draft[p.i], upload: u }); }
    else extra.push({ id: 0, title: u.title || '(Start of document)', match: 'new', draft: null, upload: u });
  });
  const pairs: Pair[] = draft.map((d, i) => byDraft.get(i) ?? { id: 0, title: d.title || '(Start of document)', match: 'missing' as Match, draft: d, upload: null });
  return [...pairs, ...extra].map((p, i) => ({ ...p, id: i }));
}

export type Choice = 'keep' | 'upload' | 'append' | 'skip';
/** The result of the person's choices, in the draft's order, with sections only found in the upload added at the end. */
export function mergePairs(pairs: Pair[], choice: (p: Pair) => Choice): PmNode {
  const out: PmNode[] = [];
  let extraHeaded = false;
  for (const p of pairs) {
    const c = choice(p);
    if (p.match === 'new') {
      if (c === 'skip' || !p.upload) continue;
      if (!extraHeaded) { out.push({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Additional sections' }] }); extraHeaded = true; }
      out.push(...p.upload.nodes); continue;
    }
    if (c === 'upload' && p.upload) out.push(...p.upload.nodes);
    else if (c === 'append' && p.upload) { out.push(...p.draft!.nodes); out.push(...p.upload.nodes.filter((n, i) => !(i === 0 && head(n)))); }
    else if (p.draft) out.push(...p.draft.nodes);
  }
  return { type: 'doc', content: out.length ? out : [{ type: 'paragraph' }] };
}
