export type BomStage = {
  code: string;
  label: string;
};

export type BomTreeRow = {
  id: string;
  depth: number;
  itemNumber: string;
  description: string;
  kind: "fg" | "process" | "material";
};

export type BomFlowNode = {
  id: string;
  itemNumber: string;
  description: string;
  kind: "fg" | "process" | "material";
};

type BomInput = {
  partNumber: string;
  description: string;
  materialNumber: string;
  materialDescription: string;
  stages: BomStage[];
};

// Minimal shape needed to derive stages (mirrors ProcessDef without import cycle)
interface ProcessStageInput {
  key: string;
  label: string;
  phase: string;
  enabled: boolean;
  mlbProcLabel: string;
}

function normalizeItem(value: string, fallback: string) {
  const cleaned = value.trim().toUpperCase();
  return cleaned || fallback;
}

function normalizeCode(value: string, fallback: string) {
  const cleaned = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned || fallback;
}

function normalizeLabel(value: string, fallback: string) {
  const cleaned = value.trim().toUpperCase();
  return cleaned || fallback;
}

// Build process stages for a component subtree from a list of enabled component-phase processes.
// Array order = manufacturing order (first applied → last applied). Inner BOM levels = first applied.
export function buildProcessStages(processes: ProcessStageInput[]): BomStage[] {
  return processes
    .filter(p => p.enabled && p.phase === 'component')
    .map(p => ({
      code: normalizeCode(p.mlbProcLabel || p.key, p.key.slice(0, 1).toUpperCase() || "P"),
      label: normalizeLabel(p.mlbProcLabel || p.label, p.label.toUpperCase()),
    }));
}

export function buildBomTree({
  partNumber,
  description,
  materialNumber,
  materialDescription,
  stages,
}: BomInput): BomTreeRow[] {
  const fgPartNumber = normalizeItem(partNumber, "PART-001");
  const fgDescription = normalizeLabel(description, "DESCRIPTION");
  const rawMaterialNumber = normalizeItem(materialNumber, "MAT-001");
  const rawMaterialDescription = normalizeLabel(materialDescription, "MATERIAL");

  const rows: BomTreeRow[] = [
    {
      id: "fg",
      depth: 0,
      itemNumber: fgPartNumber,
      description: fgDescription,
      kind: "fg",
    },
  ];

  let suffix = "";
  const reversedStages = [...stages].reverse();
  for (let index = 0; index < reversedStages.length; index += 1) {
    const stage = reversedStages[index];
    suffix = `${stage.code}${suffix}`;
    rows.push({
      id: `stage-${stage.code}`,
      depth: index + 1,
      itemNumber: `${fgPartNumber}${suffix}`,
      description: `${fgDescription} (${stage.label})`,
      kind: "process",
    });
  }

  rows.push({
    id: "material",
    depth: rows.length,
    itemNumber: rawMaterialNumber,
    description: rawMaterialDescription,
    kind: "material",
  });

  return rows;
}

export function buildBomFlow(input: BomInput): BomFlowNode[] {
  const rows = buildBomTree(input);
  const material = rows.at(-1);
  if (!material) {
    return [];
  }

  return [
    {
      id: material.id,
      itemNumber: material.itemNumber,
      description: material.description,
      kind: material.kind,
    },
    ...rows
      .slice(1, -1)
      .reverse()
      .map((row) => ({
        id: row.id,
        itemNumber: row.itemNumber,
        description: row.description,
        kind: row.kind,
      })),
    {
      id: rows[0].id,
      itemNumber: rows[0].itemNumber,
      description: rows[0].description,
      kind: rows[0].kind,
    },
  ];
}

function escapeMermaid(value: string) {
  return value.replace(/"/g, '\\"');
}

export function buildMermaidFlow(nodes: BomFlowNode[]) {
  const lines = ["flowchart TD"];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    lines.push(
      `    N${index}["${escapeMermaid(node.itemNumber)}<br/>${escapeMermaid(node.description)}"]`,
    );
  }
  for (let index = 0; index < nodes.length - 1; index += 1) {
    lines.push(`    N${index} --> N${index + 1}`);
  }
  return lines.join("\n");
}

// ── MLB-based Mermaid generator ───────────────────────────────────────────────
// Accepts the flat BomRow array from MlbSection. Edges: child (high lvl) → parent (low lvl).
// Shapes: rect for RAW / FG / component-header (proc=''), rounded for process ops.

interface _MlbRow {
  p: string;
  d: string;
  proc: string;
  lvl: number;
}

export function buildMermaidFromMlb(rows: _MlbRow[]): string {
  if (rows.length === 0) return "";

  const esc = (s: string) =>
    s.replace(/"/g, "#quot;").replace(/\[/g, "#91;").replace(/\]/g, "#93;");

  const nid = (i: number) => `N${i}`;

  const decl = (row: _MlbRow, i: number): string => {
    const label = esc(`${row.lvl}: ${row.d || row.p}`);
    const rect = row.proc === "RAW" || row.proc === "FG" || row.proc === "";
    return rect ? `${nid(i)}["${label}"]` : `${nid(i)}("${label}")`;
  };

  // nearest preceding row whose lvl === current.lvl - 1
  const parentOf = (i: number): number => {
    const lvl = rows[i].lvl;
    for (let j = i - 1; j >= 0; j--) {
      if (rows[j].lvl === lvl - 1) return j;
    }
    return -1;
  };

  const lines = ["graph TD"];
  rows.forEach((row, i) => lines.push(`    ${decl(row, i)}`));
  lines.push("");
  rows.forEach((row, i) => {
    if (row.lvl === 0) return;
    const pi = parentOf(i);
    if (pi >= 0) lines.push(`    ${nid(i)} --> ${nid(pi)}`);
  });

  return lines.join("\n");
}
