'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type Row = { label: string; value: number | null; parts?: Record<string, number> };
export type Result = {
  rows: Row[]; truncated: boolean; series?: string[];
  measure: { key: string; label: string; unit: string };
  dimension: { key: string; label: string; time?: 'day' | 'week' | 'month' | null } | null;
};
export type ChartKind = 'kpi' | 'bar' | 'column' | 'line' | 'share' | 'stack' | 'table';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmt(v: number | null, compact = false) {
  if (v == null) return '—';
  if (compact && Math.abs(v) >= 1000) return `${(v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
/** "2024-03" -> "Mar 24", "2024-03-10" -> "10 Mar". Other labels pass through. */
export function niceLabel(l: string, time?: string | null) {
  if (!time) return l;
  const [y, m, d] = l.split('-').map(Number);
  return time === 'month' ? `${MONTHS[m - 1]} ${String(y).slice(2)}` : `${d} ${MONTHS[m - 1]}`;
}
function ticks(max: number) {
  if (max <= 0) return [0, 1];
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

type Tip = { x: number; y: number; value: string; label: string; color?: string };
function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const flip = tip.x > width - 150;
  return (
    <div className="viz-tip" style={{ left: tip.x, top: tip.y, transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -50%)` }} role="presentation">
      <strong>{tip.value}</strong>
      <span><i style={{ background: tip.color ?? 'var(--series-1)' }} aria-hidden />{tip.label}</span>
    </div>
  );
}

/** Rounded data-end (4px) on one side, square at the baseline. */
const colPath = (x: number, y: number, w: number, h: number) => { const r = Math.min(4, w / 2, h); return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`; };
const barPath = (x: number, y: number, w: number, h: number) => { const r = Math.min(4, h / 2, w); return `M${x},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x} Z`; };

function Kpi({ r }: { r: Result }) {
  const v = r.rows[0]?.value ?? null;
  return (
    <div className="viz-kpi" aria-label={`${r.measure.label}: ${fmt(v)}`}>
      <span className="viz-kpi-value">{fmt(v)}</span>
      {r.measure.unit && v != null && r.measure.unit !== r.measure.label.toLowerCase() && <span className="viz-kpi-unit">{r.measure.unit}</span>}
    </div>
  );
}

function Column({ r }: { r: Result }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const H = 230, m = { l: 38, r: 8, t: 14, b: 30 };
  const rows = r.rows, max = Math.max(...rows.map((x) => x.value ?? 0), 0);
  const tk = ticks(max), top = tk[tk.length - 1] || 1;
  const iw = Math.max(w - m.l - m.r, 10), ih = H - m.t - m.b, band = iw / Math.max(rows.length, 1);
  const bw = Math.min(24, band * 0.62), every = Math.ceil(rows.length / Math.max(Math.floor(iw / 62), 1));
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const showVals = band >= 30;
  return (
    <div ref={ref} className="viz-wrap">
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={`${r.measure.label} by ${r.dimension?.label}`}>
          {tk.map((t) => (<g key={t}><line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
            <text x={m.l - 6} y={y(t) + 4} textAnchor="end" className="viz-tick">{fmt(t, true)}</text></g>))}
          {rows.map((d, i) => {
            const cx = m.l + band * i + band / 2, h = ((d.value ?? 0) / top) * ih;
            const label = niceLabel(d.label, r.dimension?.time);
            return (
              <g key={d.label}>
                {h > 0 && <path d={colPath(cx - bw / 2, y(d.value ?? 0), bw, h)} className="viz-mark" style={{ opacity: hot === null || hot === i ? 1 : 0.55 }} />}
                {showVals && h > 0 && <text x={cx} y={y(d.value ?? 0) - 5} textAnchor="middle" className="viz-val">{fmt(d.value, true)}</text>}
                {i % every === 0 && <text x={cx} y={H - 10} textAnchor="middle" className="viz-tick">{(() => { const max = Math.max(6, Math.floor((band * every - 6) / 6.2)); return label.length > max ? `${label.slice(0, max - 1)}…` : label; })()}</text>}
                <rect x={m.l + band * i} y={m.t} width={band} height={ih + 4} fill="transparent" tabIndex={0} aria-label={`${label}: ${fmt(d.value)}`} className="viz-hit"
                  onPointerMove={(e) => { const b = ref.current!.getBoundingClientRect(); setHot(i); setTip({ x: e.clientX - b.left, y: Math.min(e.clientY - b.top, H - 30), value: fmt(d.value), label }); }}
                  onPointerLeave={() => { setHot(null); setTip(null); }}
                  onFocus={() => { setHot(i); setTip({ x: cx, y: y(d.value ?? 0), value: fmt(d.value), label }); }} onBlur={() => { setHot(null); setTip(null); }} />
              </g>);
          })}
        </svg>)}
      <Tooltip tip={tip} width={w} />
    </div>
  );
}

function HBar({ r }: { r: Result }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const [hot, setHot] = useState<number | null>(null);
  const rows = r.rows, row = 30, H = rows.length * row + 8;
  const max = Math.max(...rows.map((x) => x.value ?? 0), 1);
  const labelW = Math.min(150, Math.max(80, Math.floor(w * 0.34)));
  const iw = Math.max(w - labelW - 54, 10);
  return (
    <div ref={ref} className="viz-wrap">
      {w > 0 && (
        <svg width={w} height={H} role="img" aria-label={`${r.measure.label} by ${r.dimension?.label}`}>
          <line x1={labelW} x2={labelW} y1={0} y2={H} className="viz-axis" />
          {rows.map((d, i) => {
            const bw = ((d.value ?? 0) / max) * iw, y = i * row + 5;
            const lab = d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label;
            return (
              <g key={d.label}>
                <text x={labelW - 8} y={y + 14} textAnchor="end" className="viz-tick viz-cat">{lab}</text>
                {bw > 0 && <path d={barPath(labelW, y, bw, 20)} className="viz-mark" style={{ opacity: hot === null || hot === i ? 1 : 0.55 }} />}
                <text x={labelW + bw + 7} y={y + 14} className="viz-val" textAnchor="start">{fmt(d.value, true)}</text>
                <rect x={0} y={i * row} width={w} height={row} fill="transparent" tabIndex={0} aria-label={`${d.label}: ${fmt(d.value)}`} className="viz-hit"
                  onPointerMove={(e) => { const b = ref.current!.getBoundingClientRect(); setHot(i); setTip({ x: e.clientX - b.left, y: e.clientY - b.top, value: fmt(d.value), label: d.label }); }}
                  onPointerLeave={() => { setHot(null); setTip(null); }}
                  onFocus={() => { setHot(i); setTip({ x: labelW + bw, y: y + 10, value: fmt(d.value), label: d.label }); }} onBlur={() => { setHot(null); setTip(null); }} />
              </g>);
          })}
        </svg>)}
      <Tooltip tip={tip} width={w} />
    </div>
  );
}

function Line({ r }: { r: Result }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [i, setI] = useState<number | null>(null);
  const H = 230, m = { l: 38, r: 16, t: 14, b: 30 };
  const rows = r.rows, n = rows.length;
  const max = Math.max(...rows.map((x) => x.value ?? 0), 0), tk = ticks(max), top = tk[tk.length - 1] || 1;
  const iw = Math.max(w - m.l - m.r, 10), ih = H - m.t - m.b;
  const x = (k: number) => m.l + (n === 1 ? iw / 2 : (k / (n - 1)) * iw), y = (v: number) => m.t + ih - (v / top) * ih;
  const pts = rows.map((d, k) => [x(k), y(d.value ?? 0)] as const);
  const path = pts.map(([px, py], k) => `${k ? 'L' : 'M'}${px},${py}`).join(' ');
  const every = Math.ceil(n / Math.max(Math.floor(iw / 58), 1)), last = pts[n - 1];
  const nearest = (clientX: number) => { const b = ref.current!.getBoundingClientRect(); const rel = (clientX - b.left - m.l) / iw; return Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1)))); };
  const cur = i === null ? null : rows[i];
  return (
    <div ref={ref} className="viz-wrap">
      {w > 0 && n > 0 && (
        <svg width={w} height={H} role="img" aria-label={`${r.measure.label} over time`}>
          {tk.map((t) => (<g key={t}><line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
            <text x={m.l - 6} y={y(t) + 4} textAnchor="end" className="viz-tick">{fmt(t, true)}</text></g>))}
          {n > 1 && <path d={`${path} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`} className="viz-area" />}
          <path d={path} className="viz-line" />
          {rows.map((d, k) => k % every === 0 && <text key={d.label} x={x(k)} y={H - 10} textAnchor="middle" className="viz-tick">{niceLabel(d.label, r.dimension?.time)}</text>)}
          {i === null && last && <><circle cx={last[0]} cy={last[1]} r={6} className="viz-ring" /><circle cx={last[0]} cy={last[1]} r={4} className="viz-dot" />
            <text x={last[0]} y={last[1] - 11} textAnchor="end" className="viz-val">{fmt(rows[n - 1].value, true)}</text></>}
          {i !== null && <><line x1={pts[i][0]} x2={pts[i][0]} y1={m.t} y2={y(0)} className="viz-cross" />
            <circle cx={pts[i][0]} cy={pts[i][1]} r={6} className="viz-ring" /><circle cx={pts[i][0]} cy={pts[i][1]} r={4} className="viz-dot" /></>}
          <rect x={m.l} y={m.t} width={iw} height={ih + 4} fill="transparent" tabIndex={0} className="viz-hit" aria-label="Chart data; use left and right arrow keys to read each point"
            onPointerMove={(e) => setI(nearest(e.clientX))} onPointerLeave={() => setI(null)} onBlur={() => setI(null)}
            onFocus={() => setI(n - 1)}
            onKeyDown={(e) => { if (e.key === 'ArrowRight') { e.preventDefault(); setI((v) => Math.min(n - 1, (v ?? -1) + 1)); } if (e.key === 'ArrowLeft') { e.preventDefault(); setI((v) => Math.max(0, (v ?? 1) - 1)); } if (e.key === 'Escape') setI(null); }} />
        </svg>)}
      {i !== null && cur && <Tooltip tip={{ x: pts[i][0], y: pts[i][1], value: fmt(cur.value), label: niceLabel(cur.label, r.dimension?.time) }} width={w} />}
    </div>
  );
}

const SLOTS = [1, 2, 3, 4, 5, 6, 7].map((n) => `var(--series-${n})`);
function Share({ r }: { r: Result }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const rows = r.rows.filter((d) => (d.value ?? 0) > 0);
  const total = rows.reduce((a, d) => a + (d.value ?? 0), 0);
  const colorOf = (d: Row, i: number) => (d.label.startsWith('Other') ? 'var(--viz-other)' : SLOTS[i % SLOTS.length]);
  const BAR = 24, GAP = 2;
  let acc = 0;
  if (!total) return <p className="note viz-empty">No data</p>;
  return (
    <div ref={ref} className="viz-wrap">
      {w > 0 && (
        <svg width={w} height={BAR + 4} role="img" aria-label={`${r.measure.label} by ${r.dimension?.label}, share of total`}>
          <clipPath id="share-clip"><rect x={0} y={2} width={w} height={BAR} rx={4} /></clipPath>
          <g clipPath="url(#share-clip)">
            {rows.map((d, i) => {
              const sw = ((d.value ?? 0) / total) * w, x = acc; acc += sw;
              return <rect key={d.label} x={x} y={2} width={Math.max(sw - (i < rows.length - 1 ? GAP : 0), 0)} height={BAR} fill={colorOf(d, i)} tabIndex={0}
                aria-label={`${d.label}: ${fmt(d.value)} (${Math.round(((d.value ?? 0) / total) * 100)}%)`} className="viz-seg"
                onPointerMove={(e) => { const b = ref.current!.getBoundingClientRect(); setTip({ x: e.clientX - b.left, y: 30, value: fmt(d.value), label: d.label, color: colorOf(d, i) }); }}
                onPointerLeave={() => setTip(null)} onFocus={() => setTip({ x: x + sw / 2, y: 30, value: fmt(d.value), label: d.label, color: colorOf(d, i) })} onBlur={() => setTip(null)} />;
            })}
          </g>
        </svg>)}
      <Tooltip tip={tip} width={w} />
      <ul className="viz-legend">
        {rows.map((d, i) => (
          <li key={d.label}><i style={{ background: colorOf(d, i) }} aria-hidden /><span>{d.label}</span>
            <b>{fmt(d.value)}</b><span className="note">{Math.round(((d.value ?? 0) / total) * 100)}%</span></li>))}
      </ul>
    </div>
  );
}

/** Columns divided into coloured parts: how the whole (a day's pipeline, a week's work) is made up. */
function Stack({ r }: { r: Result }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const series = r.series ?? [];
  const colorOf = (k: string, i: number) => (k === 'Other' ? 'var(--viz-other)' : SLOTS[i % SLOTS.length]);
  const rows = r.rows, n = rows.length;
  const max = Math.max(...rows.map((d) => d.value ?? 0), 0);
  const tk = ticks(max), top = tk[tk.length - 1] || 1;
  const H = 240, m = { l: 40, r: 8, t: 12, b: 28 }, iw = Math.max(w - m.l - m.r, 10), ih = H - m.t - m.b;
  const slot = iw / Math.max(n, 1), bw = Math.max(Math.min(slot * 0.72, 44), 2);
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const every = Math.ceil(n / Math.max(Math.floor(iw / 58), 1));
  return (
    <div ref={ref} className="viz-wrap">
      {w > 0 && n > 0 && (
        <svg width={w} height={H} role="img" aria-label={`${r.measure.label} by ${r.dimension?.label}, divided by ${series.join(', ')}`}>
          {tk.map((t) => (<g key={t}><line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} /><text x={m.l - 6} y={y(t) + 4} textAnchor="end" className="viz-tick">{fmt(t, true)}</text></g>))}
          {rows.map((d, k) => {
            const x = m.l + slot * k + (slot - bw) / 2; let acc = 0;
            return (
              <g key={d.label}>
                {series.map((sname, si) => {
                  const v = d.parts?.[sname] ?? 0; if (!v) return null;
                  const y0 = y(acc + v), h = y(acc) - y0; acc += v;
                  return <rect key={sname} x={x} y={y0} width={bw} height={Math.max(h, 0.5)} fill={colorOf(sname, si)} className="viz-seg" tabIndex={0} aria-label={`${niceLabel(d.label, r.dimension?.time)}, ${sname}: ${fmt(v)}`}
                    onPointerMove={(e) => { const b = ref.current!.getBoundingClientRect(); setTip({ x: e.clientX - b.left, y: e.clientY - b.top, value: fmt(v), label: `${sname} · ${niceLabel(d.label, r.dimension?.time)}`, color: colorOf(sname, si) }); }}
                    onPointerLeave={() => setTip(null)} onFocus={() => setTip({ x: x + bw / 2, y: y0, value: fmt(v), label: `${sname} · ${niceLabel(d.label, r.dimension?.time)}`, color: colorOf(sname, si) })} onBlur={() => setTip(null)} />;
                })}
                {k % every === 0 && <text x={x + bw / 2} y={H - 10} textAnchor="middle" className="viz-tick">{niceLabel(d.label, r.dimension?.time)}</text>}
              </g>);
          })}
        </svg>)}
      <Tooltip tip={tip} width={w} />
      <ul className="viz-legend">{series.map((k, i) => <li key={k}><i style={{ background: colorOf(k, i) }} aria-hidden /><span>{k}</span></li>)}</ul>
    </div>
  );
}

export function DataTable({ r }: { r: Result }) {
  if (r.series) return (
    <table className="viz-table">
      <thead><tr><th scope="col">{r.dimension?.label}</th>{r.series.map((k) => <th key={k} scope="col" className="num">{k}</th>)}<th scope="col" className="num">Total</th></tr></thead>
      <tbody>{r.rows.map((d) => <tr key={d.label}><th scope="row">{niceLabel(d.label, r.dimension?.time)}</th>{r.series!.map((k) => <td key={k} className="num">{fmt(d.parts?.[k] ?? 0)}</td>)}<td className="num">{fmt(d.value)}</td></tr>)}</tbody>
    </table>
  );
  return (
    <table className="viz-table">
      <thead><tr><th scope="col">{r.dimension?.label ?? 'Measure'}</th><th scope="col" className="num">{r.measure.label}</th></tr></thead>
      <tbody>{r.rows.map((d) => <tr key={d.label}><th scope="row">{niceLabel(d.label, r.dimension?.time)}</th><td className="num">{fmt(d.value)}</td></tr>)}</tbody>
    </table>
  );
}

/** Renders one report result in the form its definition asks for. `asTable` forces the accessible table view. */
export function ChartView({ chart, result, asTable }: { chart: ChartKind; result: Result; asTable?: boolean }): ReactNode {
  if (!result.rows.length) return <p className="note viz-empty">No data for this report yet.</p>;
  if (asTable || chart === 'table') return <DataTable r={result} />;
  switch (chart) {
    case 'kpi': return <Kpi r={result} />;
    case 'column': return <Column r={result} />;
    case 'bar': return <HBar r={result} />;
    case 'line': return <Line r={result} />;
    case 'share': return <Share r={result} />;
    case 'stack': return <Stack r={result} />;
  }
}
