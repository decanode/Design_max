'use client';
import { useEffect, useRef, useState } from 'react';

/** Text that edits in place: click (or press Enter on it) to edit, Enter or leaving the field saves, Escape cancels. */
export function InlineText({ value, onSave, label, multiline, placeholder, startEditing, onStarted, numeric, className }: {
  value: string; onSave: (v: string) => void | Promise<void>; label: string; multiline?: boolean; placeholder?: string; startEditing?: boolean; onStarted?: () => void; numeric?: boolean; className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (startEditing) { setDraft(value); setEditing(true); onStarted?.(); } }, [startEditing]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select(); } }, [editing]);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const commit = async () => { setEditing(false); const v = draft.trim(); if (v !== value.trim() && (v || numeric || multiline)) await onSave(v); else setDraft(value); };
  if (!editing) {
    return (
      <button type="button" className={`inline-text ${value ? '' : 'empty'} ${className ?? ''}`} aria-label={`Edit ${label}`} onClick={() => setEditing(true)}>
        {value || placeholder || 'Click to add'}
      </button>);
  }
  const common = {
    ref, 'aria-label': label, value: draft, className: `inline-input ${className ?? ''}`,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Escape') { setDraft(value); setEditing(false); } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.target as HTMLElement).blur(); } },
  };
  return multiline ? <textarea rows={3} {...common} /> : <input {...common} type={numeric ? 'number' : 'text'} step={numeric ? 0.5 : undefined} min={numeric ? 0 : undefined} />;
}
