'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, type FieldErrors } from 'react-hook-form';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { DynamicFields } from './DynamicFields';
import { cleanValues, fieldsSchema, type TicketType, type Workflow } from '../lib/workflow';
import { j } from '../lib/auth';

/** The form for one ticket type. It is remounted when the type changes, so validation always matches the visible fields. */
function ItemForm({ type, onCreated, onCancel }: { type: TicketType; onCreated: () => void; onCancel: () => void }) {
  const [serverError, setServerError] = useState('');
  const schema = useMemo(() => fieldsSchema(type.fields).extend({ title: z.string().trim().min(1, 'Give the item a title').max(300) }), [type]);
  const defaults = useMemo(() => ({ title: '', ...Object.fromEntries(type.fields.map((f) => [f.key, f.kind === 'checkbox' ? false : ''])) }), [type]);
  const { register, getValues, watch } = useForm<Record<string, unknown>>({ defaultValues: defaults });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [isSubmitting, setSubmitting] = useState(false);
  const errors = Object.fromEntries(Object.entries(errs).map(([k, message]) => [k, { type: "custom", message }])) as FieldErrors;
  // editing a field clears its message
  useEffect(() => { const sub = watch((_v, { name }) => { if (name) setErrs((e) => (name in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== name)) : e)); }); return () => sub.unsubscribe(); }, [watch]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setServerError('');
    const values = getValues();
    const parsed = schema.safeParse(values);          // the same rules as the server, from the field definitions
    if (!parsed.success) {
      const m: Record<string, string> = {};
      for (const i of parsed.error.issues) { const k = String(i.path[0]); if (!(k in m)) m[k] = i.message; }
      setErrs(m);
      queueMicrotask(() => document.querySelector<HTMLElement>('.create-dialog [aria-invalid="true"]')?.focus());
      return;
    }
    setErrs({}); setSubmitting(true);
    const r = await fetch('/api/tickets', j({ title: String(values.title).trim(), ticketTypeId: type.id, dynamicMetadata: cleanValues(type.fields, values) }));
    setSubmitting(false);
    if (r.ok) { onCreated(); return; }
    const b = await r.json().catch(() => ({}));
    if (b.fieldErrors) setErrs(Object.fromEntries(Object.entries(b.fieldErrors).map(([k, m]) => [k, String(m)])));
    setServerError(b.fieldErrors ? 'Some details need attention.' : b.error ?? 'Could not create the item.');
  }

  return (
    <motion.form onSubmit={submit} noValidate initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}>
      <div className="field">
        <label htmlFor="ci-title">Title <span className="req" aria-hidden>*</span></label>
        <input id="ci-title" autoFocus autoComplete="off" aria-invalid={!!errors.title} {...register('title')} />
        {errors.title && <span role="alert" className="err">{errors.title.message as string}</span>}
      </div>
      {type.fields.length > 0 && <h4 className="mini" style={{ margin: '14px 0 8px' }}>{type.name} details</h4>}
      <DynamicFields fields={type.fields} register={register} errors={errors} idPrefix="ci" />
      {serverError && <p role="alert" className="err">{serverError}</p>}
      <div className="row">
        <button className="btn" type="submit" disabled={isSubmitting}>{isSubmitting ? 'Creating…' : `Create ${type.name}`}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </motion.form>);
}

/** "Create item": choose what kind of ticket, then fill in the fields that kind needs. */
export function CreateItemDialog({ wf, onClose, onCreated }: { wf: Workflow; onClose: () => void; onCreated: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const types = wf.ticketTypes.filter((t) => t.enabled);
  const [typeId, setTypeId] = useState<number>((types.find((t) => t.isDefault) ?? types[0])?.id);
  const type = types.find((t) => t.id === typeId) as TicketType;
  useEffect(() => { ref.current?.showModal(); }, []);

  return (
    <dialog ref={ref} className="create-dialog" aria-labelledby="create-title" onClose={onClose} onCancel={onClose}>
      <h3 id="create-title" style={{ marginTop: 0 }}>Create item</h3>
      <fieldset className="type-picker" aria-label="Type of item">
        <legend className="sr">Type of item</legend>
        {types.map((t) => (
          <label key={t.id} className={`type-card ${t.id === typeId ? 'on' : ''}`}>
            <input type="radio" name="ticketType" value={t.id} checked={t.id === typeId} onChange={() => setTypeId(t.id)} />
            <span className="type-short">{t.short}</span><b>{t.name}</b><span className="note">{t.description}</span>
          </label>))}
      </fieldset>
      <ItemForm key={type.id} type={type} onCreated={() => { onCreated(); ref.current?.close(); }} onCancel={() => ref.current?.close()} />
    </dialog>);
}
