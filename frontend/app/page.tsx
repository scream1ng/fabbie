"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type { CostBreakdown, CostConfig, PartAnalysis } from "./costing";
import {
  calculateCost,
  DEFAULT_COST_CONFIG,
  resolveComponentConfig,
} from "./costing";
import type { GlobalRates, ProcessConfig, FinishingConfig, MaterialConfig, SheetConfig } from "./costing";
import {
  type BomStage,
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
  stages: BomStage[],
  matNum: string,
  matDesc: string,
  assemblyOps: { welding: boolean; finishing: boolean },
): BomRow[] {
  const root = components.find(c => c.level === 0);
  const rows: BomRow[] = [];
  if (root) {
    rows.push({ p: root.part_number, d: compLabel(root), proc: 'FG', qty: '1', lvl: 0 });
  }

  // Assembly ops ordered outermost→innermost (E-Coat wraps Weld).
  // lvl:1 = E-Coat (last applied, outermost parent)
  // lvl:2 = Weld   (consumed by E-Coat; direct parent of components)
  const asmOps: BomRow[] = [];
  if (assemblyOps.finishing) asmOps.push({ p: 'ECOAT', d: 'E-Coat / Powder Coat', proc: 'Gal',  qty: '1', lvl: 1 });
  if (assemblyOps.welding)   asmOps.push({ p: 'WELD',  d: 'Assembly Weld',        proc: 'Weld', qty: '1', lvl: asmOps.length + 1 });
  rows.push(...asmOps);

  // Components are children of the innermost assembly op.
  const compOffset = asmOps.length + 1; // e.g. 3 when both E-Coat(1) + Weld(2) present

  for (const comp of components.filter(c => c.level > 0 && !c.is_assembly)) {
    if (comp.type === 'purchase') {
      rows.push({ p: comp.part_number, d: compLabel(comp), proc: 'RAW', qty: '1', lvl: compOffset, unit_cost: '0' });
    } else {
      const subTree = buildBomTree({
        partNumber: comp.part_number,
        description: compLabel(comp),
        materialNumber: matNum,
        materialDescription: matDesc,
        stages,
      });
      for (const row of subTree) {
        const bracket = row.description.match(/\(([^)]+)\)\s*$/)?.[1]?.toUpperCase() ?? '';
        const proc = row.kind === 'material' ? 'RAW'
          : row.kind === 'fg'   ? ''
          : bracket === 'LASER' ? 'Laser'
          : bracket === 'BEND'  ? 'Bend'
          : bracket === 'WELD'  ? 'Weld'
          : bracket || '';
        // depth 0 = component header; processes at depth 1+; RAW at deepest
        rows.push({ p: row.itemNumber, d: row.description, proc, qty: '1', lvl: compOffset + row.depth });
      }
    }
  }

  return rows;
}


const MAX_EXPORT_PX = 4096;
const MAX_VIEWER_SEGMENTS = 60000;
const EXPORT_SUPERSAMPLE = 4;


function CostTable({ bd, analysis, costConfig, setCostConfig, partId, purchasePartsCost }: {
  bd: CostBreakdown;
  analysis: PartAnalysis;
  costConfig: CostConfig;
  setCostConfig: React.Dispatch<React.SetStateAction<CostConfig>>;
  partId?: string;
  purchasePartsCost: number;
}) {
  const eff = resolveComponentConfig(costConfig, partId);
  const procs = eff.processes;

  const setGlobalSheetCost = (v: number) => {
    if (partId) {
      setCostConfig(c => ({ ...c, perComponent: { ...c.perComponent, [partId]: { ...c.perComponent[partId], sheetCost: v } } }));
    } else {
      setCostConfig(c => ({ ...c, sheetCost: v }));
    }
  };

  type ProcKey = 'laser' | 'bending' | 'welding' | 'packing';
  const setProc = (key: ProcKey, field: keyof ProcessConfig, val: boolean | number) => {
    if (partId) {
      setCostConfig(c => ({
        ...c, perComponent: { ...c.perComponent, [partId]: {
          ...c.perComponent[partId], processes: {
            ...(c.perComponent[partId]?.processes ?? {}),
            [key]: { ...(c.perComponent[partId]?.processes?.[key] ?? c.processes[key]), [field]: val },
          },
        }},
      }));
    } else {
      setCostConfig(c => ({ ...c, processes: { ...c.processes, [key]: { ...c.processes[key], [field]: val } } }));
    }
  };

  const setFinishing = (field: keyof FinishingConfig, val: boolean | number) => {
    if (partId) {
      setCostConfig(c => ({
        ...c, perComponent: { ...c.perComponent, [partId]: {
          ...c.perComponent[partId], processes: {
            ...(c.perComponent[partId]?.processes ?? {}),
            finishing: { ...(c.perComponent[partId]?.processes?.finishing ?? c.processes.finishing), [field]: val },
          },
        }},
      }));
    } else {
      setCostConfig(c => ({ ...c, processes: { ...c.processes, finishing: { ...c.processes.finishing, [field]: val } } }));
    }
  };

  const setRate = (key: keyof GlobalRates, val: number) =>
    setCostConfig(c => ({ ...c, rates: { ...c.rates, [key]: val } }));

  const rows: Array<{ key: ProcKey | 'finishing'; label: string; pph: number; unitCost: number }> = [
    { key: 'laser',    label: 'Laser / Turret',         pph: bd.laserPcsPerHour,   unitCost: bd.cuttingUnit },
    { key: 'bending',  label: `CNC Bend (${analysis.bend_count})`, pph: bd.bendingPcsPerHour, unitCost: bd.bendingUnit },
    { key: 'welding',  label: 'Welding',                pph: bd.weldingPcsPerHour, unitCost: bd.weldingUnit },
    { key: 'finishing',label: 'Finishing',              pph: 0,                    unitCost: bd.finishingUnit },
    { key: 'packing',  label: 'Pack & Inspect',         pph: bd.packingPcsPerHour, unitCost: bd.packingUnit },
  ];

  return (
    <div className="overflow-x-auto rounded-lg bg-zinc-900">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs text-zinc-500">
            <th className="px-3 py-2 text-left font-medium">Process</th>
            <th className="px-2 py-2 text-center font-medium">pcs/h</th>
            <th className="px-2 py-2 text-center font-medium">Setup min</th>
            <th className="px-2 py-2 text-center font-medium">Rate $/hr</th>
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
                onChange={(e) => setGlobalSheetCost(Math.max(0, Number(e.target.value)))}
                className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
            </td>
            <td className="px-3 py-2 text-center font-mono text-zinc-200">${bd.materialUnit.toFixed(2)}</td>
          </tr>
          {rows.map(({ key, label, pph, unitCost }) => {
            const isFinishing = key === 'finishing';
            const proc = procs[key];
            const enabled = proc.enabled;
            return (
              <tr key={key} className="border-b border-zinc-800">
                <td className="px-3 py-2">
                  <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
                    <input type="checkbox" checked={enabled}
                      onChange={(e) => isFinishing ? setFinishing('enabled', e.target.checked) : setProc(key as ProcKey, 'enabled', e.target.checked)}
                      className="accent-blue-500" />
                    <span className={enabled ? '' : 'text-zinc-600'}>{label}</span>
                  </label>
                </td>
                <td className="px-2 py-2 text-center">
                  {isFinishing ? <span className="text-xs text-zinc-600">-</span> : (
                    <input type="number" min={0} disabled={!enabled}
                      value={(proc as ProcessConfig).pcsPerHour || Math.round(pph)}
                      onChange={(e) => setProc(key as ProcKey, 'pcsPerHour', Math.max(0, Number(e.target.value)))}
                      className="w-14 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35" />
                  )}
                </td>
                <td className="px-2 py-2 text-center">
                  {isFinishing ? <span className="text-xs text-zinc-600">-</span> : (
                    <input type="number" min={0} disabled={!enabled}
                      value={(proc as ProcessConfig).setupMin}
                      onChange={(e) => setProc(key as ProcKey, 'setupMin', Math.max(0, Number(e.target.value)))}
                      className="w-12 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35" />
                  )}
                </td>
                <td className="px-2 py-2 text-center">
                  {isFinishing ? (
                    <input type="number" min={0} disabled={!enabled}
                      value={(proc as FinishingConfig).costPerUnit}
                      onChange={(e) => setFinishing('costPerUnit', Math.max(0, Number(e.target.value)))}
                      className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35"
                      placeholder="$ flat" />
                  ) : (
                    <input type="number" min={0} disabled={!enabled}
                      value={costConfig.rates[key as keyof GlobalRates] as number}
                      onChange={(e) => setRate(key as keyof GlobalRates, Math.max(0, Number(e.target.value)))}
                      className="w-14 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35" />
                  )}
                </td>
                <td className="px-3 py-2 text-center font-mono text-zinc-200">
                  {enabled ? `$${unitCost.toFixed(2)}` : '-'}
                </td>
              </tr>
            );
          })}
          {purchasePartsCost > 0 && (
            <tr className="border-b border-zinc-800">
              <td className="px-3 py-2 text-zinc-400">Purchase Parts</td>
              <td colSpan={3} className="px-2 py-2 text-center text-xs text-zinc-600">-</td>
              <td className="px-3 py-2 text-center font-mono text-zinc-200">${purchasePartsCost.toFixed(2)}</td>
            </tr>
          )}
          <tr className="border-b border-zinc-700 bg-zinc-800/60">
            <td className="px-3 py-2 font-medium text-zinc-200">Total / unit</td>
            <td colSpan={3} />
            <td className="px-3 py-2 text-center font-mono font-semibold text-white">
              ${(bd.totalUnit + purchasePartsCost).toFixed(2)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function RatesEditor({ costConfig, setCostConfig }: {
  costConfig: CostConfig;
  setCostConfig: React.Dispatch<React.SetStateAction<CostConfig>>;
}) {
  const [open, setOpen] = React.useState(false);
  const setRate = (key: keyof GlobalRates, val: number) =>
    setCostConfig(c => ({ ...c, rates: { ...c.rates, [key]: val } }));
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

  return (
    <div className="rounded-lg border border-zinc-800">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200">
        <span>Rates &amp; Materials</span>
        <span>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="border-t border-zinc-800 p-3 flex flex-col gap-4">
          {/* Machine rates */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Machine Rates (AUD/hr)</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {([
                ['laser',   'Laser'],
                ['bending', 'Bending'],
                ['welding', 'Welding'],
                ['packing', 'Packing'],
              ] as [keyof GlobalRates, string][]).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-xs text-zinc-400">
                  <span className="w-16">{label}</span>
                  <input type="number" min={0} value={costConfig.rates[key] as number}
                    onChange={(e) => setRate(key, Math.max(0, Number(e.target.value)))}
                    className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
                </label>
              ))}
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="w-16">sec/bend</span>
                <input type="number" min={0} value={costConfig.rates.secPerBend}
                  onChange={(e) => setRate('secPerBend', Math.max(0, Number(e.target.value)))}
                  className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
              </label>
              <label className="flex items-center gap-2 text-xs text-zinc-400">
                <span className="w-16">Weld mm/min</span>
                <input type="number" min={0} value={costConfig.rates.weldSpeedMmPerMin}
                  onChange={(e) => setRate('weldSpeedMmPerMin', Math.max(0, Number(e.target.value)))}
                  className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200" />
              </label>
            </div>
          </div>

          {/* Materials */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Materials</div>
            <div className="flex flex-col gap-1">
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
              <div className="grid grid-cols-[1fr_80px_90px_28px] gap-1 mt-0.5">
                <span className="text-[10px] text-zinc-600 px-1">Name</span>
                <span className="text-[10px] text-zinc-600 text-center">kg/m³</span>
                <span className="text-[10px] text-zinc-600 text-center">mm/min</span>
              </div>
              <button onClick={addMat}
                className="text-xs text-zinc-500 hover:text-zinc-300 text-left px-1 mt-1">+ Add material</button>
            </div>
          </div>

          {/* Sheet sizes */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Sheet Sizes</div>
            <div className="flex flex-col gap-1">
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
          </div>
        </div>
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
  const [finishCode, setFinishCode] = useState("E");
  const [finishLabel, setFinishLabel] = useState("E-COAT");
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
  const assemblyOpsCost = useMemo(() => {
    if (!isAssembly) return 0;
    const { assemblyOps, rates, processes, moq } = costConfig;
    let total = 0;
    if (assemblyOps.welding) {
      const weldRunMin = costConfig.weldLengthMm / rates.weldSpeedMmPerMin;
      const weldPph = processes.welding.pcsPerHour > 0
        ? processes.welding.pcsPerHour
        : weldRunMin > 0 ? 60 / weldRunMin : 0;
      if (weldPph > 0) {
        total += rates.welding / weldPph
          + (processes.welding.setupMin / 60) * rates.welding / Math.max(moq, 1);
      }
    }
    if (assemblyOps.finishing) {
      total += Math.max(0, assemblyOps.finishCostPerUnit);
    }
    return total;
  }, [isAssembly, costConfig]);
  const bomStages = useMemo(
    () => buildProcessStages(
      {
        laser:    costConfig.processes.laser.enabled,
        bending:  costConfig.processes.bending.enabled,
        welding:  costConfig.processes.welding.enabled,
        finishing:costConfig.processes.finishing.enabled,
      },
      finishCode, finishLabel,
    ),
    [costConfig.processes, finishCode, finishLabel],
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
    const stages = buildProcessStages(
      {
        laser:    costConfig.processes.laser.enabled,
        bending:  costConfig.processes.bending.enabled,
        welding:  costConfig.processes.welding.enabled,
        finishing:costConfig.processes.finishing.enabled,
      },
      finishCode, finishLabel,
    );
    const newRows = buildAssemblyMlbRows(
      assemblyApiComps, stages, materialNumber, materialDescription,
      costConfig.assemblyOps,
    );
    setMlbRows(prev => prev.length === 0 ? newRows : mergeAssemblyRows(newRows, prev));
  // costConfig.processes + assemblyOps intentionally omitted — only trigger on assembly change
  // Process/ops changes are handled by the separate effect below
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAssembly, assemblyApiComps]);

  // Rebuild assembly rows when process toggles or assembly ops change (preserves user edits)
  useEffect(() => {
    if (!isAssembly || assemblyApiComps.length === 0) return;
    const stages = buildProcessStages(
      {
        laser:    costConfig.processes.laser.enabled,
        bending:  costConfig.processes.bending.enabled,
        welding:  costConfig.processes.welding.enabled,
        finishing:costConfig.processes.finishing.enabled,
      },
      finishCode, finishLabel,
    );
    const newRows = buildAssemblyMlbRows(
      assemblyApiComps, stages, materialNumber, materialDescription,
      costConfig.assemblyOps,
    );
    setMlbRows(prev => mergeAssemblyRows(newRows, prev));
  }, [costConfig.processes, costConfig.assemblyOps, finishCode, finishLabel]); // eslint-disable-line react-hooks/exhaustive-deps

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
          setActiveCostTab(0);
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
    setFinishCode("E");
    setFinishLabel("E-COAT");
    setIsAssembly(false);
    setAssemblyApiComps([]);
    setActiveCostTab(0);
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

                  {(isAssembly ? costConfig.assemblyOps.welding : costConfig.processes.welding.enabled) && (
                    <div className="flex items-center justify-between gap-3 rounded-lg bg-zinc-900 px-3 py-2">
                      <label className="text-xs text-zinc-500">Weld length (mm)</label>
                      <input type="number" min={0} value={costConfig.weldLengthMm}
                        onChange={(e) => setCostConfig(c => ({ ...c, weldLengthMm: Math.max(0, Number(e.target.value)) }))}
                        className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-right text-sm font-mono text-zinc-200" />
                    </div>
                  )}

                  {isAssembly && sheetMetalComps.length > 0 ? (
                    <>
                      {/* Component tabs */}
                      <div className="flex border-b border-zinc-700 gap-0 flex-wrap">
                        {sheetMetalComps.map((comp, i) => (
                          <button key={i} onClick={() => setActiveCostTab(i)}
                            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${activeCostTab === i ? 'border-blue-500 text-blue-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
                            {compLabel(comp)}
                          </button>
                        ))}
                        <button onClick={() => setActiveCostTab(sheetMetalComps.length)}
                          className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${activeCostTab === sheetMetalComps.length ? 'border-blue-500 text-blue-300' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
                          Assembly Total
                        </button>
                      </div>

                      {activeCostTab < sheetMetalComps.length ? (() => {
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
                      })() : (
                        // Assembly Total tab
                        <div className="flex flex-col gap-2">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                                <th className="px-3 py-2 text-left font-medium">Component</th>
                                <th className="px-3 py-2 text-center font-medium">t (mm)</th>
                                <th className="px-3 py-2 text-right font-medium">Unit Cost</th>
                              </tr>
                            </thead>
                            <tbody>
                              {sheetMetalComps.map((comp, i) => (
                                <tr key={i} className="border-b border-zinc-800">
                                  <td className="px-3 py-2 text-zinc-300 text-xs">{compLabel(comp)}</td>
                                  <td className="px-3 py-2 text-center font-mono text-xs text-zinc-400">
                                    {costConfig.perComponent[comp.part_number]?.thicknessMm ?? analysis.thickness_mm}
                                  </td>
                                  <td className="px-3 py-2 text-right font-mono text-zinc-200">${compBreakdowns[i]?.totalUnit.toFixed(2) ?? '—'}</td>
                                </tr>
                              ))}
                              {assemblyApiComps.filter(c => c.type === 'purchase').map((comp, i) => (
                                <tr key={`p${i}`} className="border-b border-zinc-800">
                                  <td className="px-3 py-2 text-zinc-400 text-xs">{compLabel(comp)} <span className="text-zinc-600">(purchased)</span></td>
                                  <td className="px-3 py-2 text-center text-xs text-zinc-600">—</td>
                                  <td className="px-3 py-2 text-right font-mono text-xs text-zinc-500">enter in MLB</td>
                                </tr>
                              ))}
                              {purchasePartsCost > 0 && (
                                <tr className="border-b border-zinc-800">
                                  <td className="px-3 py-2 text-zinc-400">Purchase parts total</td>
                                  <td />
                                  <td className="px-3 py-2 text-right font-mono text-zinc-200">${purchasePartsCost.toFixed(2)}</td>
                                </tr>
                              )}
                              <tr>
                                <td colSpan={3} className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-zinc-500">Assembly Operations</td>
                              </tr>
                              <tr className="border-b border-zinc-800">
                                <td className="px-3 py-2 text-zinc-300 text-xs">
                                  <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={costConfig.assemblyOps.welding}
                                      onChange={(e) => setCostConfig(c => ({ ...c, assemblyOps: { ...c.assemblyOps, welding: e.target.checked } }))}
                                      className="accent-blue-500" />
                                    Assembly Weld
                                  </label>
                                </td>
                                <td className="px-3 py-2 text-center text-xs text-zinc-600">—</td>
                                <td className="px-3 py-2 text-right font-mono text-zinc-200">
                                  ${costConfig.assemblyOps.welding ? assemblyOpsCost.toFixed(2) : '0.00'}
                                </td>
                              </tr>
                              <tr className="border-b border-zinc-800">
                                <td className="px-3 py-2 text-zinc-300 text-xs">
                                  <label className="flex items-center gap-2 cursor-pointer">
                                    <input type="checkbox" checked={costConfig.assemblyOps.finishing}
                                      onChange={(e) => setCostConfig(c => ({ ...c, assemblyOps: { ...c.assemblyOps, finishing: e.target.checked } }))}
                                      className="accent-blue-500" />
                                    {finishLabel || 'E-Coat / Finish'}
                                  </label>
                                </td>
                                <td className="px-3 py-2 text-center">
                                  {costConfig.assemblyOps.finishing && (
                                    <input type="number" min={0} value={costConfig.assemblyOps.finishCostPerUnit}
                                      onChange={(e) => setCostConfig(c => ({ ...c, assemblyOps: { ...c.assemblyOps, finishCostPerUnit: Math.max(0, Number(e.target.value)) } }))}
                                      className="w-20 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200"
                                      placeholder="$ / unit" />
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-zinc-200">
                                  ${costConfig.assemblyOps.finishing ? costConfig.assemblyOps.finishCostPerUnit.toFixed(2) : '0.00'}
                                </td>
                              </tr>
                              <tr className="bg-zinc-800/60">
                                <td className="px-3 py-2 font-medium text-zinc-200">Total / unit</td>
                                <td />
                                <td className="px-3 py-2 text-right font-mono font-semibold text-white">
                                  ${(compBreakdowns.reduce((s, b) => s + b.totalUnit, 0) + purchasePartsCost + assemblyOpsCost).toFixed(2)}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      )}
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

                  <RatesEditor costConfig={costConfig} setCostConfig={setCostConfig} />

                  {/* Grand total */}
                  <div className="rounded-lg border border-blue-900/60 bg-blue-950/30 px-3 py-3">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="text-xs text-zinc-400">Total x {costConfig.moq} MOQ</div>
                        <div className="mt-0.5 text-xs text-zinc-500">
                          {isAssembly
                            ? `$${(compBreakdowns.reduce((s, b) => s + b.totalUnit, 0) + purchasePartsCost + assemblyOpsCost).toFixed(2)} / unit`
                            : `$${(costBreakdown.totalUnit + purchasePartsCost).toFixed(2)} / unit`}
                        </div>
                      </div>
                      <div className="text-right font-mono text-lg font-semibold text-blue-300">
                        {isAssembly
                          ? `$${((compBreakdowns.reduce((s, b) => s + b.totalUnit, 0) + purchasePartsCost + assemblyOpsCost) * costConfig.moq).toFixed(2)}`
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
