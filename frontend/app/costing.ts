// AUD sheet-metal fabrication cost engine

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

export interface ProcessConfig {
  enabled: boolean;
  setupMin: number;
  pcsPerHour: number;   // 0 = auto-calculate from geometry
}

export interface FinishingConfig {
  enabled: boolean;
  costPerUnit: number;  // flat $ per unit
}

export interface GlobalRates {
  laser: number;             // AUD/hr
  bending: number;
  welding: number;
  packing: number;
  secPerBend: number;
  weldSpeedMmPerMin: number;
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
  rates: GlobalRates;

  processes: {
    laser: ProcessConfig;
    bending: ProcessConfig;
    welding: ProcessConfig;
    finishing: FinishingConfig;
    packing: ProcessConfig;
  };

  // keyed by part_number — per-component overrides in assembly mode
  perComponent: Record<string, {
    materialId?: string;
    thicknessMm?: number;
    sheetCost?: number;
    sheetIndex?: number;
    weldLengthMm?: number;
    processes?: {
      laser?: Partial<ProcessConfig>;
      bending?: Partial<ProcessConfig>;
      welding?: Partial<ProcessConfig>;
      finishing?: Partial<FinishingConfig>;
      packing?: Partial<ProcessConfig>;
    };
  }>;

  assemblyOps: {
    welding: boolean;
    finishing: boolean;
    finishCostPerUnit: number;
  };
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
  rates: {
    laser: 150,
    bending: 110,
    welding: 95,
    packing: 65,
    secPerBend: 15,
    weldSpeedMmPerMin: 250,
  },
  processes: {
    laser:    { enabled: true,  setupMin: 15, pcsPerHour: 0 },
    bending:  { enabled: true,  setupMin: 15, pcsPerHour: 0 },
    welding:  { enabled: false, setupMin: 15, pcsPerHour: 0 },
    finishing:{ enabled: false, costPerUnit: 0 },
    packing:  { enabled: true,  setupMin: 15, pcsPerHour: 120 },
  },
  perComponent: {},
  assemblyOps: { welding: false, finishing: false, finishCostPerUnit: 0 },
};

export interface CostBreakdown {
  materialUnit: number;
  cuttingUnit: number;
  bendingUnit: number;
  weldingUnit: number;
  finishingUnit: number;
  packingUnit: number;
  totalUnit: number;
  totalAll: number;
  sheetsNeeded: number;
  partsPerSheet: number;
  blankMassKg: number;
  laserPcsPerHour: number;
  bendingPcsPerHour: number;
  weldingPcsPerHour: number;
  finishingPcsPerHour: number;
  packingPcsPerHour: number;
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
    processes: ov.processes ? {
      laser:    { ...config.processes.laser,    ...(ov.processes.laser    ?? {}) },
      bending:  { ...config.processes.bending,  ...(ov.processes.bending  ?? {}) },
      welding:  { ...config.processes.welding,  ...(ov.processes.welding  ?? {}) },
      finishing:{ ...config.processes.finishing,...(ov.processes.finishing ?? {}) },
      packing:  { ...config.processes.packing,  ...(ov.processes.packing  ?? {}) },
    } : config.processes,
  };
}

export function calculateCost(analysis: PartAnalysis, config: CostConfig): CostBreakdown {
  const { moq, sheetCost, sheetIndex, thicknessOverrideMm, weldLengthMm, rates, processes } = config;
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

  const laserRunMin = analysis.cut_perimeter_mm / mat.laserSpeedMmPerMin;
  const laserAutoPph = laserRunMin > 0 ? 60 / laserRunMin : 0;
  const laserPcsPerHour = processes.laser.pcsPerHour > 0 ? processes.laser.pcsPerHour : laserAutoPph;

  const bendRunMin = (analysis.bend_count * rates.secPerBend) / 60;
  const bendAutoPph = bendRunMin > 0 ? 60 / bendRunMin : 0;
  const bendingPcsPerHour = processes.bending.pcsPerHour > 0 ? processes.bending.pcsPerHour : bendAutoPph;

  const weldRunMin = weldLengthMm / rates.weldSpeedMmPerMin;
  const weldAutoPph = weldRunMin > 0 ? 60 / weldRunMin : 0;
  const weldingPcsPerHour = processes.welding.pcsPerHour > 0 ? processes.welding.pcsPerHour : weldAutoPph;

  const procUnit = (active: boolean, rate: number, pph: number, setupMin: number) => {
    if (!active || pph <= 0) return 0;
    return rate / pph + (setupMin / 60) * rate / effectiveQty;
  };

  const cuttingUnit  = procUnit(processes.laser.enabled, rates.laser, laserPcsPerHour, processes.laser.setupMin);
  const bendingUnit  = procUnit(processes.bending.enabled && analysis.bend_count > 0, rates.bending, bendingPcsPerHour, processes.bending.setupMin);
  const weldingUnit  = procUnit(processes.welding.enabled, rates.welding, weldingPcsPerHour, processes.welding.setupMin);
  const finishingUnit = processes.finishing.enabled ? Math.max(0, processes.finishing.costPerUnit) : 0;
  const packingUnit  = procUnit(processes.packing.enabled, rates.packing, processes.packing.pcsPerHour, processes.packing.setupMin);

  const totalUnit = materialUnit + cuttingUnit + bendingUnit + weldingUnit + finishingUnit + packingUnit;

  return {
    materialUnit, cuttingUnit, bendingUnit, weldingUnit, finishingUnit, packingUnit,
    totalUnit, totalAll: totalUnit * effectiveQty,
    sheetsNeeded, partsPerSheet, blankMassKg,
    laserPcsPerHour, bendingPcsPerHour, weldingPcsPerHour,
    finishingPcsPerHour: 0,
    packingPcsPerHour: processes.packing.pcsPerHour,
  };
}
