"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type {
  CostBreakdown,
  CostConfig,
  PartAnalysis,
  ProcessDef,
  ProcessPhase,
  MaterialConfig,
  SheetConfig,
  ManualPurchasePart,
} from "./costing";
import {
  calculateCost,
  calculateAssemblyProcessCost,
  DEFAULT_COST_CONFIG,
  effectiveProcessesForComponent,
  getProcessesByPhase,
  resolveComponentConfig,
} from "./costing";
import {
  type BomTreeRow,
  buildBomTree,
  buildProcessStages,
} from "./bom";
import MlbSection, { type BomRow } from "../components/MlbSection";
import PfcDiagram from "../components/PfcDiagram";

type Status = "idle" | "loading" | "viewing" | "exporting" | "error";

interface ApiComp {
  part_number: string;
  description: string;
  type: 'sheet_metal' | 'purchase' | 'assembly';
  level: number;
  is_assembly: boolean;
}

function compLabel(comp: ApiComp): string {
  const desc = comp.description.trim();
  if (desc) return desc.slice(0, 28);
  const m = comp.part_number.match(/_\d+-([\w\s\-]+?)(?:\s+_|$)/);
  if (m) return m[1].trim().slice(0, 28);
  return comp.part_number.slice(0, 28);
}

function mergeAssemblyRows(newRows: BomRow[], prev: BomRow[]): BomRow[] {
  return newRows.map(row => {
    const match = prev.find(r => r.proc === row.proc && r.lvl === row.lvl);
    if (match) return { ...row, p: match.p, d: match.d };
    return row;
  });
}

function buildAssemblyMlbRows(
  components: ApiComp[],
  costConfig: CostConfig,
  matNum: string,
  matDesc: string,
): BomRow[] {
  const root = components.find(c => c.level === 0);
  const rows: BomRow[] = [];
  if (root) {
    rows.push({ p: root.part_number, d: compLabel(root), proc: 'FG', qty: '1', lvl: 0 });
  }

  // Assembly ops in BOM order: post-assembly (outermost) → pre-assembly → components.
  // Array order = BOM order. First element of post-asm → lvl:1 (last applied / outermost in BOM).
  const postAsm = getProcessesByPhase(costConfig.processes, 'post-assembly').filter(p => p.enabled);
  const preAsm  = getProcessesByPhase(costConfig.processes, 'pre-assembly').filter(p => p.enabled);

  let lvl = 1;
  for (const p of postAsm) {
    rows.push({ p: p.key.toUpperCase(), d: p.label, proc: p.mlbProcLabel, qty: '1', lvl: lvl++ });
  }
  for (const p of preAsm) {
    rows.push({ p: p.key.toUpperCase(), d: p.label, proc: p.mlbProcLabel, qty: '1', lvl: lvl++ });
  }
  const compOffset = lvl;

  // Each parsed component
  for (const comp of components.filter(c => c.level > 0 && !c.is_assembly)) {
    if (comp.type === 'purchase') {
      rows.push({ p: comp.part_number, d: compLabel(comp), proc: 'RAW', qty: '1', lvl: compOffset, unit_cost: '0' });
    } else {
      const effProcs = effectiveProcessesForComponent(costConfig, comp.part_number);
      const stages = buildProcessStages(effProcs);
      const subTree = buildBomTree({
        partNumber: comp.part_number,
        description: compLabel(comp),
        materialNumber: matNum,
        materialDescription: matDesc,
        stages,
      });
      for (const row of subTree) {
        const bracket = row.description.match(/\(([^)]+)\)\s*$/)?.[1] ?? '';
        const proc = row.kind === 'material' ? 'RAW'
          : row.kind === 'fg' ? ''
          : bracket || '';
        rows.push({
          p: row.itemNumber,
          d: row.description,
          proc,
          qty: '1',
          lvl: compOffset + row.depth,
        });
      }
    }
  }

  // Manual purchase parts → same lvl as parsed components (children of innermost asm op)
  for (const mpp of costConfig.manualPurchaseParts) {
    rows.push({
      p: mpp.partNumber || mpp.id,
      d: mpp.description || mpp.partNumber || 'Purchase Part',
      proc: 'RAW',
      qty: String(mpp.qty || 1),
      lvl: compOffset,
      unit_cost: String(mpp.unitCost || 0),
    });
  }

  return rows;
}


const MAX_EXPORT_PX = 4096;
const MAX_VIEWER_SEGMENTS = 60000;
const EXPORT_SUPERSAMPLE = 4;


// Per-component cost table: iterates dynamic processes filtered to 'component' phase
function CostTable({ bd, costConfig, setCostConfig, partId, purchasePartsCost }: {
  bd: CostBreakdown;
  analysis: PartAnalysis;
  costConfig: CostConfig;
  setCostConfig: React.Dispatch<React.SetStateAction<CostConfig>>;
  partId?: string;
  purchasePartsCost: number;
}) {
  const effectiveProcs = partId
    ? effectiveProcessesForComponent(costConfig, partId)
    : costConfig.processes;
  const componentProcs = effectiveProcs.filter(p => p.phase === 'component');

  const setSheetCost = (v: number) => {
    if (partId) {
      setCostConfig(c => ({ ...c, perComponent: { ...c.perComponent, [partId]: { ...c.perComponent[partId], sheetCost: v } } }));
    } else {
      setCostConfig(c => ({ ...c, sheetCost: v }));
    }
  };

  const tuneProc = (procKey: string, field: 'pcsPerHour' | 'setupMin' | 'rate' | 'flatCostPerUnit', val: number) => {
    if (partId) {
      setCostConfig(c => ({
        ...c,
        perComponent: { ...c.perComponent, [partId]: {
          ...c.perComponent[partId],
          perProcess: {
            ...(c.perComponent[partId]?.perProcess ?? {}),
            [procKey]: { ...(c.perComponent[partId]?.perProcess?.[procKey] ?? {}), [field]: val },
          },
        }},
      }));
    } else {
      setCostConfig(c => ({
        ...c,
        processes: c.processes.map(p => p.key === procKey ? { ...p, [field]: val } : p),
      }));
    }
  };

  const toggleProc = (procKey: string, on: boolean) => {
    if (partId) {
      const current = costConfig.perComponent[partId]?.enabledProcessKeys
        ?? costConfig.processes.filter(p => p.enabled && p.phase === 'component').map(p => p.key);
      const next = on ? Array.from(new Set([...current, procKey])) : current.filter(k => k !== procKey);
      setCostConfig(c => ({
        ...c,
        perComponent: { ...c.perComponent, [partId]: { ...c.perComponent[partId], enabledProcessKeys: next } },
      }));
    } else {
      setCostConfig(c => ({
        ...c,
        processes: c.processes.map(p => p.key === procKey ? { ...p, enabled: on } : p),
      }));
    }
  };

  return (
    <div className="overflow-x-auto rounded-lg bg-zinc-900">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs text-zinc-500">
            <th className="px-3 py-2 text-left font-medium">Process</th>
            <th className="px-2 py-2 text-center font-medium">pcs/h</th>
            <th className="px-2 py-2 text-center font-medium">Setup min</th>
            <th className="px-2 py-2 text-center font-medium">Rate $/hr</th>
            <th className="px-2 py-2 text-center font-medium">Flat $/u</th>
            <th className="px-3 py-2 text-center font-medium">Unit $</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-zinc-800">
            <td className="px-3 py-2 text-zinc-400">Material (sheet cost)</td>
            <td className="px-2 py-2 text-center text-xs text-zinc-600">-</td>
            <td className="px-2 py-2 text-center text-xs text-zinc-600">-</td>
            <td className="px-2 py-2 text-center">
              <input type="number" min={0}
                value={partId ? (costConfig.perComponent[partId]?.sheetCost ?? costConfig.sheetCost) : costConfig.sheetCost}
                onChange={(e) => setSheetCost(Math.max(0, Number(e.target.value)))}
                className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
            </td>
            <td className="px-2 py-2 text-center text-xs text-zinc-600">-</td>
            <td className="px-3 py-2 text-center font-mono text-zinc-200">${bd.materialUnit.toFixed(2)}</td>
          </tr>
          {componentProcs.map(proc => {
            const cost = bd.processUnits.find(u => u.key === proc.key);
            const enabled = proc.enabled;
            return (
              <tr key={proc.key} className="border-b border-zinc-800">
                <td className="px-3 py-2">
                  <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
                    <input type="checkbox" checked={enabled}
                      onChange={(e) => toggleProc(proc.key, e.target.checked)}
                      className="accent-blue-500" />
                    <span className={enabled ? '' : 'text-zinc-600'}>{proc.label}</span>
                    {proc.autoFrom !== 'none' && proc.pcsPerHour === 0 && (
                      <span className="text-[9px] text-zinc-600 uppercase">auto</span>
                    )}
                  </label>
                </td>
                <td className="px-2 py-2 text-center">
                  <input type="number" min={0} disabled={!enabled}
                    value={proc.pcsPerHour || Math.round(cost?.pcsPerHour ?? 0)}
                    onChange={(e) => tuneProc(proc.key, 'pcsPerHour', Math.max(0, Number(e.target.value)))}
                    className="w-14 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35" />
                </td>
                <td className="px-2 py-2 text-center">
                  <input type="number" min={0} disabled={!enabled}
                    value={proc.setupMin}
                    onChange={(e) => tuneProc(proc.key, 'setupMin', Math.max(0, Number(e.target.value)))}
                    className="w-12 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35" />
                </td>
                <td className="px-2 py-2 text-center">
                  <input type="number" min={0} disabled={!enabled}
                    value={proc.rate}
                    onChange={(e) => tuneProc(proc.key, 'rate', Math.max(0, Number(e.target.value)))}
                    className="w-14 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35" />
                </td>
                <td className="px-2 py-2 text-center">
                  <input type="number" min={0} disabled={!enabled}
                    value={proc.flatCostPerUnit}
                    onChange={(e) => tuneProc(proc.key, 'flatCostPerUnit', Math.max(0, Number(e.target.value)))}
                    className="w-14 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35" />
                </td>
                <td className="px-3 py-2 text-center font-mono text-zinc-200">
                  {enabled ? `$${(cost?.unitCost ?? 0).toFixed(2)}` : '-'}
                </td>
              </tr>
            );
          })}
          {purchasePartsCost > 0 && (
            <tr className="border-b border-zinc-800">
              <td className="px-3 py-2 text-zinc-400">Purchase Parts</td>
              <td colSpan={4} className="px-2 py-2 text-center text-xs text-zinc-600">-</td>
              <td className="px-3 py-2 text-center font-mono text-zinc-200">${purchasePartsCost.toFixed(2)}</td>
            </tr>
          )}
          <tr className="border-b border-zinc-700 bg-zinc-800/60">
            <td className="px-3 py-2 font-medium text-zinc-200">Total / unit</td>
            <td colSpan={4} />
            <td className="px-3 py-2 text-center font-mono font-semibold text-white">
              ${(bd.totalUnit + purchasePartsCost).toFixed(2)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ProcessCatalogEditor({ costConfig, setCostConfig }: {
  costConfig: CostConfig;
  setCostConfig: React.Dispatch<React.SetStateAction<CostConfig>>;
}) {
  const [open, setOpen] = React.useState(false);
  const [activeTab, setActiveTab] = React.useState<'processes' | 'materials' | 'sheets' | 'auto'>('processes');

  const updProc = (key: string, field: keyof ProcessDef, val: string | number | boolean) =>
    setCostConfig(c => ({
      ...c,
      processes: c.processes.map(p => p.key === key ? { ...p, [field]: val } : p),
    }));

  const moveProc = (key: string, delta: -1 | 1) =>
    setCostConfig(c => {
      const i = c.processes.findIndex(p => p.key === key);
      if (i < 0) return c;
      const j = i + delta;
      if (j < 0 || j >= c.processes.length) return c;
      const arr = [...c.processes];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...c, processes: arr };
    });

  const addProc = (phase: ProcessPhase) =>
    setCostConfig(c => {
      const key = `custom_${Date.now()}`;
      const newProc: ProcessDef = {
        key,
        label: 'New Process',
        phase,
        enabled: true,
        rate: 100,
        pcsPerHour: 60,
        setupMin: 10,
        flatCostPerUnit: 0,
        autoFrom: 'none',
        mlbProcLabel: 'Proc',
        custom: true,
      };
      return { ...c, processes: [...c.processes, newProc] };
    });

  const delProc = (key: string) =>
    setCostConfig(c => ({ ...c, processes: c.processes.filter(p => p.key !== key) }));

  const setMat = (i: number, field: keyof MaterialConfig, val: string | number) =>
    setCostConfig(c => { const m = [...c.materials]; m[i] = { ...m[i], [field]: val }; return { ...c, materials: m }; });
  const addMat = () => setCostConfig(c => ({
    ...c, materials: [...c.materials, { id: `mat_${Date.now()}`, label: 'New Material', density: 7850, laserSpeedMmPerMin: 3000 }],
  }));
  const delMat = (i: number) => setCostConfig(c => {
    const materials = c.materials.filter((_, j) => j !== i);
    return { ...c, materials, materialId: materials[0]?.id ?? c.materialId };
  });
  const setSheet = (i: number, field: keyof SheetConfig, val: string | number) =>
    setCostConfig(c => { const s = [...c.sheets]; s[i] = { ...s[i], [field]: val }; return { ...c, sheets: s }; });
  const addSheet = () => setCostConfig(c => ({
    ...c, sheets: [...c.sheets, { label: 'New Sheet', w: 2400, h: 1200 }],
  }));
  const delSheet = (i: number) => setCostConfig(c => {
    const sheets = c.sheets.filter((_, j) => j !== i);
    return { ...c, sheets, sheetIndex: Math.min(c.sheetIndex, Math.max(0, sheets.length - 1)) };
  });

  const phases: { key: ProcessPhase; label: string }[] = [
    { key: 'post-assembly', label: 'Post-Assembly (outermost in BOM)' },
    { key: 'pre-assembly',  label: 'Pre-Assembly (component joining)' },
    { key: 'component',     label: 'Component (per-part)' },
  ];

  return (
    <div className="rounded-lg border border-zinc-800">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200">
        <span>Process Catalog · Materials · Sheets</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800 flex flex-col">
          <div className="flex border-b border-zinc-800 px-3">
            {(['processes', 'materials', 'sheets', 'auto'] as const).map(t => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors capitalize ${activeTab === t ? 'border-blue-500 text-blue-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
                {t === 'auto' ? 'Auto Params' : t}
              </button>
            ))}
          </div>

          {activeTab === 'processes' && (
            <div className="p-3 flex flex-col gap-3">
              {phases.map(phase => {
                const inPhase = costConfig.processes.filter(p => p.phase === phase.key);
                return (
                  <div key={phase.key} className="rounded border border-zinc-800 p-2">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{phase.label}</span>
                      <button onClick={() => addProc(phase.key)}
                        className="text-xs text-zinc-500 hover:text-zinc-200">+ Add process</button>
                    </div>
                    {inPhase.length === 0 ? (
                      <div className="text-xs text-zinc-600 italic">No processes in this phase</div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <div className="grid grid-cols-[18px_18px_1fr_60px_60px_60px_55px_55px_70px_70px_22px] gap-1 text-[9px] uppercase text-zinc-600 px-1">
                          <span /><span />
                          <span>Label</span>
                          <span className="text-center">MLB tag</span>
                          <span className="text-center">Rate $/h</span>
                          <span className="text-center">pcs/h</span>
                          <span className="text-center">Setup</span>
                          <span className="text-center">Flat $/u</span>
                          <span className="text-center">Auto</span>
                          <span className="text-center">On</span>
                          <span />
                        </div>
                        {inPhase.map(p => {
                          const globalIdx = costConfig.processes.findIndex(x => x.key === p.key);
                          return (
                            <div key={p.key} className="grid grid-cols-[18px_18px_1fr_60px_60px_60px_55px_55px_70px_70px_22px] gap-1 items-center">
                              <button onClick={() => moveProc(p.key, -1)} disabled={globalIdx === 0}
                                className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-20">↑</button>
                              <button onClick={() => moveProc(p.key, 1)} disabled={globalIdx >= costConfig.processes.length - 1}
                                className="text-xs text-zinc-500 hover:text-zinc-200 disabled:opacity-20">↓</button>
                              <input value={p.label} onChange={(e) => updProc(p.key, 'label', e.target.value)}
                                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200" />
                              <input value={p.mlbProcLabel} onChange={(e) => updProc(p.key, 'mlbProcLabel', e.target.value)}
                                className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                              <input type="number" min={0} value={p.rate}
                                onChange={(e) => updProc(p.key, 'rate', Number(e.target.value))}
                                className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                              <input type="number" min={0} value={p.pcsPerHour}
                                onChange={(e) => updProc(p.key, 'pcsPerHour', Number(e.target.value))}
                                className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                              <input type="number" min={0} value={p.setupMin}
                                onChange={(e) => updProc(p.key, 'setupMin', Number(e.target.value))}
                                className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                              <input type="number" min={0} value={p.flatCostPerUnit}
                                onChange={(e) => updProc(p.key, 'flatCostPerUnit', Number(e.target.value))}
                                className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                              <select value={p.autoFrom} onChange={(e) => updProc(p.key, 'autoFrom', e.target.value)}
                                className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-xs text-zinc-200">
                                <option value="none">manual</option>
                                <option value="perimeter">perim</option>
                                <option value="bend_count">bend#</option>
                                <option value="weld_length">weld</option>
                              </select>
                              <label className="flex items-center justify-center">
                                <input type="checkbox" checked={p.enabled}
                                  onChange={(e) => updProc(p.key, 'enabled', e.target.checked)}
                                  className="accent-blue-500" />
                              </label>
                              <button onClick={() => delProc(p.key)}
                                className="text-xs text-zinc-600 hover:text-red-400">×</button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === 'materials' && (
            <div className="p-3 flex flex-col gap-1">
              <div className="grid grid-cols-[1fr_80px_90px_28px] gap-1 px-1">
                <span className="text-[10px] text-zinc-600">Name</span>
                <span className="text-[10px] text-zinc-600 text-center">kg/m³</span>
                <span className="text-[10px] text-zinc-600 text-center">mm/min</span>
                <span />
              </div>
              {costConfig.materials.map((mat, i) => (
                <div key={mat.id} className="grid grid-cols-[1fr_80px_90px_28px] gap-1 items-center">
                  <input value={mat.label} onChange={(e) => setMat(i, 'label', e.target.value)}
                    className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200" />
                  <input type="number" min={0} value={mat.density} title="Density kg/m³"
                    onChange={(e) => setMat(i, 'density', Number(e.target.value))}
                    className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                  <input type="number" min={0} value={mat.laserSpeedMmPerMin} title="Laser speed mm/min"
                    onChange={(e) => setMat(i, 'laserSpeedMmPerMin', Number(e.target.value))}
                    className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                  <button onClick={() => delMat(i)} disabled={costConfig.materials.length <= 1}
                    className="text-xs text-zinc-600 hover:text-red-400 disabled:opacity-20">×</button>
                </div>
              ))}
              <button onClick={addMat}
                className="text-xs text-zinc-500 hover:text-zinc-300 text-left px-1 mt-1">+ Add material</button>
            </div>
          )}

          {activeTab === 'sheets' && (
            <div className="p-3 flex flex-col gap-1">
              {costConfig.sheets.map((sh, i) => (
                <div key={i} className="grid grid-cols-[1fr_70px_70px_28px] gap-1 items-center">
                  <input value={sh.label} onChange={(e) => setSheet(i, 'label', e.target.value)}
                    className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200" />
                  <input type="number" min={1} value={sh.w} title="Width mm"
                    onChange={(e) => setSheet(i, 'w', Number(e.target.value))}
                    className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                  <input type="number" min={1} value={sh.h} title="Height mm"
                    onChange={(e) => setSheet(i, 'h', Number(e.target.value))}
                    className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                  <button onClick={() => delSheet(i)} disabled={costConfig.sheets.length <= 1}
                    className="text-xs text-zinc-600 hover:text-red-400 disabled:opacity-20">×</button>
                </div>
              ))}
              <button onClick={addSheet}
                className="text-xs text-zinc-500 hover:text-zinc-300 text-left px-1 mt-1">+ Add sheet size</button>
            </div>
          )}

          {activeTab === 'auto' && (
            <div className="p-3 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="w-32">Bend cycle (sec)</span>
                <input type="number" min={0} value={costConfig.autoParams.secPerBend}
                  onChange={(e) => setCostConfig(c => ({ ...c, autoParams: { ...c.autoParams, secPerBend: Number(e.target.value) } }))}
                  className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="w-32">Weld speed (mm/min)</span>
                <input type="number" min={0} value={costConfig.autoParams.weldSpeedMmPerMin}
                  onChange={(e) => setCostConfig(c => ({ ...c, autoParams: { ...c.autoParams, weldSpeedMmPerMin: Number(e.target.value) } }))}
                  className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
              </label>
              <div className="text-[10px] text-zinc-600 mt-1">Material laser speed: edit in Materials tab</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ManualPurchasePartsEditor({ costConfig, setCostConfig }: {
  costConfig: CostConfig;
  setCostConfig: React.Dispatch<React.SetStateAction<CostConfig>>;
}) {
  const upd = (id: string, field: keyof ManualPurchasePart, val: string | number) =>
    setCostConfig(c => ({
      ...c,
      manualPurchaseParts: c.manualPurchaseParts.map(m => m.id === id ? { ...m, [field]: val } : m),
    }));
  const add = () => setCostConfig(c => ({
    ...c,
    manualPurchaseParts: [...c.manualPurchaseParts, {
      id: `mpp_${Date.now()}`, partNumber: 'PURCH-NEW', description: 'Purchase Part', qty: 1, unitCost: 0,
    }],
  }));
  const del = (id: string) => setCostConfig(c => ({
    ...c,
    manualPurchaseParts: c.manualPurchaseParts.filter(m => m.id !== id),
  }));

  return (
    <div className="rounded-lg border border-zinc-800 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">Manual Purchase Parts</span>
        <button onClick={add} className="text-xs text-zinc-500 hover:text-zinc-200">+ Add</button>
      </div>
      {costConfig.manualPurchaseParts.length === 0 ? (
        <div className="text-xs text-zinc-600 italic">None — add bought-in items (studs, fasteners, inserts...)</div>
      ) : (
        <>
          <div className="grid grid-cols-[100px_1fr_50px_70px_28px] gap-1 text-[9px] uppercase text-zinc-600 px-1">
            <span>Part #</span><span>Description</span>
            <span className="text-center">Qty</span><span className="text-center">$ unit</span>
            <span />
          </div>
          {costConfig.manualPurchaseParts.map(mpp => (
            <div key={mpp.id} className="grid grid-cols-[100px_1fr_50px_70px_28px] gap-1 items-center">
              <input value={mpp.partNumber} onChange={(e) => upd(mpp.id, 'partNumber', e.target.value)}
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-200" />
              <input value={mpp.description} onChange={(e) => upd(mpp.id, 'description', e.target.value)}
                className="rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200" />
              <input type="number" min={0} value={mpp.qty}
                onChange={(e) => upd(mpp.id, 'qty', Number(e.target.value))}
                className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
              <input type="number" min={0} step={0.01} value={mpp.unitCost}
                onChange={(e) => upd(mpp.id, 'unitCost', Number(e.target.value))}
                className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
              <button onClick={() => del(mpp.id)} className="text-xs text-zinc-600 hover:text-red-400">×</button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [linePx, setLinePx] = useState(3);
  const [partName, setPartName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [exportCm, setExportCm] = useState(2.6);
  const [exportDpi, setExportDpi] = useState(300);
  const [analysis, setAnalysis] = useState<PartAnalysis | null>(null);
  const [bomPartNumber, setBomPartNumber] = useState("");
  const [bomDescription, setBomDescription] = useState("");
  const [materialNumber, setMaterialNumber] = useState("MAT-001");
  const [materialDescription, setMaterialDescription] = useState("MILD STEEL");
  const [mlbRows, setMlbRows] = useState<BomRow[]>([]);
  const [isAssembly, setIsAssembly] = useState(false);
  const [assemblyApiComps, setAssemblyApiComps] = useState<ApiComp[]>([]);
  const [activeCostTab, setActiveCostTab] = useState(0);
  const [costConfig, setCostConfig] = useState<CostConfig>(DEFAULT_COST_CONFIG);
  const costBreakdown = useMemo<CostBreakdown | null>(
    () => (analysis ? calculateCost(analysis, costConfig) : null),
    [analysis, costConfig],
  );
  const purchasePartsCost = useMemo(
    () => mlbRows
      .filter(r => r.proc === 'RAW')
      .reduce((acc, r) => acc + Number(r.qty) * Number(r.unit_cost ?? 0), 0),
    [mlbRows],
  );
  const sheetMetalComps = useMemo(
    () => assemblyApiComps.filter(c => c.type === 'sheet_metal'),
    [assemblyApiComps],
  );
  const compBreakdowns = useMemo<CostBreakdown[]>(() => {
    if (!analysis || !isAssembly) return [];
    return sheetMetalComps.map(comp =>
      calculateCost(analysis, resolveComponentConfig(costConfig, comp.part_number))
    );
  }, [analysis, isAssembly, sheetMetalComps, costConfig]);
  // Per-process cost rows for pre/post-assembly processes that are enabled (assembly level)
  const assemblyProcCosts = useMemo(() => {
    if (!isAssembly) return [] as { key: string; label: string; phase: ProcessDef['phase']; unitCost: number; mlbProcLabel: string }[];
    return costConfig.processes
      .filter(p => p.enabled && (p.phase === 'pre-assembly' || p.phase === 'post-assembly'))
      .map(p => ({ key: p.key, label: p.label, phase: p.phase, mlbProcLabel: p.mlbProcLabel,
                   unitCost: calculateAssemblyProcessCost(p, costConfig) }));
  }, [isAssembly, costConfig]);
  const assemblyOpsCost = useMemo(() => assemblyProcCosts.reduce((s, p) => s + p.unitCost, 0), [assemblyProcCosts]);
  // Manual purchase parts total
  const manualPurchaseCost = useMemo(
    () => costConfig.manualPurchaseParts.reduce((s, m) => s + (m.qty || 0) * (m.unitCost || 0), 0),
    [costConfig.manualPurchaseParts],
  );
  // Single-part: derive stages from currently-enabled component processes
  const bomStages = useMemo(
    () => buildProcessStages(costConfig.processes),
    [costConfig.processes],
  );
  const generatedBomRows = useMemo(
    () =>
      buildBomTree({
        partNumber: bomPartNumber,
        description: bomDescription,
        materialNumber,
        materialDescription,
        stages: bomStages,
      }),
    [bomDescription, bomPartNumber, bomStages, materialDescription, materialNumber],
  );
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameRef = useRef<number>(0);
  const linMatRef = useRef<LineMaterial | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadIdRef = useRef(0);
  const resizeHandlerRef = useRef<(() => void) | null>(null);
  const modelCenterRef = useRef(new THREE.Vector3());
  const modelScaleRef = useRef(1);

  const cleanup = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    if (resizeHandlerRef.current) {
      window.removeEventListener("resize", resizeHandlerRef.current);
      resizeHandlerRef.current = null;
    }
    controlsRef.current?.dispose();
    controlsRef.current = null;
    if (sceneRef.current) {
      sceneRef.current.traverse((obj) => {
        const o = obj as {
          geometry?: { dispose?: () => void };
          material?: { dispose?: () => void } | Array<{ dispose?: () => void }>;
        };
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) {
          o.material.forEach((m) => m?.dispose?.());
        } else {
          o.material?.dispose?.();
        }
      });
      sceneRef.current = null;
    }
    if (rendererRef.current) {
      if (mountRef.current?.contains(rendererRef.current.domElement)) {
        mountRef.current.removeChild(rendererRef.current.domElement);
      }
      rendererRef.current.dispose();
      rendererRef.current = null;
    }
    cameraRef.current = null;
    linMatRef.current = null;
    modelCenterRef.current.set(0, 0, 0);
    modelScaleRef.current = 1;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  useEffect(() => {
    if (linMatRef.current) {
      linMatRef.current.linewidth = linePx;
    }
  }, [linePx]);

  useEffect(() => {
    if (isAssembly) return;
    setMlbRows((prev) => {
      const procOf = (row: BomTreeRow): string => {
        if (row.kind === 'fg') return 'FG';
        if (row.kind === 'material') return 'RAW';
        const m = row.description.match(/\(([^)]+)\)\s*$/);
        const label = m?.[1]?.toUpperCase() ?? '';
        if (label === 'LASER') return 'Laser';
        if (label === 'BEND') return 'Bend';
        if (label === 'WELD') return 'Weld';
        return '';
      };
      return generatedBomRows.map((row) => {
        const proc = procOf(row);
        const existing = prev.find((r) => r.proc === proc);
        return {
          p: row.itemNumber,
          d: existing ? existing.d : row.description,
          proc,
          qty: existing ? existing.qty : '1',
          lvl: existing ? existing.lvl : row.depth,
        };
      });
    });
  }, [generatedBomRows, isAssembly]);

  useEffect(() => {
    if (!isAssembly || assemblyApiComps.length === 0) return;
    const newRows = buildAssemblyMlbRows(
      assemblyApiComps, costConfig, materialNumber, materialDescription,
    );
    setMlbRows(prev => prev.length === 0 ? newRows : mergeAssemblyRows(newRows, prev));
  // costConfig intentionally omitted — only trigger on assembly change (new STEP load)
  // Catalog changes handled by separate effect below
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAssembly, assemblyApiComps]);

  // Rebuild assembly rows when process catalog or manual purchase parts change (preserves user edits)
  useEffect(() => {
    if (!isAssembly || assemblyApiComps.length === 0) return;
    const newRows = buildAssemblyMlbRows(
      assemblyApiComps, costConfig, materialNumber, materialDescription,
    );
    setMlbRows(prev => mergeAssemblyRows(newRows, prev));
  }, [costConfig.processes, costConfig.manualPurchaseParts, costConfig.perComponent]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMesh = useCallback(
    async (nextFile: File) => {
      const id = ++loadIdRef.current;
      setStatus("loading");
      setErrorMsg("");
      setAnalysis(null);

      const form = new FormData();
      form.append("file", nextFile);

      try {
        const res = await fetch("/api/full-process", { method: "POST", body: form });
        
        if (id !== loadIdRef.current) return;
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        const data = await res.json();
        if (id !== loadIdRef.current) return;

        if (data.analysis) {
          setAnalysis(data.analysis);
        }

        if (data.is_assembly && Array.isArray(data.components) && data.components.length > 0) {
          const comps: ApiComp[] = data.components;
          setIsAssembly(true);
          setAssemblyApiComps(comps);
          setActiveCostTab(-1);
          const root = comps.find(c => c.level === 0);
          if (root) {
            setBomPartNumber(root.part_number);
            setBomDescription(compLabel(root));
          }
        } else {
          setIsAssembly(false);
          setAssemblyApiComps([]);
        }

        if (data.occ_error || !data.stl_base64) {
          setErrorMsg(data.occ_error || "3D preview unavailable");
          setStatus("viewing");
          return;
        }

        // Convert base64 to blob efficiently
        const stlRes = await fetch(`data:application/octet-stream;base64,${data.stl_base64}`);
        const stlBlob = await stlRes.blob();
        const edgesData = data.edges || [];

        cleanup();

        const mount = mountRef.current;
        if (!mount) {
          throw new Error("Viewer mount is not ready");
        }

        const width = mount.clientWidth || 520;
        const height = mount.clientHeight || 520;

        const renderer = new THREE.WebGLRenderer({
          antialias: true,
          alpha: false,
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        renderer.setClearColor(0xffffff, 1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        mount.appendChild(renderer.domElement);
        rendererRef.current = renderer;

        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(45, width / height, 0.001, 1e6);
        camera.up.set(0, 0, 1);
        cameraRef.current = camera;

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controlsRef.current = controls;

        const stlUrl = URL.createObjectURL(stlBlob);
        new STLLoader().load(stlUrl, (geo) => {
          URL.revokeObjectURL(stlUrl);
          if (id !== loadIdRef.current) {
            geo.dispose();
            return;
          }

          geo.computeBoundingBox();
          const box = geo.boundingBox;
          if (!box) {
            geo.dispose();
            setErrorMsg("Could not determine model bounds");
            setStatus("error");
            return;
          }

          const center = new THREE.Vector3();
          box.getCenter(center);
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z) || 1;
          const scale = 100 / maxDim;
          modelCenterRef.current.copy(center);
          modelScaleRef.current = scale;

          geo.translate(-center.x, -center.y, -center.z);
          geo.scale(scale, scale, scale);

          const depthMesh = new THREE.Mesh(
            geo,
            new THREE.MeshBasicMaterial({
              colorWrite: false,
              side: THREE.FrontSide,
              depthWrite: true,
              depthTest: true,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            }),
          );
          depthMesh.renderOrder = 0;
          scene.add(depthMesh);

          const whiteMesh = new THREE.Mesh(
            geo,
            new THREE.MeshBasicMaterial({
              color: 0xffffff,
              side: THREE.FrontSide,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            }),
          );
          whiteMesh.renderOrder = 1;
          scene.add(whiteMesh);

          // Build edge positions
          let totalSegments = 0;
          for (const polyline of edgesData) {
            totalSegments += polyline.length - 1;
          }

          if (totalSegments > MAX_VIEWER_SEGMENTS) {
            geo.dispose();
            setErrorMsg("Too many model edges to render. Try a simpler model.");
            setStatus("error");
            return;
          }

          if (totalSegments > 0) {
            const positions = new Float32Array(totalSegments * 6);
            let ptr = 0;
            for (const polyline of (edgesData as number[][][])) {
              for (let i = 0; i < polyline.length - 1; i += 1) {
                const [x1, y1, z1] = polyline[i];
                const [x2, y2, z2] = polyline[i + 1];
                positions[ptr++] = (x1 - center.x) * scale;
                positions[ptr++] = (y1 - center.y) * scale;
                positions[ptr++] = (z1 - center.z) * scale;
                positions[ptr++] = (x2 - center.x) * scale;
                positions[ptr++] = (y2 - center.y) * scale;
                positions[ptr++] = (z2 - center.z) * scale;
              }
            }

            const lineGeometry = new LineSegmentsGeometry();
            lineGeometry.setPositions(positions);
            const lineMaterial = new LineMaterial({
              color: 0x000000,
              linewidth: linePx,
              worldUnits: false,
              depthTest: true,
              depthWrite: false,
              depthFunc: THREE.LessEqualDepth,
              resolution: new THREE.Vector2(width, height),
            });
            linMatRef.current = lineMaterial;
            const lines = new LineSegments2(lineGeometry, lineMaterial);
            lines.renderOrder = 2;
            scene.add(lines);
          }

          camera.position.set(80, 80, 80);
          controls.target.set(0, 0, 0);
          controls.update();
          setStatus("viewing");
        });

        const onResize = () => {
          const nextWidth = mount.clientWidth || 520;
          const nextHeight = mount.clientHeight || 520;
          camera.aspect = nextWidth / nextHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(nextWidth, nextHeight);
          linMatRef.current?.resolution.set(nextWidth, nextHeight);
        };
        resizeHandlerRef.current = onResize;
        window.addEventListener("resize", onResize);

        const tick = () => {
          frameRef.current = requestAnimationFrame(tick);
          controls.update();
          renderer.render(scene, camera);
        };
        tick();
      } catch (err) {
        if (id !== loadIdRef.current) return;
        setErrorMsg(String(err instanceof Error ? err.message : err));
        setStatus("error");
      }
    },
    [cleanup, linePx],
  );

  const accept = useCallback(
    (nextFile: File) => {
      const ext = nextFile.name.split(".").pop()?.toLowerCase() ?? "";
      if (!["step", "stp"].includes(ext)) {
        setErrorMsg("Only .step / .stp files accepted");
        setStatus("error");
        return;
      }
      const nextBaseName = nextFile.name.replace(/\.[^.]+$/, "");
      setFile(nextFile);
      setPartName(nextBaseName);
      setBomPartNumber(nextBaseName);
      setBomDescription(nextBaseName);
      setMaterialNumber("MAT-001");
      setMaterialDescription(
        (costConfig.materials.find(m => m.id === costConfig.materialId)?.label ?? 'MILD STEEL').toUpperCase()
      );
      loadMesh(nextFile);
    },
    [costConfig.materialId, costConfig.materials, loadMesh],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const nextFile = e.dataTransfer.files[0];
      if (nextFile) {
        accept(nextFile);
      }
    },
    [accept],
  );

  const exportJpg = useCallback(async () => {
    if (!file) return;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!scene || !camera) return;

    setStatus("exporting");
    setErrorMsg("");

    let exportRenderer: THREE.WebGLRenderer | null = null;
    let previousLineWidth: number | null = null;
    try {
      const exportPx = Math.round((exportCm / 2.54) * exportDpi);
      if (!Number.isFinite(exportPx) || exportPx < 1) {
        throw new Error("Export size and DPI must produce a valid image");
      }
      if (exportPx > MAX_EXPORT_PX) {
        throw new Error(`Export is ${exportPx}px. Keep the longest side at ${MAX_EXPORT_PX}px or less.`);
      }

      controls?.update();
      const renderScale = Math.max(1, Math.min(EXPORT_SUPERSAMPLE, Math.floor(MAX_EXPORT_PX / exportPx)));
      const renderPx = exportPx * renderScale;

      exportRenderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
      });
      exportRenderer.setPixelRatio(1);
      exportRenderer.setSize(renderPx, renderPx, false);
      exportRenderer.setClearColor(0xffffff, 1);
      exportRenderer.outputColorSpace = THREE.SRGBColorSpace;

      const exportCamera = camera.clone() as THREE.PerspectiveCamera;
      exportCamera.aspect = 1;
      exportCamera.updateProjectionMatrix();
      if (linMatRef.current) {
        previousLineWidth = linMatRef.current.linewidth;
        linMatRef.current.linewidth = linePx * renderScale;
        linMatRef.current.resolution.set(renderPx, renderPx);
      }
      exportRenderer.render(scene, exportCamera);

      const blob = await new Promise<Blob>((resolve, reject) => {
        const canvas = document.createElement("canvas");
        canvas.width = exportPx;
        canvas.height = exportPx;
        const ctx = canvas.getContext("2d");
        if (!ctx || !exportRenderer) {
          reject(new Error("Could not prepare JPG canvas"));
          return;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(exportRenderer.domElement, 0, 0, exportPx, exportPx);
        canvas.toBlob(
          (nextBlob) => {
            if (nextBlob) {
              resolve(nextBlob);
            } else {
              reject(new Error("Could not encode JPG"));
            }
          },
          "image/jpeg",
          0.98,
        );
      });

      const url = URL.createObjectURL(blob);
      const name = partName.trim() || file.name.replace(/\.[^.]+$/, "");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
      setStatus("viewing");
    } catch (err) {
      setErrorMsg(String(err instanceof Error ? err.message : err));
      setStatus("viewing");
    } finally {
      const mount = mountRef.current;
      if (linMatRef.current && previousLineWidth !== null) {
        linMatRef.current.linewidth = previousLineWidth;
      }
      if (mount) {
        linMatRef.current?.resolution.set(mount.clientWidth || 520, mount.clientHeight || 520);
      }
      exportRenderer?.dispose();
    }
  }, [exportCm, exportDpi, file, linePx, partName]);

  const reset = () => {
    cleanup();
    setFile(null);
    setStatus("idle");
    setErrorMsg("");
    setPartName("");
    setAnalysis(null);
    setBomPartNumber("");
    setBomDescription("");
    setMaterialNumber("MAT-001");
    setMaterialDescription("MILD STEEL");
    setIsAssembly(false);
    setAssemblyApiComps([]);
    setActiveCostTab(-1);
    setCostConfig(DEFAULT_COST_CONFIG);
  };

  const showDrop = status === "idle" || status === "error";
  const showViewer = status === "viewing" || status === "exporting";

  return (
    <main className={`min-h-screen flex flex-col items-center p-6 gap-5 ${showViewer ? "justify-start" : "justify-center"}`}>
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">STEP to Label</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Rotate to pick a view, then export a clean hidden-line JPG.
        </p>
      </div>

      {showDrop && (
        <div
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          className={[
            "relative flex h-48 w-80 cursor-pointer select-none flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed transition-colors",
            dragging ? "border-blue-400 bg-blue-950/30" : "border-zinc-700 bg-zinc-900 hover:border-zinc-500",
          ].join(" ")}
        >
          <div 
            className="absolute inset-0 z-0" 
            onClick={() => inputRef.current?.click()} 
          />
          <svg className="pointer-events-none z-10 h-10 w-10 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
            />
          </svg>
          <span className="pointer-events-none z-10 text-sm text-zinc-500">Drop .step / .stp or click</span>
          <input
            ref={inputRef}
            type="file"
            accept=".step,.stp"
            className="hidden"
            onChange={(e) => {
              const nextFile = e.target.files?.[0];
              if (nextFile) {
                accept(nextFile);
              }
              // Reset value so same file can be uploaded again
              e.target.value = "";
            }}
          />
        </div>
      )}

      {status === "loading" && (
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v8H4z" />
          </svg>
          Loading model...
        </div>
      )}

      {errorMsg && <p className="max-w-xs text-center text-sm text-red-400">{errorMsg}</p>}

      <div className={`w-full max-w-[1120px] ${showViewer ? "" : "hidden"}`}>
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <div
              ref={mountRef}
              className="mx-auto aspect-square w-full max-w-[520px] overflow-hidden rounded-xl border border-zinc-700 bg-white relative"
            >
              {errorMsg && (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-500 bg-zinc-900/80">
                  {errorMsg}
                </div>
              )}
            </div>

            {showViewer && (
              <div className="mt-4 flex flex-col gap-4">
                <p className="text-center text-xs text-zinc-500">
                  Left drag to rotate · Right drag to pan · Scroll to zoom
                </p>

                <div className="mx-auto flex w-full max-w-[520px] items-center justify-center gap-3 text-sm text-zinc-400">
                  <label htmlFor="line-thickness">Line Thickness</label>
                  <input
                    id="line-thickness"
                    type="range"
                    min={1}
                    max={10}
                    value={linePx}
                    onChange={(e) => setLinePx(Number(e.target.value))}
                    className="w-32 accent-blue-500"
                  />
                  <span className="w-4 text-zinc-200">{linePx}</span>
                </div>

                <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3">
                  <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_7rem_7rem_auto_auto] md:items-end">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-zinc-500">Part Name</label>
                      <input
                        type="text"
                        value={partName}
                        onChange={(e) => setPartName(e.target.value)}
                        placeholder="BRACKET-001…"
                        className="h-10 rounded border border-zinc-700 bg-zinc-950 px-3 text-sm font-mono text-zinc-200 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-zinc-500">Size (mm)</label>
                      <input
                        type="number"
                        min={5}
                        max={1000}
                        value={Math.round(exportCm * 10)}
                        onChange={(e) => setExportCm(Number(e.target.value) / 10)}
                        className="h-10 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm font-mono text-zinc-200"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-zinc-500">DPI</label>
                      <input
                        type="number"
                        min={72}
                        max={1200}
                        value={exportDpi}
                        onChange={(e) => setExportDpi(Number(e.target.value))}
                        className="h-10 rounded border border-zinc-700 bg-zinc-950 px-2 text-sm font-mono text-zinc-200"
                      />
                    </div>
                    <button
                      onClick={exportJpg}
                      disabled={status === "exporting"}
                      className="h-10 rounded bg-blue-600 px-4 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                    >
                      {status === "exporting" ? "Exporting…" : "Export"}
                    </button>
                    <button
                      onClick={reset}
                      className="h-10 rounded border border-zinc-700 bg-zinc-800 px-4 text-sm text-zinc-300 transition-colors hover:bg-zinc-700"
                    >
                      New
                    </button>
                  </div>
                  <div className="mt-3 text-xs text-zinc-500">
                    {Math.round((exportCm / 2.54) * exportDpi)} × {Math.round((exportCm / 2.54) * exportDpi)} px JPG
                  </div>
                </div>
              </div>
            )}
          </section>

          {showViewer && (
            analysis && costBreakdown ? (
              <>
                <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Costing</div>
                    {isAssembly && (
                      <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full">
                        Assembly · {sheetMetalComps.length} sheet metal · {assemblyApiComps.filter(c => c.type === 'purchase').length} purchased
                      </span>
                    )}
                  </div>

                  {/* Shared settings */}
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-zinc-500">MOQ</label>
                      <input type="number" min={1} value={costConfig.moq}
                        onChange={(e) => setCostConfig(c => ({ ...c, moq: Math.max(1, Number(e.target.value)) }))}
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm font-mono text-zinc-200" />
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-zinc-500">Material</label>
                      <select value={costConfig.materialId}
                        onChange={(e) => setCostConfig(c => ({ ...c, materialId: e.target.value }))}
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-200">
                        {costConfig.materials.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                      </select>
                    </div>
                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-zinc-500">Sheet Size</label>
                      <select value={costConfig.sheetIndex}
                        onChange={(e) => setCostConfig(c => ({ ...c, sheetIndex: Number(e.target.value) }))}
                        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm text-zinc-200">
                        {costConfig.sheets.map((s, i) => <option key={i} value={i}>{s.label}</option>)}
                      </select>
                    </div>
                    {!isAssembly && (
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-zinc-500">Thickness (mm)</label>
                        <input type="number" min={0.5} step={0.1}
                          value={costConfig.thicknessOverrideMm ?? analysis.thickness_mm}
                          onChange={(e) => setCostConfig(c => ({ ...c, thicknessOverrideMm: Number(e.target.value) }))}
                          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-2 text-sm font-mono text-zinc-200" />
                      </div>
                    )}
                  </div>

                  {costConfig.processes.some(p => p.enabled && p.autoFrom === 'weld_length') && (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-zinc-900 px-3 py-2">
                      <label className="text-xs text-zinc-500">Weld length (mm)</label>
                      <input type="number" min={0} value={costConfig.weldLengthMm}
                        onChange={(e) => setCostConfig(c => ({ ...c, weldLengthMm: Math.max(0, Number(e.target.value)) }))}
                        className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-right text-sm font-mono text-zinc-200" />
                    </div>
                  )}

                  {isAssembly && sheetMetalComps.length > 0 ? (
                    <>
                      {/* Tabs: Assembly first, then components */}
                      <div className="flex border-b border-zinc-700 gap-0 flex-wrap">
                        <button onClick={() => setActiveCostTab(-1)}
                          className={`px-3 py-1.5 text-xs font-bold border-b-2 transition-colors ${activeCostTab === -1 ? 'border-blue-500 text-blue-300' : 'border-transparent text-zinc-400 hover:text-zinc-200'}`}>
                          📊 Assembly
                        </button>
                        {sheetMetalComps.map((comp, i) => (
                          <button key={i} onClick={() => setActiveCostTab(i)}
                            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${activeCostTab === i ? 'border-blue-500 text-blue-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
                            {compLabel(comp)}
                          </button>
                        ))}
                      </div>

                      {activeCostTab === -1 ? (
                        // Assembly Total tab — components summary + dynamic pre/post-asm processes + manual purchase parts
                        <div className="flex flex-col gap-3">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                                <th className="px-3 py-2 text-left font-medium">Component / Operation</th>
                                <th className="px-3 py-2 text-center font-medium">Qty</th>
                                <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                              </tr>
                            </thead>
                            <tbody>
                              <tr>
                                <td colSpan={3} className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Sheet-Metal Components</td>
                              </tr>
                              {sheetMetalComps.map((comp, i) => (
                                <tr key={i} className="border-b border-zinc-800 hover:bg-zinc-800/40 cursor-pointer"
                                  onClick={() => setActiveCostTab(i)}>
                                  <td className="px-3 py-2 text-zinc-300 text-xs">{compLabel(comp)}</td>
                                  <td className="px-3 py-2 text-center text-xs text-zinc-400">1</td>
                                  <td className="px-3 py-2 text-right font-mono text-zinc-200">${compBreakdowns[i]?.totalUnit.toFixed(2) ?? '—'}</td>
                                </tr>
                              ))}
                              {assemblyApiComps.filter(c => c.type === 'purchase').length > 0 && (
                                <tr>
                                  <td colSpan={3} className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Parsed Purchase Parts (from STEP)</td>
                                </tr>
                              )}
                              {assemblyApiComps.filter(c => c.type === 'purchase').map((comp, i) => (
                                <tr key={`p${i}`} className="border-b border-zinc-800">
                                  <td className="px-3 py-2 text-zinc-400 text-xs">{compLabel(comp)}</td>
                                  <td className="px-3 py-2 text-center text-xs text-zinc-600">1</td>
                                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-500">edit in MLB →</td>
                                </tr>
                              ))}
                              {costConfig.manualPurchaseParts.length > 0 && (
                                <tr>
                                  <td colSpan={3} className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Manual Purchase Parts</td>
                                </tr>
                              )}
                              {costConfig.manualPurchaseParts.map(mpp => (
                                <tr key={mpp.id} className="border-b border-zinc-800">
                                  <td className="px-3 py-2 text-zinc-300 text-xs">{mpp.description || mpp.partNumber}</td>
                                  <td className="px-3 py-2 text-center text-xs text-zinc-400">{mpp.qty}</td>
                                  <td className="px-3 py-2 text-right font-mono text-zinc-200">${(mpp.qty * mpp.unitCost).toFixed(2)}</td>
                                </tr>
                              ))}
                              {assemblyProcCosts.length > 0 && (
                                <tr>
                                  <td colSpan={3} className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Assembly Operations (pre + post)</td>
                                </tr>
                              )}
                              {assemblyProcCosts.map(p => (
                                <tr key={p.key} className="border-b border-zinc-800">
                                  <td className="px-3 py-2 text-zinc-300 text-xs">
                                    {p.label} <span className="text-[9px] text-zinc-600 uppercase">({p.phase.replace('-assembly', '')})</span>
                                  </td>
                                  <td className="px-3 py-2 text-center text-xs text-zinc-600">—</td>
                                  <td className="px-3 py-2 text-right font-mono text-zinc-200">${p.unitCost.toFixed(2)}</td>
                                </tr>
                              ))}
                              <tr className="bg-zinc-800/60">
                                <td className="px-3 py-2 font-medium text-zinc-200">Total / unit</td>
                                <td />
                                <td className="px-3 py-2 text-right font-mono font-semibold text-white">
                                  ${(compBreakdowns.reduce((s, b) => s + b.totalUnit, 0) + purchasePartsCost + manualPurchaseCost + assemblyOpsCost).toFixed(2)}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                          <ManualPurchasePartsEditor costConfig={costConfig} setCostConfig={setCostConfig} />
                        </div>
                      ) : (() => {
                        const comp = sheetMetalComps[activeCostTab];
                        const bd = compBreakdowns[activeCostTab];
                        if (!bd || !comp) return null;
                        const resolved = resolveComponentConfig(costConfig, comp.part_number);
                        return (
                          <div className="flex flex-col gap-3">
                            <div className="flex items-center gap-3 flex-wrap">
                              <label className="text-xs text-zinc-500">Thickness (mm)</label>
                              <input type="number" min={0.5} step={0.1}
                                value={costConfig.perComponent[comp.part_number]?.thicknessMm ?? analysis.thickness_mm}
                                onChange={(e) => setCostConfig(c => ({
                                  ...c, perComponent: { ...c.perComponent,
                                    [comp.part_number]: { ...c.perComponent[comp.part_number], thicknessMm: Number(e.target.value) },
                                  },
                                }))}
                                className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-mono text-zinc-200" />
                              <span className="text-xs text-zinc-600">
                                {analysis.flat_blank_w_mm > 0
                                  ? `blank ${analysis.flat_blank_w_mm}×${analysis.flat_blank_h_mm}mm`
                                  : `bbox ${analysis.bbox_mm[0]}×${analysis.bbox_mm[1]}mm`}
                                {' · '}{analysis.bend_count} bends
                              </span>
                            </div>
                            <CostTable bd={bd} analysis={analysis} costConfig={resolved} setCostConfig={setCostConfig} partId={comp.part_number} purchasePartsCost={0} />
                          </div>
                        );
                      })()}
                    </>
                  ) : (
                    <>
                      <div className="rounded-lg bg-zinc-900 p-3 text-xs text-zinc-400 flex flex-col gap-1">
                        <div>
                          <span className="text-zinc-500">Flat blank: </span>
                          {analysis.flat_blank_w_mm > 0 ? `${analysis.flat_blank_w_mm} × ${analysis.flat_blank_h_mm} mm` : `${analysis.bbox_mm[0]} × ${analysis.bbox_mm[1]} mm (3D bbox)`}
                          {' · '}<span className="text-zinc-500">t </span>{analysis.thickness_mm} mm
                          {' · '}<span className="text-zinc-500">weight </span>{costBreakdown.blankMassKg.toFixed(3)} kg
                        </div>
                        <div className="flex gap-3">
                          <span>{analysis.bend_count} bend{analysis.bend_count !== 1 ? 's' : ''}</span>
                          <span>·</span>
                          <span>{analysis.hole_count} hole{analysis.hole_count !== 1 ? 's' : ''}</span>
                          {analysis.cut_perimeter_mm > 0 && <><span>·</span><span>{(analysis.cut_perimeter_mm / 1000).toFixed(2)} m cut</span></>}
                        </div>
                        <div>
                          <span className="text-zinc-500">Sheet yield: </span>
                          {costBreakdown.partsPerSheet} parts/sheet · {costBreakdown.sheetsNeeded} sheet{costBreakdown.sheetsNeeded !== 1 ? 's' : ''} for {costConfig.moq} pcs
                        </div>
                      </div>
                      <CostTable bd={costBreakdown} analysis={analysis} costConfig={costConfig} setCostConfig={setCostConfig} purchasePartsCost={purchasePartsCost} />
                    </>
                  )}

                  <ProcessCatalogEditor costConfig={costConfig} setCostConfig={setCostConfig} />

                  {/* Grand total */}
                  <div className="rounded-lg border border-blue-900/60 bg-blue-950/30 px-3 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-xs text-zinc-400">Total x {costConfig.moq} MOQ</div>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {isAssembly
                            ? `$${(compBreakdowns.reduce((s, b) => s + b.totalUnit, 0) + purchasePartsCost + manualPurchaseCost + assemblyOpsCost).toFixed(2)} / unit`
                            : `$${(costBreakdown.totalUnit + purchasePartsCost).toFixed(2)} / unit`}
                        </div>
                      </div>
                      <div className="text-right font-mono text-lg font-semibold text-blue-300">
                        {isAssembly
                          ? `$${((compBreakdowns.reduce((s, b) => s + b.totalUnit, 0) + purchasePartsCost + manualPurchaseCost + assemblyOpsCost) * costConfig.moq).toFixed(2)}`
                          : `$${((costBreakdown.totalUnit + purchasePartsCost) * costConfig.moq).toFixed(2)}`}
                      </div>
                    </div>
                  </div>
                </section>

                <MlbSection rows={mlbRows} onRowsChange={setMlbRows} />

                <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
                  <div className="border-b border-zinc-800 px-4 py-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">PFC</div>
                    <div className="mt-1 text-xs text-zinc-500">Process flow chart derived from the current MLB rows.</div>
                  </div>
                  <div className="p-4">
                    <PfcDiagram rows={mlbRows} isAssembly={isAssembly} />
                  </div>
                </section>
              </>
            ) : (
              <section className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 flex flex-col items-center justify-center text-center gap-3">
                <svg className="h-8 w-8 text-zinc-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <div className="text-sm text-zinc-400 font-medium">Analyzing part geometry…</div>
                <div className="text-xs text-zinc-500 max-w-[200px]">Extracting features for cost estimation (bends, perimeter, holes)</div>
              </section>
            )
          )}
        </div>
      </div>
    </main>
  );
}

export default Home;
