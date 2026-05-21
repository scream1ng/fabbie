import type { BomRow } from '../components/MlbSection';

export interface ApiCompWithGeom {
  part_number: string;
  description: string;
  type: 'sheet_metal' | 'purchase' | 'assembly';
  level: number;
  is_assembly: boolean;
  bend_count?: number;
  cut_perimeter_mm?: number;
  flat_area_mm2?: number;
  flat_blank_w_mm?: number;
  flat_blank_h_mm?: number;
  thickness_mm?: number;
}

export function initMlbRows(components: ApiCompWithGeom[]): BomRow[] {
  const root = components.find(c => c.level === 0);
  const sheetMetal = components.filter(c => c.type === 'sheet_metal' && c.level > 0);
  const purchased = components.filter(c => c.type === 'purchase' && c.level > 0);
  const multiComp = sheetMetal.length > 1;
  const rows: BomRow[] = [];

  if (root) {
    rows.push({ p: root.part_number, d: root.description?.trim() || root.part_number, proc: 'FG', qty: '1', lvl: 0 });
  }

  if (multiComp) {
    rows.push({ p: 'WELD', d: 'Weld', proc: 'WELD', qty: '1', lvl: 1, setup_min: 15, pcs_per_hour: 60, rate_per_hour: 95 });
  }
  rows.push({ p: 'ECOAT', d: 'E-Coat', proc: 'ECOAT', qty: '1', lvl: 1, rate_per_hour: 0 });

  for (const comp of sheetMetal) {
    const label = comp.description?.trim() || comp.part_number;
    rows.push({ p: comp.part_number, d: label, proc: '', qty: '1', lvl: 1 });

    const hasBend  = (comp.bend_count ?? 0) > 0;
    const hasLaser = (comp.cut_perimeter_mm ?? 0) > 0;
    const hasMat   = (comp.flat_blank_w_mm ?? 0) > 0 && (comp.flat_blank_h_mm ?? 0) > 0;

    // Each op nests under the previous: comp → bend → laser → mat
    let opLvl = 2;

    if (hasBend) {
      const pph = Math.round(3600 / (comp.bend_count! * 15));
      rows.push({ p: `${comp.part_number}B`, d: 'Bending', proc: 'BEND', qty: '1', lvl: opLvl, setup_min: 15, pcs_per_hour: pph, rate_per_hour: 110 });
      opLvl++;
    }
    if (hasLaser) {
      const perimM = comp.cut_perimeter_mm! / 1000;
      const pph = perimM > 0 ? Math.round((1 / (perimM / 3000)) * 60) : undefined;
      const laserPart = hasBend ? `${comp.part_number}LB` : `${comp.part_number}L`;
      rows.push({ p: laserPart, d: 'Laser Cutting', proc: 'LASER', qty: '1', lvl: opLvl, setup_min: 15, pcs_per_hour: pph, rate_per_hour: 150 });
      opLvl++;
    }
    if (hasMat) {
      const sheetW = 2440, sheetH = 1220;
      const pps = Math.max(1, Math.floor(sheetW / comp.flat_blank_w_mm!) * Math.floor(sheetH / comp.flat_blank_h_mm!));
      const t = comp.thickness_mm ?? 2.0;
      rows.push({ p: `MAT_${comp.part_number}`, d: `${t}mm HA3P ${sheetW}×${sheetH} SHT`, proc: 'MAT', qty: String(pps), qty_type: 'amortise', unit_cost: '80', lvl: opLvl });
    }
  }

  for (const comp of purchased) {
    const label = comp.description?.trim() || comp.part_number;
    rows.push({ p: comp.part_number, d: label, proc: 'RAW', qty: '1', qty_type: 'use', unit_cost: '0', lvl: 1 });
  }

  return rows;
}
