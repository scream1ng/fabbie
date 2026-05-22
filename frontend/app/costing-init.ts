import type { BomRow } from '../components/MlbSection';

export interface ApiCompWithGeom {
  part_number: string;
  description: string;
  type: 'sheet_metal' | 'purchase' | 'assembly';
  level: number;
  is_assembly: boolean;
  qty?: number;
  bend_count?: number;
  cut_perimeter_mm?: number;
  flat_area_mm2?: number;
  flat_blank_w_mm?: number;
  flat_blank_h_mm?: number;
  thickness_mm?: number;
}

const PART_ROUTING_OVERRIDES: Record<string, { bendPart?: string; laserPart?: string }> = {
  '202676': { bendPart: '202676GB', laserPart: '202676LB' },
};

function cleanLabel(comp: ApiCompWithGeom): string {
  return comp.description?.trim() || comp.part_number;
}

function positiveQty(value: number | undefined): string {
  return String(Math.max(1, Math.round(value ?? 1)));
}

function bendPartFor(partNumber: string): string {
  return PART_ROUTING_OVERRIDES[partNumber]?.bendPart ?? `${partNumber}B`;
}

function laserPartFor(partNumber: string): string {
  return PART_ROUTING_OVERRIDES[partNumber]?.laserPart ?? `${partNumber}LB`;
}

function procRate(comp: ApiCompWithGeom, proc: 'BEND' | 'LASER'): number | undefined {
  if (proc === 'BEND') {
    const bends = comp.bend_count ?? 0;
    return bends > 0 ? Math.round(3600 / (bends * 15)) : undefined;
  }
  const perimM = (comp.cut_perimeter_mm ?? 0) / 1000;
  return perimM > 0 ? Math.round((1 / (perimM / 3000)) * 60) : undefined;
}

function materialDescription(comp: ApiCompWithGeom): string {
  return `Material for ${comp.part_number}`;
}

export function initMlbRows(components: ApiCompWithGeom[]): BomRow[] {
  const root = components.find(c => c.level === 0);
  const sheetMetal = components.filter(c => c.type === 'sheet_metal' && c.level > 0);
  const purchased = components.filter(c => c.type === 'purchase' && c.level > 0);
  const rows: BomRow[] = [];

  if (!root) {
    return rows;
  }

  const rootLabel = cleanLabel(root);
  rows.push({ p: root.part_number, d: rootLabel, proc: 'FG', qty: '1', lvl: 0 });

  if (!root.is_assembly) {
    rows.push({ p: bendPartFor(root.part_number), d: `${root.part_number} (BEND)`, proc: 'BEND', qty: '1', lvl: 1, setup_min: 15, pcs_per_hour: procRate(root, 'BEND'), rate_per_hour: 110 });
    rows.push({ p: laserPartFor(root.part_number), d: `${root.part_number} (LASER BLANK)`, proc: 'LASER', qty: '1', lvl: 2, setup_min: 15, pcs_per_hour: procRate(root, 'LASER'), rate_per_hour: 150 });
    rows.push({ p: `MAT-${root.part_number}`, d: materialDescription(root), proc: 'RAW', qty: '1', qty_type: 'use', unit_cost: '0', lvl: 3 });
    return rows;
  }

  rows.push({ p: `${root.part_number}E`, d: `${root.part_number} (E-COAT)`, proc: 'ECOAT', qty: '1', lvl: 1, unit_cost: '0', qty_type: 'use' });
  rows.push({ p: `${root.part_number}WE`, d: `${root.part_number} (WELD)`, proc: 'WELD', qty: '1', lvl: 2, setup_min: 15, pcs_per_hour: 60, rate_per_hour: 95 });

  for (const comp of sheetMetal) {
    rows.push({ p: bendPartFor(comp.part_number), d: `${comp.part_number} (BEND)`, proc: 'BEND', qty: positiveQty(comp.qty), lvl: 3, setup_min: 15, pcs_per_hour: procRate(comp, 'BEND'), rate_per_hour: 110 });
    rows.push({ p: laserPartFor(comp.part_number), d: `${comp.part_number} (LASER BLANK)`, proc: 'LASER', qty: '1', lvl: 4, setup_min: 15, pcs_per_hour: procRate(comp, 'LASER'), rate_per_hour: 150 });
    rows.push({ p: `MAT-${comp.part_number}`, d: materialDescription(comp), proc: 'RAW', qty: '1', qty_type: 'use', unit_cost: '0', lvl: 5 });
  }

  for (const comp of purchased) {
    const label = cleanLabel(comp);
    rows.push({ p: comp.part_number, d: label, proc: 'RAW', qty: positiveQty(comp.qty), qty_type: 'use', unit_cost: '0', lvl: 3 });
  }

  return rows;
}
