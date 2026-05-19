'use client';

import { useEffect, useState } from 'react';

export interface BomRow {
  p: string;
  d: string;
  proc: string;
  qty: string;
  lvl: number;
  unit_cost?: string;
}

interface MlbSectionProps {
  rows?: BomRow[];
  onRowsChange?: (rows: BomRow[]) => void;
}


const DEFAULT_ROWS: BomRow[] = [
  { p: '826806',      d: 'Bracket Service 140mm Dia',               proc: 'FG',       qty: '1', lvl: 0 },
  { p: '202720H',     d: '140 Tramway - Top (GAL)',                  proc: 'Gal',      qty: '1', lvl: 1 },
  { p: '202720BH',    d: '140 Tramway - Top (Bend)',                 proc: 'Bend',     qty: '1', lvl: 2 },
  { p: '202720SBH',   d: '140 Tramway - Top (Crop & Pierce)',        proc: 'Laser',    qty: '1', lvl: 3 },
  { p: '702126',      d: 'Flat Bar 40 x 10mm',                       proc: 'RAW',      qty: '1', lvl: 4 },
  { p: 'GAL:202720',  d: 'Galvanising - 140 Tramway - Top',          proc: 'Outplant', qty: '1', lvl: 2 },
  { p: '202721H',     d: '140 Tramway - Bottom',                     proc: '',         qty: '1', lvl: 1 },
  { p: '202721WH',    d: '140 Tramway - Bottom (Weld)',              proc: 'Weld',     qty: '1', lvl: 2 },
  { p: '202721BWH',   d: '140 Tramway - Bottom (Bend)',              proc: 'Bend',     qty: '1', lvl: 3 },
  { p: '202721SBWH',  d: '140 Tramway - Bottom (Crop & Tap)',        proc: 'Laser',    qty: '1', lvl: 4 },
  { p: '702151',      d: 'Round Bar 12.0mm',                         proc: 'RAW',      qty: '1', lvl: 5 },
  { p: '601670',      d: 'M10 x 15mm 4.6 Galv Bolt/Nut',            proc: 'RAW',      qty: '2', lvl: 3 },
  { p: 'GAL:202721',  d: 'Galvanising - 140 Tramway - Bottom',       proc: 'Outplant', qty: '1', lvl: 2 },
  { p: '601711',      d: 'M12 Nut Galv',                             proc: 'RAW',      qty: '4', lvl: 1 },
  { p: '601706',      d: 'M12 Washer Galv',                          proc: 'RAW',      qty: '4', lvl: 1 },
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

function Connector({ isTee }: { isTee: boolean }) {
  return (
    <div className="w-5 flex-shrink-0 relative self-stretch">
      <div
        className="absolute left-0 w-0.5 bg-gray-300 dark:bg-gray-600"
        style={{ top: 0, height: isTee ? '100%' : '50%' }}
      />
      <div
        className="absolute w-full h-0.5 bg-gray-300 dark:bg-gray-600"
        style={{ top: '50%' }}
      />
    </div>
  );
}

interface CellProps {
  value: string;
  onChange: (v: string) => void;
  centerAlign?: boolean;
  placeholder?: string;
}

function Cell({ value, onChange, centerAlign, placeholder = '—' }: CellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    onChange(draft);
  };

  const align = centerAlign ? 'text-center' : '';

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
        className={`w-full h-full px-1.5 text-sm outline-none rounded border border-blue-400 dark:border-blue-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 ${align}`}
      />
    );
  }

  return (
    <div
      className="flex items-center w-full h-full px-1.5 cursor-text group min-w-0"
      onClick={() => setEditing(true)}
    >
      <span className={`truncate w-full text-sm text-gray-800 dark:text-gray-200 group-hover:underline group-hover:decoration-dotted group-hover:underline-offset-2 ${align} ${!value ? 'text-gray-400 dark:text-gray-500' : ''}`}>
        {value || placeholder}
      </span>
    </div>
  );
}


interface RowProps {
  row: BomRow;
  idx: number;
  rows: BomRow[];
  onUpdate: (field: keyof BomRow, value: string) => void;
  onChangeLevel: (delta: number) => void;
}

function BomRowEl({ row, idx, rows, onUpdate, onChangeLevel }: RowProps) {
  const canOutdent = row.lvl > 0;
  const canIndent  = idx > 0 && row.lvl < rows[idx - 1].lvl + 1;

  const treePre = [];
  if (row.lvl > 0) {
    for (let i = 0; i < row.lvl - 1; i++) {
      const hasPipe = hasMoreAtLevel(rows, idx, i + 1);
      treePre.push(
        hasPipe
          ? <div key={i} className="w-5 flex-shrink-0 self-stretch border-l-2 border-gray-300 dark:border-gray-600" />
          : <div key={i} className="w-5 flex-shrink-0" />
      );
    }
    treePre.push(
      <Connector key="conn" isTee={hasMoreAtLevel(rows, idx, row.lvl)} />
    );
  }

  return (
    <div
      className="grid items-stretch h-[30px] rounded px-0.5 group/row hover:bg-gray-50 dark:hover:bg-gray-800/50"
      style={{ gridTemplateColumns: '36px 224px 100px 1fr 60px 72px' }}
    >
      <div className="flex items-center justify-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
        <button
          disabled={!canOutdent}
          onClick={() => onChangeLevel(-1)}
          title="Outdent"
          className="w-4 h-5 flex items-center justify-center rounded text-xs text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-20 disabled:pointer-events-none"
        >←</button>
        <button
          disabled={!canIndent}
          onClick={() => onChangeLevel(1)}
          title="Indent"
          className="w-4 h-5 flex items-center justify-center rounded text-xs text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700 hover:text-gray-700 dark:hover:text-gray-200 disabled:opacity-20 disabled:pointer-events-none"
        >→</button>
      </div>

      <div className="flex items-stretch overflow-hidden min-w-0">
        <div className="flex items-stretch flex-shrink-0">{treePre}</div>
        <Cell value={row.p} onChange={v => onUpdate('p', v)} />
      </div>

      <Cell value={row.proc} onChange={v => onUpdate('proc', v)} centerAlign />

      <Cell value={row.d} onChange={v => onUpdate('d', v)} />

      <Cell value={row.qty} onChange={v => onUpdate('qty', v)} centerAlign />

      <div className="flex items-stretch">
        {row.proc === 'RAW' ? (
          <Cell value={row.unit_cost ?? '0'} onChange={v => onUpdate('unit_cost', v)} centerAlign placeholder="0.00" />
        ) : (
          <div className="flex items-center justify-center w-full">
            <span className="text-xs text-gray-300 dark:text-gray-600">—</span>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MlbSection({ rows: propRows, onRowsChange }: MlbSectionProps) {
  const [ownRows, setOwnRows] = useState<BomRow[]>(DEFAULT_ROWS);
  const rows = propRows ?? ownRows;

  const setRows = (updater: (prev: BomRow[]) => BomRow[]) => {
    const next = updater(rows);
    if (propRows !== undefined) {
      onRowsChange?.(next);
    } else {
      setOwnRows(next);
    }
  };

  const updateRow = (idx: number, field: keyof BomRow, value: string) => {
    setRows(prev => {
      const fgRow = prev[0];
      if (idx === 0 && field === 'p' && fgRow) {
        const oldP = fgRow.p;
        return prev.map((r, i) => {
          if (i === 0) return { ...r, p: value };
          if (oldP && r.p.startsWith(oldP)) return { ...r, p: value + r.p.slice(oldP.length) };
          return r;
        });
      }
      if (idx === 0 && field === 'd' && fgRow) {
        const oldD = fgRow.d;
        return prev.map((r, i) => {
          if (i === 0) return { ...r, d: value };
          if (oldD && r.d.startsWith(oldD + ' (') && r.d.endsWith(')')) {
            return { ...r, d: value + r.d.slice(oldD.length) };
          }
          return r;
        });
      }
      if (field === 'proc' && idx > 0) {
        return prev.map((r, i) => {
          if (i !== idx) return r;
          const baseD = r.d.replace(/\s*\([^)]*\)$/, '');
          return { ...r, proc: value, d: value ? `${baseD} (${value.toUpperCase()})` : baseD };
        });
      }
      return prev.map((r, i) => i === idx ? { ...r, [field]: value } : r);
    });
  };

  const changeLevel = (idx: number, delta: number) => {
    const newLvl = rows[idx].lvl + delta;
    if (newLvl < 0) return;
    if (delta > 0 && idx > 0 && newLvl > rows[idx - 1].lvl + 1) return;
    const end = getChildEnd(rows, idx);
    setRows(prev =>
      prev.map((r, i) => i >= idx && i < end ? { ...r, lvl: r.lvl + delta } : r)
    );
  };

  return (
    <section className="w-full">
      <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-gray-200 dark:border-gray-700">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">MLB</span>
        </div>

        <div
          className="grid px-3.5 h-7 items-center border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50"
          style={{ gridTemplateColumns: '36px 224px 100px 1fr 60px 72px' }}
        >
          <span />
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 px-1.5">Part</span>
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 px-1.5 text-center">Process</span>
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 px-1.5">Description</span>
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 px-1.5 text-center">Qty</span>
          <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400 dark:text-gray-500 px-1.5 text-center">$ Unit</span>
        </div>

        <div className="overflow-y-auto px-2 py-1" style={{ height: '360px' }}>
          {rows.map((row, idx) => (
            <BomRowEl
              key={idx}
              row={row}
              idx={idx}
              rows={rows}
              onUpdate={(field, val) => updateRow(idx, field, val)}
              onChangeLevel={delta => changeLevel(idx, delta)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
