"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type {
  CostConfig,
} from "./costing";
import {
  DEFAULT_COST_CONFIG,
} from "./costing";
import {
  type BomTreeRow,
  buildBomTree,
  buildProcessStages,
} from "./bom";
import MlbSection, { type BomRow } from "../components/MlbSection";
import PfcDiagram from "../components/PfcDiagram";
import TopBar, { type RightTab } from "../components/TopBar";
import LeftPanel from "../components/LeftPanel";
import DataTab from "../components/DataTab";
import { initMlbRows, type ApiCompWithGeom } from "./costing-init";

type Status = "idle" | "loading" | "viewing" | "exporting" | "error";

type ApiComp = ApiCompWithGeom;

function compLabel(comp: ApiComp): string {
  const desc = comp.description.trim();
  if (desc) return desc.slice(0, 28);
  const m = comp.part_number.match(/_\d+-([\w\s\-]+?)(?:\s+_|$)/);
  if (m) return m[1].trim().slice(0, 28);
  return comp.part_number.slice(0, 28);
}


const MAX_EXPORT_PX = 4096;
const MAX_VIEWER_SEGMENTS = 60000;
const EXPORT_SUPERSAMPLE = 4;

function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [linePx, setLinePx] = useState(3);
  const [partName, setPartName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [exportCm, setExportCm] = useState(2.6);
  const [exportDpi, setExportDpi] = useState(300);
  const [bomPartNumber, setBomPartNumber] = useState("");
  const [bomDescription, setBomDescription] = useState("");
  const [materialNumber, setMaterialNumber] = useState("MAT-001");
  const [materialDescription, setMaterialDescription] = useState("MILD STEEL");
  const [mlbRows, setMlbRows] = useState<BomRow[]>(() => {
    try { const s = localStorage.getItem('fabbie_mlb'); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [moq, setMoq] = useState<number>(() => {
    try { const s = localStorage.getItem('fabbie_moq'); return s ? Number(s) : 400; } catch { return 400; }
  });
  const [isAssembly, setIsAssembly] = useState(false);
  const [assemblyApiComps, setAssemblyApiComps] = useState<ApiComp[]>([]);
  const [rightTab, setRightTab] = useState<RightTab>('MLB');
  const [costConfig, setCostConfig] = useState<CostConfig>(DEFAULT_COST_CONFIG);
  const sheetMetalComps = useMemo(
    () => assemblyApiComps.filter(c => c.type === 'sheet_metal'),
    [assemblyApiComps],
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

  useEffect(() => { localStorage.setItem('fabbie_mlb', JSON.stringify(mlbRows)); }, [mlbRows]);
  useEffect(() => { localStorage.setItem('fabbie_moq', String(moq)); }, [moq]);

  useEffect(() => {
    if (!isAssembly || assemblyApiComps.length === 0) return;
    // Only auto-init if MLB is empty (preserves manual edits on re-upload)
    setMlbRows(prev => prev.length > 0 ? prev : initMlbRows(assemblyApiComps));
  }, [isAssembly, assemblyApiComps]);

  const loadMesh = useCallback(
    async (nextFile: File) => {
      const id = ++loadIdRef.current;
      setStatus("loading");
      setErrorMsg("");

      const form = new FormData();
      form.append("file", nextFile);

      try {
        const res = await fetch("/api/full-process", { method: "POST", body: form });
        
        if (id !== loadIdRef.current) return;
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        const data = await res.json();
        if (id !== loadIdRef.current) return;

        if (data.is_assembly && Array.isArray(data.components) && data.components.length > 0) {
          const comps: ApiComp[] = data.components;
          setIsAssembly(true);
          setAssemblyApiComps(comps);
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
    setBomPartNumber("");
    setBomDescription("");
    setMaterialNumber("MAT-001");
    setMaterialDescription("MILD STEEL");
    setIsAssembly(false);
    setAssemblyApiComps([]);
    setMlbRows([]);
    setMoq(400);
    localStorage.removeItem('fabbie_mlb');
    localStorage.removeItem('fabbie_moq');
    setRightTab('MLB');
    setCostConfig(DEFAULT_COST_CONFIG);
  };

  /* ── Full-page drop zone shown when idle ── */
  if (status === 'idle') {
    return (
      <div
        className="h-full flex flex-col items-center justify-center gap-4"
        style={{ background: '#f0ece5', fontFamily: "'IBM Plex Mono', monospace" }}
        onDrop={onDrop}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
      >
        <div
          onClick={() => inputRef.current?.click()}
          className={[
            'flex flex-col items-center justify-center gap-4 cursor-pointer rounded-lg border-2 border-dashed transition-colors',
            dragging ? 'border-[#1c1814] bg-[#e6e1d8]' : 'border-[#cec8be] hover:border-[#aca49a]',
          ].join(' ')}
          style={{ width: 340, height: 240 }}
        >
          <svg className="w-12 h-12 text-[#aca49a]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2}
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
          </svg>
          <div className="text-center">
            <div className="text-[13px] text-[#1c1814]">Drop .step / .stp here</div>
            <div className="text-[11px] text-[#7a7060] mt-1">or click to browse</div>
          </div>
        </div>
        {errorMsg && <p className="text-[11px] text-red-500">{errorMsg}</p>}
        <input
          ref={inputRef}
          type="file"
          accept=".step,.stp"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) accept(f); e.target.value = ''; }}
        />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: '#f0ece5' }}>
    <div className="flex-1 flex flex-col min-h-0 max-w-[1440px] w-full mx-auto overflow-hidden">
      {/* ── Top bar ── */}
      <TopBar
        activeTab={rightTab}
        onTabChange={setRightTab}
        onNew={reset}
      />

      {/* ── Body: left panel + right panel ── */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left: 3D viewer + controls */}
        <LeftPanel
          mountRef={mountRef}
          status={status}
          errorMsg={errorMsg}
          linePx={linePx}
          onLinePxChange={setLinePx}
          partName={partName}
          onPartNameChange={setPartName}
          exportSizeMm={Math.round(exportCm * 10)}
          onExportSizeMmChange={(v) => setExportCm(v / 10)}
          exportDpi={exportDpi}
          onExportDpiChange={setExportDpi}
          onExport={exportJpg}
          onNew={reset}
          inputRef={inputRef}
          onFileChange={accept}
          dragging={dragging}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        />

        {/* Right: tabbed content */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          {rightTab === 'MLB' && (
            <div className="h-full overflow-y-auto p-4" style={{ background: '#f8f5f0' }}>
              <MlbSection rows={mlbRows} onRowsChange={setMlbRows} moq={moq} onMoqChange={setMoq} />
            </div>
          )}

          {rightTab === 'PFC' && (
            <div className="h-full overflow-hidden flex flex-col" style={{ background: '#f8f5f0' }}>
              <div className="px-4 py-3 border-b border-[#cec8be] flex-shrink-0">
                <div className="text-[9px] font-mono uppercase tracking-wider text-[#7a7060]">PFC — Process Flow Chart</div>
                <div className="mt-1 text-[11px] font-mono text-[#aca49a]">Process flow derived from current MLB rows.</div>
              </div>
              <div className="flex-1 min-h-0 p-4 flex flex-col">
                <PfcDiagram rows={mlbRows} isAssembly={isAssembly} />
              </div>
            </div>
          )}

          {rightTab === 'DATA' && <DataTab />}
        </div>
      </div>
    </div>
    </div>
  );
}

export default Home;
