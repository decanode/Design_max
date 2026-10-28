'use client';
import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import type { TypeField } from '../lib/workflow';

/** Renders the form fields of a ticket type, straight from its definition. */
export function DynamicFields({ fields, register, errors, idPrefix = 'f', disabled }: {
  fields: TypeField[]; register: UseFormRegister<any>; errors: FieldErrors<any>; idPrefix?: string; disabled?: boolean;
}) {
  return (
    <div className="dyn-fields">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`, err = errors[f.key]?.message as string | undefined;
        const label = <label htmlFor={id}>{f.label}{f.required && <span className="req" aria-hidden> *</span>}{f.required && <span className="sr"> (required)</span>}</label>;
        return (
          <div key={f.key} className={`field ${err ? 'invalid' : ''} ${f.kind === 'textarea' ? 'wide' : ''}`}>
            {f.kind === 'checkbox'
              ? <label className="check"><input id={id} type="checkbox" disabled={disabled} {...register(f.key)} /> {f.label}</label>
              : label}
            {f.kind === 'text' && <input id={id} disabled={disabled} aria-invalid={!!err} aria-describedby={err ? `${id}-e` : undefined} {...register(f.key)} />}
            {f.kind === 'number' && <input id={id} type="number" step="any" disabled={disabled} aria-invalid={!!err} {...register(f.key)} />}
            {f.kind === 'date' && <input id={id} type="date" disabled={disabled} aria-invalid={!!err} {...register(f.key)} />}
            {f.kind === 'textarea' && <textarea id={id} rows={3} disabled={disabled} aria-invalid={!!err} {...register(f.key)} />}
            {f.kind === 'select' && (
              <select id={id} disabled={disabled} aria-invalid={!!err} {...register(f.key)}>
                <option value="">Choose…</option>{f.options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>)}
            {f.help && !err && <span className="note">{f.help}</span>}
            {err && <span id={`${id}-e`} role="alert" className="err">{err}</span>}
          </div>);
      })}
    </div>);
}
