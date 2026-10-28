export type Wbs = { id: string; parentId: string | null; title: string; description: string; effort: number | null; order: number; level: 1 | 2 | 3; source: string; ticket: { id: string; title: string; state: string } | null };
export type Charter = {
  status: 'Draft' | 'Approved'; generatedBy: string | null; intake: { problem?: string; sponsor?: string; goals?: string; constraints?: string }; approvedAt: string | null; approvedBy: string | null; updatedAt: string; hasContent: boolean;
  sections: Record<string, string>;
};
export type PlanningState = { ai: { provider: 'gemini' | 'offline'; model: string }; charter: Charter | null; wbs: Wbs[] };

export const LEVEL_NAME = { 1: 'Phase', 2: 'Deliverable', 3: 'Work package' } as const;

export const children = (rows: Wbs[], parentId: string | null) => rows.filter((r) => r.parentId === parentId).sort((a, b) => a.order - b.order);

/** Person-days under a node: a work package's own estimate, or the sum of its descendants'. */
export function effortOf(rows: Wbs[], id: string): number {
  const own = rows.find((r) => r.id === id);
  const kids = children(rows, id);
  return kids.length ? kids.reduce((n, k) => n + effortOf(rows, k.id), 0) : own?.effort ?? 0;
}
export const fmtDays = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Applies a move locally, the way the server will, so the board responds instantly. */
export function applyMove(rows: Wbs[], id: string, parentId: string | null, index: number): Wbs[] {
  const el = rows.find((r) => r.id === id);
  if (!el) return rows;
  const parentLevel = parentId ? rows.find((r) => r.id === parentId)?.level ?? 0 : 0;
  const shift = parentLevel + 1 - el.level;
  const subtree = new Set<string>([id]);
  for (let grew = true; grew;) { grew = false; for (const r of rows) if (r.parentId && subtree.has(r.parentId) && !subtree.has(r.id)) { subtree.add(r.id); grew = true; } }
  const oldParent = el.parentId;
  let next = rows.map((r) => (subtree.has(r.id) ? { ...r, level: (r.level + shift) as Wbs['level'], ...(r.id === id ? { parentId } : {}) } : r));
  const sibs = children(next, parentId).filter((r) => r.id !== id);
  sibs.splice(Math.max(0, Math.min(index, sibs.length)), 0, next.find((r) => r.id === id)!);
  const order = new Map(sibs.map((r, i) => [r.id, i]));
  if (oldParent !== parentId) children(next, oldParent).forEach((r, i) => order.set(r.id, i));
  next = next.map((r) => (order.has(r.id) ? { ...r, order: order.get(r.id)! } : r));
  return next;
}

/** Whether `id` can sit under `parentId` (null = top level) without breaking the three-level rule or looping. */
export function canMove(rows: Wbs[], id: string, parentId: string | null): boolean {
  const el = rows.find((r) => r.id === id);
  if (!el) return false;
  if (parentId === id) return false;
  const height = (x: string): number => 1 + Math.max(0, ...children(rows, x).map((c) => height(c.id)));
  let cur: string | null = parentId;
  while (cur) { if (cur === id) return false; cur = rows.find((r) => r.id === cur)?.parentId ?? null; }
  const parentLevel = parentId ? rows.find((r) => r.id === parentId)?.level ?? 0 : 0;
  return parentLevel + height(id) <= 3;
}

export interface DropTarget { parentId: string | null; index: number }
/** Turns "dropped X over Y" into a destination. Dropping next to something puts it beside it; dropping on a container puts it at the end. */
export function resolveDrop(rows: Wbs[], activeId: string, over: { id: string; container?: boolean }): DropTarget | null {
  const active = rows.find((r) => r.id === activeId);
  if (!active) return null;
  const ov = rows.find((r) => r.id === over.id);
  if (!ov) return null;
  const endOf = (p: string | null) => children(rows, p).filter((r) => r.id !== activeId).length;
  const beside = (target: Wbs): DropTarget => {
    const all = children(rows, target.parentId);
    const from = all.findIndex((r) => r.id === activeId), to = all.findIndex((r) => r.id === target.id);
    const base = all.filter((r) => r.id !== activeId).findIndex((r) => r.id === target.id);
    return { parentId: target.parentId, index: from !== -1 && from < to ? base + 1 : base };      // dragging down lands after the target, up lands before it
  };
  const ancestor = (r: Wbs, level: number): Wbs | undefined => { let c: Wbs | undefined = r; while (c && c.level > level) c = rows.find((x) => x.id === c!.parentId); return c; };
  if (over.container) return ov.level + 1 === active.level ? { parentId: ov.id, index: endOf(ov.id) } : null;     // an empty or open area of a parent
  if (ov.level === active.level) return beside(ov);
  if (ov.level === active.level - 1) return { parentId: ov.id, index: endOf(ov.id) };                          // dropped onto the parent itself: at its end
  if (ov.level > active.level) { const sib = ancestor(ov, active.level); return sib ? beside(sib) : null; }  // dropped onto a descendant of a peer: beside that peer
  return null;
}
