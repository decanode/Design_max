'use client';
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { DynamicFields } from './DynamicFields';
import { cleanValues, fieldsSchema, type TypeField } from '../lib/workflow';
import { j } from '../lib/auth';

type Level = 'hidden' | 'read' | 'write';

/** The ticket type's own fields (for example impact and urgency of an incident), shown and edited from the type's definition. */
export function TypeDetails({ ticketId, typeName, fields, values, access, onSaved }: {
  ticketId: string; typeName: string; fields: TypeField[]; values: Record<string, unknown> | undefined; access: Level | undefined; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const schema = useMemo(() => fieldsSchema(fields), [fields]);
  const defaults = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, values?.[f.key] ?? (f.kind === 'checkbox' ? false : '')])), [fields, values]);
  const { register, handleSubmit, formState: { errors, isSubmitting }, setError: setFieldError, reset } = useForm<Record<string, unknown>>({ resolver: zodResolver(schema) as never, defaultValues: defaults });

  if (!fields.length || !access || access === 'hidden' || !values) return null;

  async function save(v: Record<string, unknown>) {
    setError('');
    const r = await fetch(`/api/tickets/${ticketId}`, j({ dynamicMetadata: cleanValues(fields, v) }, 'PATCH'));
    const b = await r.json().catch(() => ({}));
    if (r.ok) { setEditing(false); onSaved(); return; }
    if (b.fieldErrors) for (const [k, m] of Object.entries(b.fieldErrors)) setFieldError(k, { message: String(m) });
    setError(b.error ?? 'Could not save');
  }
  const show = (f: TypeField) => { const v = values[f.key]; return v === undefined || v === '' ? null : f.kind === 'checkbox' ? (v ? 'Yes' : 'No') : String(v); };

  return (
    <section className="details" aria-label={`${typeName} details`}>
      <div className="row" style={{ margin: '0 0 8px', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>{typeName} details</h3>
        {access === 'write' && !editing && <button className="btn ghost sm" onClick={() => { reset(defaults); setEditing(true); }}>Edit {typeName} details</button>}
      </div>
      {error && <p role="alert" className="err">{error}</p>}
      {editing ? (
        <form onSubmit={handleSubmit(save)} noValidate>
          <DynamicFields fields={fields} register={register} errors={errors} idPrefix="td" />
          <div className="row"><button className="btn" disabled={isSubmitting}>Save details</button><button type="button" className="btn ghost" onClick={() => setEditing(false)}>Cancel</button></div>
        </form>
      ) : (
        <dl className="details-grid">
          {fields.map((f) => <div key={f.key} style={f.kind === 'textarea' ? { gridColumn: '1 / -1' } : undefined}><dt>{f.label}</dt><dd className={show(f) ? '' : 'empty'}>{show(f) ?? 'Not recorded'}</dd></div>)}
        </dl>)}
    </section>);
}
