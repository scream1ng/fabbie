// AUD sheet-metal fabrication cost engine — dynamic process catalog

export interface PartAnalysis {
  bbox_mm: [number, number, number];
  thickness_mm: number;
  cut_perimeter_mm: number;
  hole_count: number;
  bend_count: number;
  flat_area_mm2: number;
  flat_pattern_area_mm2: number;
  flat_blank_w_mm: number;
  flat_blank_h_mm: number;
  holes_mm: number[];
}

export interface MaterialConfig {
  id: string;
  label: string;
  density: number;           // kg/m³
  laserSpeedMmPerMin: number;
}

export interface SheetConfig {
  label: string;
  w: number;
  h: number;
}

export type ProcessPhase = 'component' | 'pre-assembly' | 'post-assembly';
export type AutoFormula = 'none' | 'perimeter' | 'bend_count' | 'weld_length';

export interface ProcessDef {
  key: string;              // unique identifier
  label: string;            // display name
  phase: ProcessPhase;
  enabled: boolean;
  rate: number;             // AUD/hr; 0 = pure flat-cost
  pcsPerHour: number;       // 0 = auto via autoFrom
  setupMin: number;
  flatCostPerUnit: number;  // added on top OR sole cost when rate=0
  autoFrom: AutoFormula;
  mlbProcLabel: string;     // proc tag in MLB row
  custom?: boolean;         // user-added (for delete control)
}

export interface ManualPurchasePart {
  id: string;
  partNumber: string;
  description: string;
  qty: number;
  unitCost: number;
}

export interface AutoParams {
  secPerBend: number;        // bend cycle time
  weldSpeedMmPerMin: number; // weld speed
}

export interface ComponentOverride {
  materialId?: string;
  thicknessMm?: number;
  sheetCost?: number;
  sheetIndex?: number;
  weldLengthMm?: number;
  // undefined = inherit; defined array = override which component-phase processes apply
  enabledProcessKeys?: string[];
  // per-process tuning (pcs/h, setup, rate, flat)
  perProcess?: Record<string, Partial<Pick<ProcessDef, 'pcsPerHour' | 'setupMin' | 'rate' | 'flatCostPerUnit'>>>;
}

export interface CostConfig {
  moq: number;
  materialId: string;
  sheetCost: number;
  sheetIndex: number;
  thicknessOverrideMm: number | null;
  weldLengthMm: number;
  materials: MaterialConfig[];
  sheets: SheetConfig[];
  autoParams: AutoParams;
  processes: ProcessDef[];                       // ordered catalog (array order = BOM order outer→inner per phase)
  manualPurchaseParts: ManualPurchasePart[];     // user-added purchase parts at assembly level
  perComponent: Record<string, ComponentOverride>;
}

export const DEFAULT_COST_CONFIG: CostConfig = {
  moq: 1,
  materialId: 'mild_steel',
  sheetCost: 80,
  sheetIndex: 0,
  thicknessOverrideMm: null,
  weldLengthMm: 0,
  materials: [
    { id: 'mild_steel', label: 'Mild Steel',    density: 7850, laserSpeedMmPerMin: 3000 },
    { id: 'ss304',      label: 'SS304',          density: 8000, laserSpeedMmPerMin: 2000 },
    { id: 'al5052',     label: 'Aluminium 5052', density: 2680, laserSpeedMmPerMin: 5000 },
  ],
  sheets: [
    { label: '2400 × 1200 mm', w: 2400, h: 1200 },
    { label: '3000 × 1500 mm', w: 3000, h: 1500 },
    { label: '2500 × 1250 mm', w: 2500, h: 1250 },
  ],
  autoParams: { secPerBend: 15, weldSpeedMmPerMin: 250 },
  processes: [
    { key: 'laser',    label: 'Laser / Turret',  phase: 'component',     enabled: true,  rate: 150, pcsPerHour: 0,   setupMin: 15, flatCostPerUnit: 0, autoFrom: 'perimeter',   mlbProcLabel: 'Laser' },
    { key: 'bending',  label: 'CNC Bend',         phase: 'component',     enabled: true,  rate: 110, pcsPerHour: 0,   setupMin: 15, flatCostPerUnit: 0, autoFrom: 'bend_count',  mlbProcLabel: 'Bend'  },
    { key: 'welding',  label: 'Assembly Weld',    phase: 'pre-assembly',  enabled: false, rate: 95,  pcsPerHour: 0,   setupMin: 15, flatCostPerUnit: 0, autoFrom: 'weld_length', mlbProcLabel: 'Weld'  },
    { key: 'ecoat',    label: 'E-Coat / Powder',  phase: 'post-assembly', enabled: false, rate: 0,   pcsPerHour: 0,   setupMin: 0,  flatCostPerUnit: 5, autoFrom: 'none',        mlbProcLabel: 'Gal'   },
    { key: 'packing',  label: 'Pack & Inspect',   phase: 'post-assembly', enabled: true,  rate: 65,  pcsPerHour: 120, setupMin: 15, flatCostPerUnit: 0, autoFrom: 'none',        mlbProcLabel: 'Pack'  },
  ],
  manualPurchaseParts: [],
  perComponent: {},
};

export interface ProcessCost {
  key: string;
  label: string;
  unitCost: number;
  pcsPerHour: number;
}

export interface CostBreakdown {
  materialUnit: number;
  processUnits: ProcessCost[];   // component-phase process costs (excludes pre/post-asm)
  totalUnit: number;             // material + component-phase processes
  totalAll: number;
  sheetsNeeded: number;
  partsPerSheet: number;
  blankMassKg: number;
}

// Returns the effective process list for a component (applies override toggles + per-process tuning)
export function effectiveProcessesForComponent(
  config: CostConfig,
  partId?: string,
): ProcessDef[] {
  const ov = partId ? config.perComponent[partId] : undefined;
  const enabledSet = ov?.enabledProcessKeys;
  return config.processes.map(p => {
    const tuned = ov?.perProcess?.[p.key];
    const allowedByOverride = enabledSet ? enabledSet.includes(p.key) : p.enabled;
    return {
      ...p,
      enabled: allowedByOverride,
      pcsPerHour: tuned?.pcsPerHour ?? p.pcsPerHour,
      setupMin: tuned?.setupMin ?? p.setupMin,
      rate: tuned?.rate ?? p.rate,
      flatCostPerUnit: tuned?.flatCostPerUnit ?? p.flatCostPerUnit,
    };
  });
}

export function getProcessesByPhase(processes: ProcessDef[], phase: ProcessPhase): ProcessDef[] {
  return processes.filter(p => p.phase === phase);
}

export function resolveComponentConfig(config: CostConfig, partId?: string): CostConfig {
  if (!partId) return config;
  const ov = config.perComponent[partId];
  if (!ov) return config;
  return {
    ...config,
    materialId: ov.materialId ?? config.materialId,
    sheetCost: ov.sheetCost ?? config.sheetCost,
    sheetIndex: ov.sheetIndex ?? config.sheetIndex,
    thicknessOverrideMm: ov.thicknessMm ?? config.thicknessOverrideMm,
    weldLengthMm: ov.weldLengthMm ?? config.weldLengthMm,
    processes: effectiveProcessesForComponent(config, partId),
  };
}

function autoPcsPerHour(
  proc: ProcessDef,
  analysis: PartAnalysis,
  material: MaterialConfig,
  autoParams: AutoParams,
  weldLengthMm: number,
): number {
  switch (proc.autoFrom) {
    case 'perimeter': {
      const min = analysis.cut_perimeter_mm / material.laserSpeedMmPerMin;
      return min > 0 ? 60 / min : 0;
    }
    case 'bend_count': {
      const min = (analysis.bend_count * autoParams.secPerBend) / 60;
      return min > 0 ? 60 / min : 0;
    }
    case 'weld_length': {
      const min = weldLengthMm / autoParams.weldSpeedMmPerMin;
      return min > 0 ? 60 / min : 0;
    }
    default:
      return 0;
  }
}

// Computes per-process unit cost given resolved pcs/h, rate, setup, flat
function computeProcUnit(proc: ProcessDef, pph: number, moq: number): number {
  if (!proc.enabled) return 0;
  const effectiveMoq = Math.max(moq, 1);
  const flat = Math.max(0, proc.flatCostPerUnit);
  if (proc.rate <= 0) return flat;
  if (pph <= 0) return flat;
  return proc.rate / pph + (proc.setupMin / 60) * proc.rate / effectiveMoq + flat;
}

// Calculate cost for a single component (component-phase processes only)
export function calculateCost(analysis: PartAnalysis, config: CostConfig): CostBreakdown {
  const { moq, sheetCost, sheetIndex, thicknessOverrideMm, weldLengthMm, autoParams } = config;
  const effectiveQty = Math.max(moq, 1);
  const mat = config.materials.find(m => m.id === config.materialId) ?? config.materials[0];
  const sheet = config.sheets[sheetIndex] ?? config.sheets[0];
  const thickness = thicknessOverrideMm ?? analysis.thickness_mm;

  const blankW = analysis.flat_blank_w_mm > 0 ? analysis.flat_blank_w_mm : analysis.bbox_mm[0];
  const blankH = analysis.flat_blank_h_mm > 0 ? analysis.flat_blank_h_mm : analysis.bbox_mm[1];

  const partsPerRow = Math.max(1, Math.floor(sheet.w / blankW));
  const partsPerCol = Math.max(1, Math.floor(sheet.h / blankH));
  const partsPerSheet = partsPerRow * partsPerCol;
  const sheetsNeeded = Math.ceil(effectiveQty / partsPerSheet);

  const blankMassKg = ((blankW * blankH * thickness) / 1e9) * mat.density;
  const materialUnit = sheetCost / partsPerSheet;

  const componentProcs = getProcessesByPhase(config.processes, 'component');
  const processUnits: ProcessCost[] = componentProcs.map(proc => {
    const pph = proc.pcsPerHour > 0
      ? proc.pcsPerHour
      : autoPcsPerHour(proc, analysis, mat, autoParams, weldLengthMm);
    const unitCost = computeProcUnit(proc, pph, moq);
    return { key: proc.key, label: proc.label, unitCost, pcsPerHour: pph };
  });

  const procTotal = processUnits.reduce((s, p) => s + p.unitCost, 0);
  const totalUnit = materialUnit + procTotal;

  return {
    materialUnit,
    processUnits,
    totalUnit,
    totalAll: totalUnit * effectiveQty,
    sheetsNeeded,
    partsPerSheet,
    blankMassKg,
  };
}

// Calculate per-unit cost for pre/post-assembly process (uses weld_length auto on assembly-level)
export function calculateAssemblyProcessCost(
  proc: ProcessDef,
  config: CostConfig,
): number {
  const mat = config.materials.find(m => m.id === config.materialId) ?? config.materials[0];
  // Assembly-level processes don't have a part analysis — only auto formulas using config-level data work
  const fakeAnalysis: PartAnalysis = {
    bbox_mm: [0, 0, 0], thickness_mm: 0, cut_perimeter_mm: 0, hole_count: 0, bend_count: 0,
    flat_area_mm2: 0, flat_pattern_area_mm2: 0, flat_blank_w_mm: 0, flat_blank_h_mm: 0, holes_mm: [],
  };
  const pph = proc.pcsPerHour > 0
    ? proc.pcsPerHour
    : autoPcsPerHour(proc, fakeAnalysis, mat, config.autoParams, config.weldLengthMm);
  return computeProcUnit(proc, pph, config.moq);
}
