'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { AnimatePresence, motion } from 'framer-motion';
import { InlineText } from './InlineText';
import { LEVEL_NAME, canMove, children, effortOf, fmtDays, resolveDrop, type Wbs } from '../lib/planning';

export interface WbsActions {
  add: (parentId: string | null) => Promise<string | null>;
  update: (id: string, patch: { title?: string; description?: string; effort?: number | null }) => Promise<void>;
  move: (id: string, parentId: string | null, index: number) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

const containerId = (parent: string) => `c:${parent}`;

/** Picks the most specific thing under the pointer: a peer of the dragged item first, then the area of a parent, then the nearest item. */
const collide: CollisionDetection = (args) => {
  const hits = pointerWithin(args).filter((h) => h.id !== args.active.id);
  const activeLevel = args.active.data.current?.level as number | undefined;
  const peer = hits.find((h) => args.droppableContainers.find((c) => c.id === h.id)?.data.current?.level === activeLevel);
  if (peer) return [peer];
  const area = hits.find((h) => String(h.id).startsWith('c:'));
  if (area) return [area];
  return hits.length ? [hits[0]] : closestCenter(args).filter((h) => h.id !== args.active.id).slice(0, 1);
};

function DropArea({ parent, accepts, children: kids, className }: { parent: string; accepts: number; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: containerId(parent), data: { container: true, parentId: parent, accepts } });
  return <div ref={setNodeRef} className={`${className ?? ''} ${isOver ? 'over' : ''}`}>{kids}</div>;
}

type SortableProps = { id: string; level: number; render: (p: { setHandle: (el: HTMLElement | null) => void; handleProps: Record<string, unknown>; dragging: boolean }) => React.ReactNode; as?: 'li' | 'div'; className?: string; label: string; role?: string };
function Sortable({ id, level, render, className, label }: SortableProps) {
  const s = useSortable({ id, data: { level } });
  return (
    <div ref={s.setNodeRef} style={{ transform: CSS.Transform.toString(s.transform), transition: s.transition, opacity: s.isDragging ? 0.35 : 1 }} className={className} role="group" aria-label={label}>
      {render({ setHandle: s.setActivatorNodeRef, handleProps: { ...s.attributes, ...s.listeners }, dragging: s.isDragging })}
    </div>);
}

export function WbsBoard({ rows, actions, selected, setSelected, editingId, clearEditing }: {
  rows: Wbs[]; actions: WbsActions; selected: Set<string>; setSelected: (s: Set<string>) => void; editingId: string | null; clearEditing: () => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const phases = children(rows, null);
  const active = rows.find((r) => r.id === activeId) ?? null;

  function onDragEnd(e: DragEndEvent) {
    setActiveId(null);
    if (!e.over) return;
    const overData = e.over.data.current as { container?: boolean; parentId?: string } | undefined;
    const target = resolveDrop(rows, String(e.active.id), overData?.container ? { id: overData.parentId!, container: true } : { id: String(e.over.id) });
    if (!target) return;
    const cur = rows.find((r) => r.id === e.active.id)!;
    const sibs = children(rows, cur.parentId);
    if (target.parentId === cur.parentId && sibs.findIndex((r) => r.id === cur.id) === target.index) return;
    if (!canMove(rows, cur.id, target.parentId)) return;
    void actions.move(cur.id, target.parentId, target.index);
  }

  const toggle = (id: string) => { const s = new Set(selected); if (s.has(id)) s.delete(id); else s.add(id); setSelected(s); };
  const deliverables = rows.filter((r) => r.level === 2);

  return (
    <DndContext sensors={sensors} collisionDetection={collide} onDragStart={(e: DragStartEvent) => setActiveId(String(e.active.id))} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
      <div className="wbs-board" role="region" aria-label="Work breakdown structure">
        <SortableContext items={phases.map((p) => p.id)} strategy={horizontalListSortingStrategy}>
          <AnimatePresence initial={false}>
            {phases.map((ph, pi) => {
              const dels = children(rows, ph.id);
              return (
                <motion.div key={ph.id} layout="position" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.16 }} className="wbs-col-wrap">
                  <Sortable id={ph.id} level={1} label={`Phase ${ph.title}`} className="wbs-col" render={({ setHandle, handleProps }) => (<>
                    <header className="wbs-col-head">
                      <button type="button" ref={setHandle as never} className="grip" aria-label={`Drag phase ${ph.title}`} {...handleProps}>⋮⋮</button>
                      <span className="wbs-num">{pi + 1}</span>
                      <InlineText value={ph.title} label="phase title" onSave={(v) => actions.update(ph.id, { title: v })} startEditing={editingId === ph.id} onStarted={clearEditing} className="t-phase" />
                      <span className="chip" title="Total person-days in this phase">{fmtDays(effortOf(rows, ph.id))}d</span>
                      <button type="button" className="icon-btn" aria-label={`Move phase ${ph.title} earlier`} disabled={pi === 0} onClick={() => actions.move(ph.id, null, pi - 1)}>◀</button>
                      <button type="button" className="icon-btn" aria-label={`Move phase ${ph.title} later`} disabled={pi === phases.length - 1} onClick={() => actions.move(ph.id, null, pi + 1)}>▶</button>
                      <button type="button" className="icon-btn danger" aria-label={`Delete phase ${ph.title}`} onClick={() => confirm(`Delete the phase “${ph.title}” and everything in it?`) && actions.remove(ph.id)}>✕</button>
                    </header>
                    <InlineText value={ph.description} label="phase description" multiline placeholder="Add a description" onSave={(v) => actions.update(ph.id, { description: v })} className="t-desc" />
                    <SortableContext items={dels.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                      <DropArea parent={ph.id} accepts={2} className="wbs-dels">
                        {dels.map((d) => {
                          const wps = children(rows, d.id);
                          return (
                            <Sortable key={d.id} id={d.id} level={2} label={`Deliverable ${d.title}`} className="wbs-del" render={({ setHandle, handleProps }) => (<>
                              <header className="wbs-del-head">
                                <button type="button" ref={setHandle as never} className="grip" aria-label={`Drag deliverable ${d.title}`} {...handleProps}>⋮⋮</button>
                                <InlineText value={d.title} label="deliverable title" onSave={(v) => actions.update(d.id, { title: v })} startEditing={editingId === d.id} onStarted={clearEditing} className="t-del" />
                                <span className="chip" title="Person-days in this deliverable">{fmtDays(effortOf(rows, d.id))}d</span>
                                <select className="move-select" aria-label={`Move deliverable ${d.title} to`} value="" onChange={(e) => e.target.value && actions.move(d.id, e.target.value, children(rows, e.target.value).length)}>
                                  <option value="">Move to…</option>{phases.filter((p) => p.id !== d.parentId).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                                </select>
                                <button type="button" className="icon-btn danger" aria-label={`Delete deliverable ${d.title}`} onClick={() => confirm(`Delete the deliverable “${d.title}”?`) && actions.remove(d.id)}>✕</button>
                              </header>
                              <InlineText value={d.description} label="deliverable description" multiline placeholder="Add a description" onSave={(v) => actions.update(d.id, { description: v })} className="t-desc" />
                              <SortableContext items={wps.map((w) => w.id)} strategy={verticalListSortingStrategy}>
                                <DropArea parent={d.id} accepts={3} className="wbs-wps">
                                  {wps.map((w) => (
                                    <Sortable key={w.id} id={w.id} level={3} label={`Work package ${w.title}`} className={`wbs-wp ${w.ticket ? 'converted' : ''}`} render={({ setHandle, handleProps }) => (<>
                                      <button type="button" ref={setHandle as never} className="grip" aria-label={`Drag work package ${w.title}`} {...handleProps}>⋮⋮</button>
                                      <input type="checkbox" aria-label={`Select ${w.title}`} checked={selected.has(w.id)} disabled={!!w.ticket} onChange={() => toggle(w.id)} />
                                      <InlineText value={w.title} label="work package title" onSave={(v) => actions.update(w.id, { title: v })} startEditing={editingId === w.id} onStarted={clearEditing} className="t-wp" />
                                      <InlineText value={w.effort == null ? '' : String(w.effort)} label="effort in person-days" numeric placeholder="– d" onSave={(v) => actions.update(w.id, { effort: v === '' ? null : Number(v) })} className="t-effort" />
                                      {w.ticket
                                        ? <Link className="tag ticket-tag" href={`/tickets/${w.ticket.id}`} title={w.ticket.title}>Ticket · {w.ticket.state}</Link>
                                        : <select className="move-select" aria-label={`Move work package ${w.title} to`} value="" onChange={(e) => e.target.value && actions.move(w.id, e.target.value, children(rows, e.target.value).length)}>
                                            <option value="">Move to…</option>{deliverables.filter((x) => x.id !== w.parentId).map((x) => <option key={x.id} value={x.id}>{rows.find((p) => p.id === x.parentId)?.title} › {x.title}</option>)}
                                          </select>}
                                      {!w.ticket && <button type="button" className="icon-btn danger" aria-label={`Delete work package ${w.title}`} onClick={() => actions.remove(w.id)}>✕</button>}
                                    </>)} />
                                  ))}
                                  {wps.length === 0 && <p className="note wbs-empty">No work packages yet.</p>}
                                </DropArea>
                              </SortableContext>
                              <button type="button" className="add-btn" onClick={() => actions.add(d.id)}>+ Add work package</button>
                            </>)} />
                          );
                        })}
                        {dels.length === 0 && <p className="note wbs-empty">No deliverables yet.</p>}
                      </DropArea>
                    </SortableContext>
                    <button type="button" className="add-btn" onClick={() => actions.add(ph.id)}>+ Add deliverable</button>
                  </>)} />
                </motion.div>);
            })}
          </AnimatePresence>
        </SortableContext>
        <button type="button" className="add-phase" onClick={() => actions.add(null)}>+ Add phase</button>
      </div>
      <DragOverlay dropAnimation={{ duration: 160 }}>
        {active ? <div className={`wbs-ghost lvl${active.level}`}><span className="note">{LEVEL_NAME[active.level]}</span><b>{active.title}</b></div> : null}
      </DragOverlay>
    </DndContext>);
}
