// AUD sheet-metal fabrication cost engine — hardcoded defaults

export interface PartAnalysis {
  bbox_mm: [number, number, number]; // [W, H, T] sorted largest→smallest
  thickness_mm: number;
  cut_perimeter_mm: number;
  hole_count: number;
  bend_count: number;
  flat_area_mm2: number;
}

export interface Material {
  label: string;
  density: number; // kg/m³
  pricePerKg: number; // AUD
  laserSpeedMmPerMin: number;
}

export const MATERIALS: Record<string, Material> = {
  "Mild Steel": {
    label: "Mild Steel",
    density: 7850,
    pricePerKg: 2.2,
    laserSpeedMmPerMin: 3000,
  },
  SS304: {
    label: "SS304",
    density: 8000,
    pricePerKg: 5.8,
    laserSpeedMmPerMin: 2000,
  },
  "Aluminium 5052": {
    label: "Aluminium 5052",
    density: 2680,
    pricePerKg: 7.5,
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
  timePerBendMin: 1.5,
  weldSpeedMmPerMin: 250,
} as const;

export const DEFAULT_SETUP_MIN = 15;

export interface CostParams {
  qty: number;
  moq: number;
  materialKey: string;
  thicknessOverrideMm: number | null;
  sheetIndex: number;
  processes: {
    laser: boolean;
    bending: boolean;
    welding: boolean;
  };
  setupMin: number;
  weldLengthMm: number;
}

export interface CostBreakdown {
  materialUnit: number;
  cuttingUnit: number;
  bendingUnit: number;
  weldingUnit: number;
  totalUnit: number;
  totalAll: number;
  sheetsNeeded: number;
  partsPerSheet: number;
  blankMassKg: number;
}

export function calculateCost(
  analysis: PartAnalysis,
  params: CostParams,
): CostBreakdown {
  const {
    qty,
    moq,
    materialKey,
    thicknessOverrideMm,
    sheetIndex,
    processes,
    setupMin,
    weldLengthMm,
  } = params;

  const effectiveQty = Math.max(qty, moq, 1);
  const setupHr = setupMin / 60;
  const mat = MATERIALS[materialKey] ?? MATERIALS["Mild Steel"];
  const sheet = STANDARD_SHEETS[sheetIndex] ?? STANDARD_SHEETS[0];
  const thickness = thicknessOverrideMm ?? analysis.thickness_mm;
  const [blankW, blankH] = analysis.bbox_mm;

  // ── Sheet yield ───────────────────────────────────────────
  const partsPerRow = Math.max(1, Math.floor(sheet.w / blankW));
  const partsPerCol = Math.max(1, Math.floor(sheet.h / blankH));
  const partsPerSheet = partsPerRow * partsPerCol;
  const sheetsNeeded = Math.ceil(effectiveQty / partsPerSheet);

  // ── Material ──────────────────────────────────────────────
  // volume mm³ → m³ × density → kg
  const blankMassKg = ((blankW * blankH * thickness) / 1e9) * mat.density;
  const materialUnit = blankMassKg * mat.pricePerKg;

  // ── Laser / Turret ────────────────────────────────────────
  let cuttingUnit = 0;
  if (processes.laser) {
    const cutTimeHr =
      analysis.cut_perimeter_mm / mat.laserSpeedMmPerMin / 60;
    const setupAmortised = (setupHr * RATES.laser) / effectiveQty;
    cuttingUnit = cutTimeHr * RATES.laser + setupAmortised;
  }

  // ── CNC Bending ───────────────────────────────────────────
  let bendingUnit = 0;
  if (processes.bending && analysis.bend_count > 0) {
    const bendTimeHr = (analysis.bend_count * RATES.timePerBendMin) / 60;
    const setupAmortised = (setupHr * RATES.bending) / effectiveQty;
    bendingUnit = bendTimeHr * RATES.bending + setupAmortised;
  }

  // ── Welding ───────────────────────────────────────────────
  let weldingUnit = 0;
  if (processes.welding && weldLengthMm > 0) {
    const weldTimeHr = weldLengthMm / RATES.weldSpeedMmPerMin / 60;
    const setupAmortised = (setupHr * RATES.welding) / effectiveQty;
    weldingUnit = weldTimeHr * RATES.welding + setupAmortised;
  }

  const totalUnit = materialUnit + cuttingUnit + bendingUnit + weldingUnit;

  return {
    materialUnit,
    cuttingUnit,
    bendingUnit,
    weldingUnit,
    totalUnit,
    totalAll: totalUnit * Math.max(qty, 1),
    sheetsNeeded,
    partsPerSheet,
    blankMassKg,
  };
}
