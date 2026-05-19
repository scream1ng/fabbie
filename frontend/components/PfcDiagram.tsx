'use client';

import React from 'react';
import type { BomRow } from './MlbSection';

function PfcArrow() {
  return (
    <div className="flex flex-col items-center flex-shrink-0">
      <div className="h-4 w-px bg-zinc-600" />
      <div className="text-[10px] text-zinc-500 leading-none">▼</div>
    </div>
  );
}

function PfcBox({ row }: { row: BomRow }) {
  const isRaw = row.proc === 'RAW';
  const isFg = row.proc === 'FG';
  return (
    <div className={`rounded border px-3 py-2 text-center w-36 flex-shrink-0 ${
      isRaw
        ? 'border-amber-700/60 bg-amber-950/20'
        : isFg
          ? 'border-blue-700/60 bg-blue-950/20'
          : 'border-zinc-700 bg-zinc-900'
    }`}>
      <div className="text-[9px] uppercase tracking-wider text-zinc-500">
        {isRaw ? 'Raw Material' : isFg ? 'Finished Good' : row.proc || 'Process'}
      </div>
      <div className="mt-0.5 text-xs font-mono text-zinc-200 truncate">{row.p || '—'}</div>
      <div className="text-[10px] text-zinc-400 truncate">{row.d || ''}</div>
    </div>
  );
}

// CSS-only T-bar connector: stems from each grid column → horizontal bar → centre drop
function MergeBar({ count }: { count: number }) {
  if (count <= 1) return <PfcArrow />;
  // Trim horizontal bar to span only between centre of first and last column
  const edgePct = `${(1 / (2 * count)) * 100}%`;
  return (
    <div className="w-full flex flex-col">
      {/* One stem per column, grid-aligned so each is centred in its cell */}
      <div
        className="grid w-full"
        style={{ gridTemplateColumns: `repeat(${count}, 1fr)` }}
      >
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="flex justify-center">
            <div className="h-4 w-px bg-zinc-600" />
          </div>
        ))}
      </div>
      {/* Horizontal bar trimmed to outer stems */}
      <div style={{ paddingLeft: edgePct, paddingRight: edgePct }}>
        <div className="h-px bg-zinc-600" />
      </div>
      {/* Centre drop + arrow */}
      <div className="flex justify-center">
        <div className="h-4 w-px bg-zinc-600" />
      </div>
      <div className="flex justify-center">
        <div className="text-[10px] text-zinc-500">▼</div>
      </div>
    </div>
  );
}

interface Extracted {
  compCols: BomRow[][];
  assemblyProcs: BomRow[];
}

// Lvl-1 rows with children → component columns (reversed so RAW is at top)
// Lvl-1 rows without children and proc !== 'RAW' → assembly processes (WELD, E-COAT …)
// Lvl-1 rows without children and proc === 'RAW' → purchased component column
function extractColumns(rows: BomRow[]): Extracted {
  const compCols: BomRow[][] = [];
  const assemblyProcs: BomRow[] = [];
  let i = 1;
  while (i < rows.length) {
    if (rows[i].lvl !== 1) { i++; continue; }
    const hasChildren = i + 1 < rows.length && rows[i + 1].lvl > 1;
    if (!hasChildren && rows[i].proc !== 'RAW') {
      assemblyProcs.push(rows[i]);
      i++;
    } else {
      const col: BomRow[] = [rows[i]];
      let j = i + 1;
      while (j < rows.length && rows[j].lvl > 1) { col.push(rows[j]); j++; }
      compCols.push(col.reverse()); // RAW at top
      i = j;
    }
  }
  return { compCols, assemblyProcs };
}

interface PfcDiagramProps {
  rows: BomRow[];
  isAssembly: boolean;
}

export default function PfcDiagram({ rows, isAssembly }: PfcDiagramProps) {
  if (rows.length === 0) return null;

  // ── Single part: vertical RAW → processes → FG ──────────────────────────
  if (!isAssembly) {
    const fg = rows[0];
    const material = rows.at(-1)!;
    if (rows.length < 2) return <PfcBox row={fg} />;
    const flow = material === fg ? [fg] : [material, ...rows.slice(1, -1).reverse(), fg];
    return (
      <div className="flex flex-col items-center">
        {flow.map((row, i) => (
          <React.Fragment key={i}>
            {i > 0 && <PfcArrow />}
            <PfcBox row={row} />
          </React.Fragment>
        ))}
      </div>
    );
  }

  // ── Assembly: multi-column ───────────────────────────────────────────────
  const fgRow = rows[0];
  const { compCols, assemblyProcs } = extractColumns(rows);

  if (compCols.length === 0 && assemblyProcs.length === 0) return <PfcBox row={fgRow} />;

  return (
    <div className="flex flex-col items-center w-full overflow-x-auto">

      {/* Component columns — bottom-aligned via CSS grid */}
      {compCols.length > 0 && (
        <div
          className="grid w-full items-end"
          style={{ gridTemplateColumns: `repeat(${compCols.length}, 1fr)` }}
        >
          {compCols.map((col, ci) => (
            <div key={ci} className="flex flex-col items-center">
              {col.map((row, ri) => (
                <React.Fragment key={ri}>
                  {ri > 0 && <PfcArrow />}
                  <PfcBox row={row} />
                </React.Fragment>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* T-bar merge connector */}
      {compCols.length > 0 && <MergeBar count={compCols.length} />}

      {/* Assembly-level processes: WELD, E-COAT … */}
      {assemblyProcs.map((row, i) => (
        <React.Fragment key={i}>
          <PfcBox row={row} />
          <PfcArrow />
        </React.Fragment>
      ))}

      {/* Finished good */}
      <PfcBox row={fgRow} />
    </div>
  );
}
