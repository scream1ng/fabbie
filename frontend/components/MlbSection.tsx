'use client';

import { useEffect, useState } from 'react';

export interface BomRow {
  p: string; d: string; proc: string; qty: string; lvl: number;
  unit_cost?: string; qty_type?: 'use' | 'amortise';
  setup_min?: number; pcs_per_hour?: number; rate_per_hour?: number;
  margin?: number;
}

interface MlbSectionProps {
  rows?: BomRow[];
  onRowsChange?: (rows: BomRow[]) => void;
  moq?: number;
  onMoqChange?: (n: number) => void;
}

const COLS = '72px 150px 60px 1fr 48px 68px 62px 52px 64px';

// Auto-fill when user sets proc to a known value.
// Explicit undefined clears conflicting fields when switching type.
// ECOAT is flat $/part (same model as RAW), not rate/pcs
const PROC_PRESETS: Record<string, Partial<BomRow>> = {
  LASER: { rate_per_hour: 150, setup_min: 15, unit_cost: undefined, qty_type: undefined },
  BEND:  { rate_per_hour: 110, setup_min: 15, unit_cost: undefined, qty_type: undefined },
  WELD:  { rate_per_hour: 95,  setup_min: 15, unit_cost: undefined, qty_type: undefined },
  ECOAT: { unit_cost: '0', qty_type: 'use', rate_per_hour: undefined, pcs_per_hour: undefined, setup_min: undefined },
  RAW:   { unit_cost: '0', qty_type: 'use', rate_per_hour: undefined, pcs_per_hour: undefined, setup_min: undefined },
};

// Process letter suffix (backward from finished): ECOAT→E, BEND→B, LASER→L
// Convention: 818001LB = laser-cut blank that will be bent (L prepended before B)
const PROC_SUFFIX: Record<string, string> = { ECOAT: 'E', BEND: 'B', LASER: 'L' };
const PROC_FULL_NAME: Record<string, string> = { ECOAT: 'E-COAT', WELD: 'WELD', BEND: 'BEND', LASER: 'LASER', RAW: 'RAW' };

function splitPartSuffix(p: string): { base: string; suffix: string } {
  const chars = new Set(Object.values(PROC_SUFFIX));
  let i = p.length;
  while (i > 0 && chars.has(p[i - 1])) i--;
  return { base: p.slice(0, i), suffix: p.slice(i) };
}

function suggestPartNumber(parentP: string, proc: string): string {
  const letter = PROC_SUFFIX[proc.toUpperCase()];
  if (!letter) return '';
  const { base, suffix } = splitPartSuffix(parentP);
  return base + letter + suffix;
}

function suggestDescription(parentD: string, proc: string): string {
  const fullName = PROC_FULL_NAME[proc.toUpperCase()] ?? proc.toUpperCase();
  const base = parentD.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return (base ? base + ' ' : '') + '(' + fullName + ')';
}

function findParentRow(rows: BomRow[], idx: number): BomRow | undefined {
  const lvl = rows[idx].lvl;
  for (let i = idx - 1; i >= 0; i--) {
    if (rows[i].lvl < lvl) return rows[i];
  }
  return undefined;
}

const DEFAULT_ROWS: BomRow[] = [
  { p: '826806',     d: 'Bracket Service 140mm Dia',          proc: 'FG',       qty: '1', lvl: 0 },
  { p: '202720H',    d: '140 Tramway - Top (GAL)',             proc: 'Gal',      qty: '1', lvl: 1, rate_per_hour: 80,  pcs_per_hour: 20, setup_min: 30 },
  { p: '202720BH',   d: '140 Tramway - Top (Bend)',            proc: 'BEND',     qty: '1', lvl: 2, rate_per_hour: 110, pcs_per_hour: 30, setup_min: 15 },
  { p: '202720SBH',  d: '140 Tramway - Top (Crop & Pierce)',   proc: 'LASER',    qty: '1', lvl: 3, rate_per_hour: 150, pcs_per_hour: 40, setup_min: 15 },
  { p: '702126',     d: 'Flat Bar 40 x 10mm',                  proc: 'RAW',      qty: '1', lvl: 4, unit_cost: '8.50',  qty_type: 'use' },
  { p: 'GAL:202720', d: 'Galvanising - 140 Tramway - Top',     proc: 'OUTPLANT', qty: '1', lvl: 2, rate_per_hour: 80,  pcs_per_hour: 15, setup_min: 60 },
  { p: '202721H',    d: '140 Tramway - Bottom',                proc: '',         qty: '1', lvl: 1 },
  { p: '202721WH',   d: '140 Tramway - Bottom (Weld)',         proc: 'WELD',     qty: '1', lvl: 2, rate_per_hour: 95,  pcs_per_hour: 60, setup_min: 15 },
  { p: '202721BWH',  d: '140 Tramway - Bottom (Bend)',         proc: 'BEND',     qty: '1', lvl: 3, rate_per_hour: 110, pcs_per_hour: 30, setup_min: 15 },
  { p: '202721SBWH', d: '140 Tramway - Bottom (Crop & Tap)',   proc: 'LASER',    qty: '1', lvl: 4, rate_per_hour: 150, pcs_per_hour: 40, setup_min: 15 },
  { p: '702151',     d: 'Round Bar 12.0mm',                    proc: 'RAW',      qty: '1', lvl: 5, unit_cost: '5.20',  qty_type: 'use' },
  { p: '601670',     d: 'M10 x 15mm 4.6 Galv Bolt/Nut',       proc: 'RAW',      qty: '2', lvl: 3, unit_cost: '0.45',  qty_type: 'use' },
  { p: 'GAL:202721', d: 'Galvanising - 140 Tramway - Bottom',  proc: 'OUTPLANT', qty: '1', lvl: 2, rate_per_hour: 80,  pcs_per_hour: 15, setup_min: 60 },
  { p: '601711',     d: 'M12 Nut Galv',                        proc: 'RAW',      qty: '4', lvl: 1, unit_cost: '0.30',  qty_type: 'use' },
  { p: '601706',     d: 'M12 Washer Galv',                     proc: 'RAW',      qty: '4', lvl: 1, unit_cost: '0.20',  qty_type: 'use' },
];

function hasMoreAtLevel(rows: BomRow[], fromIdx: number, lvl: number): boolean {
  for (let j = fromIdx + 1; j < rows.length; j++) {
    if (rows[j].lvl < lvl) return false;
    if (rows[j].lvl === lvl) return true;
  }
  return false;
}

function getChildEnd(rows: BomRow[], idx: number): number {
  const lvl = rows[idx].lvl;
  let end = idx + 1;
  while (end < rows.length && rows[end].lvl > lvl) end++;
  return end;
}

function rowType(row: BomRow): 'fg' | 'process' | 'material' | 'blank' {
  if (row.proc === 'FG') return 'fg';
  if (row.proc === '') return 'blank';
  const up = row.proc.toUpperCase();
  if (up === 'RAW' || up === 'MAT' || up === 'ECOAT') return 'material';
  return 'process';
}

function calcRowCost(row: BomRow, moq: number): number {
  const t = rowType(row);
  if (t === 'process' && row.rate_per_hour !== undefined) {
    if (!row.pcs_per_hour || row.pcs_per_hour <= 0) return 0;
    const setup = ((row.setup_min ?? 0) / 60) * row.rate_per_hour / Math.max(moq, 1);
    return row.rate_per_hour / row.pcs_per_hour + setup;
  }
  if (t === 'material' && row.unit_cost !== undefined) {
    const cost = Number(row.unit_cost);
    const qty  = Math.max(1, Number(row.qty) || 1);
    return (row.qty_type ?? 'use') === 'amortise' ? cost / qty : qty * cost;
  }
  return 0;
}

function calcTotal(rows: BomRow[], moq: number): number {
  return rows.reduce((s, r) => s + calcRowCost(r, moq), 0);
}

function applyProcPreset(row: BomRow, proc: string): BomRow {
  const preset = PROC_PRESETS[proc.trim().toUpperCase()];
  return preset ? { ...row, proc, ...preset } : { ...row, proc };
}

function fmt(n: number): string { return `$${n.toFixed(2)}`; }

function Connector({ isTee }: { isTee: boolean }) {
  return (
    <div className="w-5 flex-shrink-0 relative self-stretch">
      <div className="absolute left-0 w-0.5 bg-[#cec8be]" style={{ top: 0, height: isTee ? '100%' : '50%' }} />
      <div className="absolute w-full h-0.5 bg-[#cec8be]" style={{ top: '50%' }} />
    </div>
  );
}

function Cell({ value, onChange, centerAlign, placeholder = '—', dim, list }: {
  value: string; onChange: (v: string) => void;
  centerAlign?: boolean; placeholder?: string; dim?: boolean; list?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const commit = () => { setEditing(false); onChange(draft); };
  const align = centerAlign ? 'text-center' : '';
  if (editing) {
    return (
      <input autoFocus value={draft} list={list}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
        className={`w-full h-full px-1.5 text-[11px] outline-none rounded border border-[#1c1814] bg-white text-[#1c1814] font-mono ${align}`}
      />
    );
  }
  return (
    <div className="flex items-center w-full h-full px-1.5 cursor-text group min-w-0" onClick={() => setEditing(true)}>
      <span className={`truncate w-full text-[11px] font-mono group-hover:underline group-hover:decoration-dotted group-hover:underline-offset-2 ${align} ${(!value || dim) ? 'text-[#aca49a]' : 'text-[#1c1814]'}`}>
        {value || placeholder}
      </span>
    </div>
  );
}

function NumCell({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value !== undefined ? String(value) : '');
  useEffect(() => { if (!editing) setDraft(value !== undefined ? String(value) : ''); }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const n = Number(draft);
    onChange(draft === '' ? undefined : isNaN(n) ? undefined : Math.max(0, n));
  };
  if (editing) {
    return (
      <input autoFocus type="number" min={0} value={draft}
        onChange={e => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
        className="w-full h-full px-1.5 text-[11px] outline-none rounded border border-[#1c1814] bg-white text-[#1c1814] font-mono text-right"
      />
    );
  }
  if (value === undefined) {
    return (
      <div className="flex items-center justify-end px-1.5 h-full cursor-text" onClick={() => { setDraft(''); setEditing(true); }}>
        <span className="text-[11px] font-mono text-[#aca49a]">—</span>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-end px-1.5 h-full cursor-text group" onClick={() => { setDraft(String(value)); setEditing(true); }}>
      <span className="text-[11px] font-mono text-[#1c1814] group-hover:underline group-hover:decoration-dotted group-hover:underline-offset-2">{value}</span>
    </div>
  );
}

function Dash() {
  return (
    <div className="flex items-center justify-end px-1.5 h-full">
      <span className="text-[11px] font-mono text-[#cec8be]">—</span>
    </div>
  );
}

interface RowProps {
  row: BomRow; idx: number; rows: BomRow[]; moq: number;
  onChange: (row: BomRow) => void;
  onChangeLevel: (delta: number) => void;
  onDelete: () => void;
  onAdd: () => void;
}

function BomRowEl({ row, idx, rows, moq, onChange, onChangeLevel, onDelete, onAdd }: RowProps) {
  const canOutdent = row.lvl > 0;
  const canIndent  = idx > 0 && row.lvl < rows[idx - 1].lvl + 1;
  const t = rowType(row);
  const cost = calcRowCost(row, moq);

  const treePre: JSX.Element[] = [];
  if (row.lvl > 0) {
    for (let i = 0; i < row.lvl - 1; i++) {
      treePre.push(
        hasMoreAtLevel(rows, idx, i + 1)
          ? <div key={i} className="w-5 flex-shrink-0 self-stretch" style={{ borderLeft: '2px solid #cec8be' }} />
          : <div key={i} className="w-5 flex-shrink-0" />
      );
    }
    treePre.push(<Connector key="conn" isTee={hasMoreAtLevel(rows, idx, row.lvl)} />);
  }

  return (
    <div className="grid items-stretch h-[30px] rounded px-0.5 group/row hover:bg-[#f8f5f0]"
      style={{ gridTemplateColumns: COLS }}>

      {/* × ← → + */}
      <div className="flex items-center justify-center gap-px opacity-0 group-hover/row:opacity-100 transition-opacity px-1">
        <button onClick={onDelete} title="Delete"
          className="w-[15px] h-5 flex items-center justify-center rounded text-[11px] leading-none text-[#aca49a] hover:bg-red-100 hover:text-red-500">×</button>
        <button disabled={!canOutdent} onClick={() => onChangeLevel(-1)} title="Outdent"
          className="w-[15px] h-5 flex items-center justify-center rounded text-[10px] text-[#aca49a] hover:bg-[#cec8be] hover:text-[#1c1814] disabled:opacity-20 disabled:pointer-events-none">←</button>
        <button disabled={!canIndent} onClick={() => onChangeLevel(1)} title="Indent"
          className="w-[15px] h-5 flex items-center justify-center rounded text-[10px] text-[#aca49a] hover:bg-[#cec8be] hover:text-[#1c1814] disabled:opacity-20 disabled:pointer-events-none">→</button>
        <button onClick={onAdd} title="Add row below (set Proc to activate)"
          className="w-[15px] h-5 flex items-center justify-center rounded text-[11px] leading-none text-[#aca49a] hover:bg-[#cec8be] hover:text-[#1c1814]">+</button>
      </div>

      {/* Part + tree */}
      <div className="flex items-stretch overflow-hidden min-w-0">
        <div className="flex items-stretch flex-shrink-0">{treePre}</div>
        <Cell value={row.p} onChange={v => onChange({ ...row, p: v })} />
      </div>

      {/* Proc — preset auto-applies; auto-suggests part# and desc from parent */}
      <Cell value={row.proc} onChange={v => {
        let updated = applyProcPreset(row, v);
        if (v) {
          const parent = findParentRow(rows, idx);
          if (!row.p && parent?.p) {
            const s = suggestPartNumber(parent.p, v);
            if (s) updated = { ...updated, p: s };
          }
          if (!row.d && parent?.d) {
            updated = { ...updated, d: suggestDescription(parent.d, v) };
          }
        }
        onChange(updated);
      }} centerAlign placeholder="—" dim={!row.proc} list="mlb-proc-list" />

      {/* Description */}
      <Cell value={row.d} onChange={v => onChange({ ...row, d: v })} />

      {/* Setup (min) */}
      {t === 'process'
        ? <NumCell value={row.setup_min} onChange={v => onChange({ ...row, setup_min: v })} />
        : <Dash />}

      {/* Pcs/h or Qty+toggle */}
      {t === 'process' ? (
        <NumCell value={row.pcs_per_hour} onChange={v => onChange({ ...row, pcs_per_hour: v })} />
      ) : t === 'material' ? (
        <div className="flex items-center justify-end gap-0.5 px-1 h-full">
          <NumCell
            value={Number(row.qty) || 1}
            onChange={v => onChange({ ...row, qty: String(Math.max(1, v ?? 1)) })}
          />
          <span
            onClick={() => onChange({ ...row, qty_type: (row.qty_type ?? 'use') === 'use' ? 'amortise' : 'use' })}
            className="text-[11px] font-mono font-semibold cursor-pointer select-none w-3 text-center flex-shrink-0"
            style={{ color: (row.qty_type ?? 'use') === 'use' ? '#1c1814' : '#a86010' }}
            title={(row.qty_type ?? 'use') === 'use' ? 'qty × unit cost — click to toggle' : 'unit cost ÷ qty — click to toggle'}
          >{(row.qty_type ?? 'use') === 'use' ? '×' : '÷'}</span>
        </div>
      ) : <Dash />}

      {/* Rate / $ Unit */}
      {t === 'process' ? (
        <NumCell value={row.rate_per_hour} onChange={v => onChange({ ...row, rate_per_hour: v })} />
      ) : t === 'material' ? (
        <NumCell
          value={row.unit_cost !== undefined ? Number(row.unit_cost) : undefined}
          onChange={v => onChange({ ...row, unit_cost: v !== undefined ? String(v) : undefined })}
        />
      ) : <Dash />}

      {/* Margin % */}
      {t === 'process' || t === 'material' ? (
        <NumCell value={row.margin} onChange={v => onChange({ ...row, margin: v })} />
      ) : <Dash />}

      {/* Cost */}
      <div className="flex items-center justify-end px-1.5 h-full">
        {t === 'process' || t === 'material' ? (
          <span className={`text-[11px] font-mono ${cost > 0 ? 'font-semibold text-[#1c1814]' : 'text-[#aca49a]'}`}>
            {cost > 0 ? fmt(cost) : '—'}
          </span>
        ) : <span className="text-[11px] font-mono text-[#cec8be]">—</span>}
      </div>
    </div>
  );
}

export default function MlbSection({ rows: propRows, onRowsChange, moq: propMoq, onMoqChange }: MlbSectionProps) {
  const [ownRows, setOwnRows] = useState<BomRow[]>(DEFAULT_ROWS);
  const [ownMoq, setOwnMoq] = useState(400);
  const rows = propRows ?? ownRows;
  const moq  = propMoq  ?? ownMoq;

  const setRows = (next: BomRow[]) => {
    if (propRows !== undefined) onRowsChange?.(next); else setOwnRows(next);
  };
  const setMoq = (n: number) => {
    if (propMoq !== undefined) onMoqChange?.(n); else setOwnMoq(n);
  };

  const updateRow = (idx: number, newRow: BomRow) => {
    if (idx === 0) {
      const old = rows[0];
      if (newRow.p !== old.p) {
        return setRows(rows.map((r, i) => {
          if (i === 0) return newRow;
          if (old.p && r.p.startsWith(old.p)) return { ...r, p: newRow.p + r.p.slice(old.p.length) };
          return r;
        }));
      }
      if (newRow.d !== old.d) {
        return setRows(rows.map((r, i) => {
          if (i === 0) return newRow;
          if (old.d && r.d.startsWith(old.d + ' (') && r.d.endsWith(')')) {
            return { ...r, d: newRow.d + r.d.slice(old.d.length) };
          }
          return r;
        }));
      }
    }
    setRows(rows.map((r, i) => i === idx ? newRow : r));
  };

  const changeLevel = (idx: number, delta: number) => {
    const newLvl = rows[idx].lvl + delta;
    if (newLvl < 0) return;
    if (delta > 0 && idx > 0 && newLvl > rows[idx - 1].lvl + 1) return;
    const end = getChildEnd(rows, idx);
    setRows(rows.map((r, i) => i >= idx && i < end ? { ...r, lvl: r.lvl + delta } : r));
  };

  const deleteRow = (idx: number) => {
    const end = getChildEnd(rows, idx);
    setRows(rows.filter((_, i) => i < idx || i >= end));
  };

  const insertAt = (idx: number, row: BomRow) => {
    const next = [...rows]; next.splice(idx, 0, row); setRows(next);
  };

  // + always inserts immediately below the clicked row.
  const addAfter = (idx: number) => {
    insertAt(idx + 1, { p: '', d: '', proc: '', qty: '1', lvl: rows[idx].lvl });
  };

  const total = calcTotal(rows, moq);

  return (
    <section className="w-full">
      {/* Datalist for proc suggestions — one shared instance */}
      <datalist id="mlb-proc-list">
        <option value="LASER" />
        <option value="BEND" />
        <option value="WELD" />
        <option value="ECOAT" />
        <option value="RAW" />
        <option value="FG" />
      </datalist>

      <div className="border border-[#cec8be] rounded-lg overflow-hidden">

        {/* Title + MOQ */}
        <div className="px-3.5 py-2 border-b border-[#cec8be] flex items-center justify-between bg-white">
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#7a7060]">MLB</span>
          <div className="flex items-center gap-2">
            <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a]">MOQ</span>
            <input type="number" min={1} value={moq}
              onChange={e => setMoq(Math.max(1, Number(e.target.value)))}
              className="w-16 text-[11px] font-mono bg-[#f8f5f0] border border-[#cec8be] rounded px-2 py-0.5 text-right outline-none focus:border-[#1c1814]"
            />
          </div>
        </div>

        {/* Column header */}
        <div className="grid px-0.5 h-6 items-center border-b border-[#cec8be] bg-[#f8f5f0]"
          style={{ gridTemplateColumns: COLS }}>
          <span />
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5">Part</span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-center">Proc</span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5">Description</span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-right">Setup</span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-right">Pcs/h</span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-right">Rate</span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-right">MGN%</span>
          <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-right">Cost</span>
        </div>

        {/* Rows */}
        <div className="overflow-y-auto px-2 py-1" style={{ height: '420px' }}>
          {rows.map((row, idx) => (
            <BomRowEl key={idx} row={row} idx={idx} rows={rows} moq={moq}
              onChange={r => updateRow(idx, r)}
              onChangeLevel={delta => changeLevel(idx, delta)}
              onDelete={() => deleteRow(idx)}
              onAdd={() => addAfter(idx)}
            />
          ))}

        </div>

        {/* Total bar */}
        <div className="grid px-0.5 border-t-2 border-[#cec8be] bg-white"
          style={{ gridTemplateColumns: COLS, height: 36 }}>
          <span /><span /><span />
          <div className="flex items-center px-1.5">
            <span className="text-[11px] font-mono font-medium text-[#1c1814]">Total / unit</span>
          </div>
          <span /><span /><span /><span />
          <div className="flex items-center justify-end px-1.5">
            <span className="text-[13px] font-mono font-semibold text-[#1c1814]">{fmt(total)}</span>
          </div>
        </div>

      </div>
    </section>
  );
}
