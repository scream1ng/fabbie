// AUD sheet-metal fabrication cost engine — hardcoded defaults

export interface PartAnalysis {
  bbox_mm: [number, number, number]; // 3-D bounding box [W, H, D]
  thickness_mm: number;
  cut_perimeter_mm: number;
  hole_count: number;
  bend_count: number;
  flat_area_mm2: number;
  flat_pattern_area_mm2: number;
  flat_blank_w_mm: number; // unfolded blank width
  flat_blank_h_mm: number; // unfolded blank height
  holes_mm: number[];
}

export interface Material {
  label: string;
  density: number; // kg/m³
  laserSpeedMmPerMin: number;
}

export const MATERIALS: Record<string, Material> = {
  "Mild Steel": {
    label: "Mild Steel",
    density: 7850,
    laserSpeedMmPerMin: 3000,
  },
  SS304: {
    label: "SS304",
    density: 8000,
    laserSpeedMmPerMin: 2000,
  },
  "Aluminium 5052": {
    label: "Aluminium 5052",
    density: 2680,
    laserSpeedMmPerMin: 5000,
  },
};

export const STANDARD_SHEETS = [
  { label: "2400 × 1200 mm", w: 2400, h: 1200 },
  { label: "3000 × 1500 mm", w: 3000, h: 1500 },
  { label: "2500 × 1250 mm", w: 2500, h: 1250 },
];

// AUD/hr machine rates
export const RATES = {
  laser: 150,
  bending: 110,
  welding: 95,
  finishing: 80,
  packing: 65,
  secPerBend: 15,
  weldSpeedMmPerMin: 250,
} as const;

export const DEFAULT_SETUP_MIN = 15;

export interface CostParams {
  moq: number;
  materialKey: string;
  sheetCost: number;
  thicknessOverrideMm: number | null;
  sheetIndex: number;
  processes: {
    laser: boolean;
    bending: boolean;
    welding: boolean;
    finishing: boolean;
    packing: boolean;
  };
  laserPcsPerHour: number;
  bendingPcsPerHour: number;
  weldingPcsPerHour: number;
  finishingPcsPerHour: number;
  packingPcsPerHour: number;
  laserSetupMin: number;
  bendingSetupMin: number;
  weldingSetupMin: number;
  finishingSetupMin: number;
  packingSetupMin: number;
  laserRate: number;
  bendingRate: number;
  weldingRate: number;
  finishingRate: number;
  finishingCost: number;
  packingRate: number;
  weldLengthMm: number;
  boxLengthMm: number;
  boxWidthMm: number;
  boxHeightMm: number;
}

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

export function calculateCost(
  analysis: PartAnalysis,
  params: CostParams,
): CostBreakdown {
  const {
    moq,
    materialKey,
    sheetCost,
    thicknessOverrideMm,
    sheetIndex,
    processes,
    laserSetupMin,
    bendingSetupMin,
    weldingSetupMin,
    packingSetupMin,
    laserRate,
    bendingRate,
    weldingRate,
    packingRate,
    weldLengthMm,
  } = params;

  const effectiveQty = Math.max(moq, 1);
  const mat = MATERIALS[materialKey] ?? MATERIALS["Mild Steel"];
  const sheet = STANDARD_SHEETS[sheetIndex] ?? STANDARD_SHEETS[0];
  const thickness = thicknessOverrideMm ?? analysis.thickness_mm;
  const blankW = analysis.flat_blank_w_mm > 0 ? analysis.flat_blank_w_mm : analysis.bbox_mm[0];
  const blankH = analysis.flat_blank_h_mm > 0 ? analysis.flat_blank_h_mm : analysis.bbox_mm[1];

  // ── Sheet yield ───────────────────────────────────────────
  const partsPerRow = Math.max(1, Math.floor(sheet.w / blankW));
  const partsPerCol = Math.max(1, Math.floor(sheet.h / blankH));
  const partsPerSheet = partsPerRow * partsPerCol;
  const sheetsNeeded = Math.ceil(effectiveQty / partsPerSheet);

  // ── Material ──────────────────────────────────────────────
  // volume mm³ → m³ × density → kg
  const blankMassKg = ((blankW * blankH * thickness) / 1e9) * mat.density;
  const materialUnit = sheetCost / partsPerSheet;

  // ── Laser / Turret ────────────────────────────────────────
  const laserRunMin = analysis.cut_perimeter_mm / mat.laserSpeedMmPerMin;
  const laserAutoPcsPerHour = laserRunMin > 0 ? 60 / laserRunMin : 0;
  const laserPcsPerHour = params.laserPcsPerHour > 0 ? params.laserPcsPerHour : laserAutoPcsPerHour;

  // ── CNC Bending ───────────────────────────────────────────
  const bendRunMin = (analysis.bend_count * RATES.secPerBend) / 60;
  const bendingAutoPcsPerHour = bendRunMin > 0 ? 60 / bendRunMin : 0;
  const bendingPcsPerHour =
    params.bendingPcsPerHour > 0 ? params.bendingPcsPerHour : bendingAutoPcsPerHour;

  // ── Welding ───────────────────────────────────────────────
  const weldRunMin = weldLengthMm / RATES.weldSpeedMmPerMin;
  const weldingAutoPcsPerHour = weldRunMin > 0 ? 60 / weldRunMin : 0;
  const weldingPcsPerHour =
    params.weldingPcsPerHour > 0 ? params.weldingPcsPerHour : weldingAutoPcsPerHour;

  const processUnit = (
    active: boolean,
    ratePerHour: number,
    pcsPerHour: number,
    setupMin: number,
  ) => {
    if (!active || pcsPerHour <= 0) return 0;
    const runUnit = ratePerHour / pcsPerHour;
    const setupUnit = (setupMin / 60) * ratePerHour / effectiveQty;
    return runUnit + setupUnit;
  };

  const cuttingUnit = processUnit(processes.laser, laserRate, laserPcsPerHour, laserSetupMin);
  const bendingUnit = processUnit(
    processes.bending && analysis.bend_count > 0,
    bendingRate,
    bendingPcsPerHour,
    bendingSetupMin,
  );
  const weldingUnit = processUnit(processes.welding, weldingRate, weldingPcsPerHour, weldingSetupMin);
  const finishingUnit = processes.finishing ? Math.max(0, params.finishingCost) : 0;
  const packingUnit = processUnit(
    processes.packing,
    packingRate,
    params.packingPcsPerHour,
    packingSetupMin,
  );

  const totalUnit = materialUnit + cuttingUnit + bendingUnit + weldingUnit + finishingUnit + packingUnit;

  return {
    materialUnit,
    cuttingUnit,
    bendingUnit,
    weldingUnit,
    finishingUnit,
    packingUnit,
    totalUnit,
    totalAll: totalUnit * effectiveQty,
    sheetsNeeded,
    partsPerSheet,
    blankMassKg,
    laserPcsPerHour,
    bendingPcsPerHour,
    weldingPcsPerHour,
    finishingPcsPerHour: 0,
    packingPcsPerHour: params.packingPcsPerHour,
  };
}
