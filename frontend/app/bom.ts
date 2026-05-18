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

type ProcessFlags = {
  laser: boolean;
  bending: boolean;
  welding: boolean;
  finishing: boolean;
};

type BomInput = {
  partNumber: string;
  description: string;
  materialNumber: string;
  materialDescription: string;
  stages: BomStage[];
};

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

export function buildProcessStages(
  processes: ProcessFlags,
  finishCode: string,
  finishLabel: string,
): BomStage[] {
  const stages: BomStage[] = [];

  if (processes.laser) {
    stages.push({ code: "L", label: "LASER" });
  }
  if (processes.bending) {
    stages.push({ code: "B", label: "BEND" });
  }
  if (processes.welding) {
    stages.push({ code: "W", label: "WELD" });
  }
  if (processes.finishing) {
    stages.push({
      code: normalizeCode(finishCode, "F"),
      label: normalizeLabel(finishLabel, "FINISH"),
    });
  }

  return stages;
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
