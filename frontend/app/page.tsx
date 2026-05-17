"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

import type { CostBreakdown, CostParams, PartAnalysis } from "./costing";
import {
  calculateCost,
  DEFAULT_SETUP_MIN,
  MATERIALS,
  STANDARD_SHEETS,
} from "./costing";

type Status = "idle" | "loading" | "viewing" | "exporting" | "error";

function cmDpiToPx(cm: number, dpi: number) {
  return Math.round((cm / 2.54) * dpi);
}

export function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [linePx, setLinePx] = useState(3);
  const [partName, setPartName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [exportCm, setExportCm] = useState(2.6);
  const [exportDpi, setExportDpi] = useState(300);
  const [analysis, setAnalysis] = useState<PartAnalysis | null>(null);
  const [flatSvg, setFlatSvg] = useState<string | null>(null);
  const [flatMeta, setFlatMeta] = useState<{
    thickness_mm: number;
    bends: number;
    blank_w_mm: number;
    blank_h_mm: number;
  } | null>(null);
  const [flatLoading, setFlatLoading] = useState(false);
  const [kFactor, setKFactor] = useState(0.33);
  const [costParams, setCostParams] = useState<CostParams>({
    moq: 1,
    materialKey: "Mild Steel",
    thicknessOverrideMm: null,
    sheetIndex: 0,
    processes: { laser: true, bending: true, welding: false },
    laserSetupMin: DEFAULT_SETUP_MIN,
    bendingSetupMin: DEFAULT_SETUP_MIN,
    weldingSetupMin: DEFAULT_SETUP_MIN,
    weldLengthMm: 0,
  });
  const costBreakdown = useMemo<CostBreakdown | null>(
    () => (analysis ? calculateCost(analysis, costParams) : null),
    [analysis, costParams],
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

  const loadMesh = useCallback(
    async (nextFile: File) => {
      const id = ++loadIdRef.current;
      setStatus("loading");
      setErrorMsg("");
      setAnalysis(null);

      const meshForm = new FormData();
      meshForm.append("file", nextFile);
      const edgesForm = new FormData();
      edgesForm.append("file", nextFile);
      const analyseForm = new FormData();
      analyseForm.append("file", nextFile);

      try {
        const [meshRes, edgesRes, analyseRes] = await Promise.all([
          fetch("/api/mesh", { method: "POST", body: meshForm }),
          fetch("/api/edges", { method: "POST", body: edgesForm }),
          fetch("/api/analyse", { method: "POST", body: analyseForm }),
        ]);
        if (id !== loadIdRef.current) return;
        if (!meshRes.ok) throw new Error(`Mesh: ${meshRes.status}`);
        if (!edgesRes.ok) throw new Error(`Edges: ${edgesRes.status}`);

        const [stlBlob, edgesData, analysisData]: [
          Blob,
          number[][][],
          PartAnalysis | null,
        ] = await Promise.all([
          meshRes.blob(),
          edgesRes.json(),
          analyseRes.ok ? analyseRes.json() : Promise.resolve(null),
        ]);
        if (id !== loadIdRef.current) return;

        if (analysisData) setAnalysis(analysisData);
        cleanup();

        const mount = mountRef.current;
        if (!mount) {
          throw new Error("Viewer mount is not ready");
        }

        const width = mount.clientWidth || 520;
        const height = mount.clientHeight || 520;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(width, height);
        renderer.setClearColor(0xffffff, 1);
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
            }),
          );
          depthMesh.renderOrder = 0;
          scene.add(depthMesh);

          const whiteMesh = new THREE.Mesh(
            geo,
            new THREE.MeshBasicMaterial({
              color: 0xf0f0f0,
              side: THREE.FrontSide,
              depthWrite: false,
              polygonOffset: true,
              polygonOffsetFactor: 1,
              polygonOffsetUnits: 1,
            }),
          );
          whiteMesh.renderOrder = 1;
          scene.add(whiteMesh);

          const positions: number[] = [];
          for (const polyline of edgesData) {
            for (let i = 0; i < polyline.length - 1; i += 1) {
              const [x1, y1, z1] = polyline[i];
              const [x2, y2, z2] = polyline[i + 1];
              positions.push(
                (x1 - center.x) * scale,
                (y1 - center.y) * scale,
                (z1 - center.z) * scale,
                (x2 - center.x) * scale,
                (y2 - center.y) * scale,
                (z2 - center.z) * scale,
              );
            }
          }

          if (positions.length > 0) {
            const lineGeometry = new LineSegmentsGeometry();
            lineGeometry.setPositions(positions);
            const lineMaterial = new LineMaterial({
              color: 0x000000,
              linewidth: linePx,
              worldUnits: false,
              depthTest: true,
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

        setStatus("viewing");
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
      setFile(nextFile);
      setPartName(nextFile.name.replace(/\.[^.]+$/, ""));
      loadMesh(nextFile);
    },
    [loadMesh],
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
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!scene || !camera) return;

    setStatus("exporting");
    setErrorMsg("");

    const px = cmDpiToPx(exportCm, exportDpi);
    const viewportWidth = mountRef.current?.clientWidth ?? 520;
    const viewportHeight = mountRef.current?.clientHeight ?? 520;
    let exportRenderer: THREE.WebGLRenderer | null = null;

    try {
      controlsRef.current?.update();
      camera.updateMatrixWorld(true);

      exportRenderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
      });
      exportRenderer.setPixelRatio(1);
      exportRenderer.setSize(px, px, false);
      exportRenderer.setClearColor(0xffffff, 1);
      exportRenderer.outputColorSpace = THREE.SRGBColorSpace;

      scene.traverse((obj) => {
        if ((obj as { isLineSegments2?: boolean }).isLineSegments2) {
          const material = (obj as LineSegments2).material as LineMaterial;
          material.resolution.set(px, px);
        }
      });

      const exportCamera = camera.clone() as THREE.PerspectiveCamera;
      exportCamera.aspect = 1;
      exportCamera.updateProjectionMatrix();
      exportRenderer.render(scene, exportCamera);

      const dataUrl = exportRenderer.domElement.toDataURL("image/jpeg", 1);
      const name = partName.trim() || file?.name.replace(/\.[^.]+$/, "") || "part";
      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = `${name}_label.jpg`;
      link.click();

      setStatus("viewing");
    } catch (err) {
      setErrorMsg(String(err instanceof Error ? err.message : err));
      setStatus(sceneRef.current ? "viewing" : "error");
    } finally {
      scene.traverse((obj) => {
        if ((obj as { isLineSegments2?: boolean }).isLineSegments2) {
          const material = (obj as LineSegments2).material as LineMaterial;
          material.resolution.set(viewportWidth, viewportHeight);
          material.linewidth = linePx;
        }
      });
      exportRenderer?.dispose();
    }
  }, [exportCm, exportDpi, file, linePx, partName]);

  const fetchFlatPattern = useCallback(async () => {
    if (!file) return;
    setFlatLoading(true);
    setFlatSvg(null);
    setFlatMeta(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`/api/flat-pattern?k_factor=${kFactor}`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error(`Flat pattern: ${res.status}`);
      const metaStr = res.headers.get("X-Flat-Pattern-Meta");
      const meta = metaStr ? JSON.parse(metaStr) : null;
      const svgText = await res.text();
      setFlatMeta(meta);
      setFlatSvg(svgText);
    } catch (err) {
      setErrorMsg(String(err instanceof Error ? err.message : err));
    } finally {
      setFlatLoading(false);
    }
  }, [file, kFactor]);

  const downloadFlatSvg = useCallback(() => {
    if (!flatSvg) return;
    const blob = new Blob([flatSvg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${partName.trim() || "part"}_flat.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }, [flatSvg, partName]);

  const reset = () => {
    cleanup();
    setFile(null);
    setStatus("idle");
    setErrorMsg("");
    setPartName("");
    setAnalysis(null);
    setFlatSvg(null);
    setFlatMeta(null);
  };

  const showDrop = status === "idle" || status === "error";
  const showViewer = status === "viewing" || status === "exporting";

  return (
    <main
      className={[
        "min-h-screen flex flex-col p-6 gap-5",
        showViewer ? "items-start" : "items-center justify-center",
      ].join(" ")}
    >
      <div className={showViewer ? "" : "text-center"}>
        <h1 className="text-2xl font-bold tracking-tight">STEP to Label</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Rotate to pick a view, then export a clean hidden-line JPG.
        </p>
      </div>

      {showDrop && (
        <div
          onClick={() => inputRef.current?.click()}
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          className={[
            "flex h-48 w-80 cursor-pointer select-none flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed transition-colors",
            dragging ? "border-blue-400 bg-blue-950/30" : "border-zinc-700 bg-zinc-900 hover:border-zinc-500",
          ].join(" ")}
        >
          <svg className="h-10 w-10 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
            />
          </svg>
          <span className="text-sm text-zinc-500">Drop .step / .stp or click</span>
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

      {/* Two-column layout: mountRef always in DOM, hidden when not viewing */}
      <div className={`flex gap-6 items-start w-full ${showViewer ? "" : "hidden"}`}>

        {/* ── Left column: viewer + export controls ── */}
        <div className="flex flex-col gap-3 flex-shrink-0" style={{ width: 520 }}>
          <div
            ref={mountRef}
            className="overflow-hidden rounded-xl border border-zinc-700 bg-white"
            style={{ width: 520, height: 520 }}
          />

          {showViewer && (
            <>
              <p className="text-xs text-zinc-500">
                Left drag to rotate · Right drag to pan · Scroll to zoom
              </p>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-zinc-500">Part name</label>
                <input
                  type="text"
                  value={partName}
                  onChange={(e) => setPartName(e.target.value)}
                  placeholder="e.g. BRACKET-001"
                  className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-mono text-zinc-200 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <label className="flex items-center gap-3 text-sm text-zinc-400">
                Line thickness
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={linePx}
                  onChange={(e) => setLinePx(Number(e.target.value))}
                  className="w-28 accent-blue-500"
                />
                <span className="w-4 text-zinc-200">{linePx}</span>
              </label>

              <div className="flex gap-3">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-zinc-500">Export size (mm)</label>
                  <input
                    type="number"
                    min={5}
                    max={1000}
                    value={Math.round(exportCm * 10)}
                    onChange={(e) => setExportCm(Number(e.target.value) / 10)}
                    className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-mono text-zinc-200"
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
                    className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-mono text-zinc-200"
                  />
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={exportJpg}
                  disabled={status === "exporting"}
                  className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium transition-colors hover:bg-blue-500 disabled:opacity-50"
                >
                  {status === "exporting"
                    ? "Generating..."
                    : `Export JPG (${Math.round(exportCm * 10)}×${Math.round(exportCm * 10)} mm @ ${exportDpi} dpi)`}
                </button>
                <button
                  onClick={reset}
                  className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700"
                >
                  Load new file
                </button>
              </div>

              <div className="flex items-end gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-zinc-500">K-factor</label>
                  <input
                    type="number"
                    min={0}
                    max={0.5}
                    step={0.01}
                    value={kFactor}
                    onChange={(e) => setKFactor(Number(e.target.value))}
                    className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-mono text-zinc-200"
                  />
                </div>
                <button
                  onClick={fetchFlatPattern}
                  disabled={flatLoading}
                  className="rounded-lg bg-emerald-700 px-5 py-2 text-sm font-medium transition-colors hover:bg-emerald-600 disabled:opacity-50"
                >
                  {flatLoading ? "Unfolding..." : "Flat Pattern"}
                </button>
                {flatSvg && (
                  <button
                    onClick={downloadFlatSvg}
                    className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700"
                  >
                    Download SVG
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── Right column: cost panel ── */}
        {showViewer && analysis && costBreakdown && (
          <div className="flex-1 min-w-[300px] max-w-sm rounded-xl border border-zinc-700 p-4 flex flex-col gap-4">
            <h2 className="text-sm font-semibold text-zinc-200">Cost Estimate (AUD)</h2>

            <div className="rounded-lg bg-zinc-900 p-3 text-xs text-zinc-400 flex flex-col gap-1">
              <div>
                <span className="text-zinc-500">Flat Blank: </span>
                {analysis.bbox_mm[0]} × {analysis.bbox_mm[1]} mm ·{" "}
                <span className="text-zinc-500">t </span>
                {analysis.thickness_mm} mm
              </div>
              <div className="flex gap-3">
                <span>{analysis.bend_count} bend{analysis.bend_count !== 1 ? "s" : ""}</span>
                <span>·</span>
                <span>{analysis.hole_count} hole{analysis.hole_count !== 1 ? "s" : ""}</span>
                <span>·</span>
                <span>{(analysis.cut_perimeter_mm / 1000).toFixed(2)} m cut</span>
              </div>
              {analysis.flat_pattern_area_mm2 > 0 && (
                <div>
                  <span className="text-zinc-500">Flat Area: </span>
                  {analysis.flat_pattern_area_mm2.toFixed(0)} mm²
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-zinc-500">MOQ</label>
                <input
                  type="number"
                  min={1}
                  value={costParams.moq}
                  onChange={(e) =>
                    setCostParams((p) => ({ ...p, moq: Math.max(1, Number(e.target.value)) }))
                  }
                  className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-mono text-zinc-200"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-zinc-500">Material</label>
                <select
                  value={costParams.materialKey}
                  onChange={(e) => setCostParams((p) => ({ ...p, materialKey: e.target.value }))}
                  className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
                >
                  {Object.keys(MATERIALS).map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-zinc-500">Thickness (mm)</label>
                <input
                  type="number"
                  min={0.5}
                  step={0.1}
                  value={costParams.thicknessOverrideMm ?? analysis.thickness_mm}
                  onChange={(e) =>
                    setCostParams((p) => ({
                      ...p,
                      thicknessOverrideMm: Number(e.target.value),
                    }))
                  }
                  className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-mono text-zinc-200"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-zinc-500">Sheet size</label>
                <select
                  value={costParams.sheetIndex}
                  onChange={(e) =>
                    setCostParams((p) => ({ ...p, sheetIndex: Number(e.target.value) }))
                  }
                  className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
                >
                  {STANDARD_SHEETS.map((s, i) => (
                    <option key={i} value={i}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Process toggles with per-process setup time */}
            <div className="flex flex-col gap-2">
              {(
                [
                  ["laser", "Laser / Turret", "laserSetupMin"],
                  ["bending", "CNC Bend", "bendingSetupMin"],
                  ["welding", "Welding", "weldingSetupMin"],
                ] as const
              ).map(([key, label, setupKey]) => (
                <div key={key} className="flex items-center gap-2">
                  <label className="flex w-32 cursor-pointer items-center gap-2 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={costParams.processes[key]}
                      onChange={(e) =>
                        setCostParams((p) => ({
                          ...p,
                          processes: { ...p.processes, [key]: e.target.checked },
                        }))
                      }
                      className="accent-blue-500"
                    />
                    {label}
                  </label>
                  {costParams.processes[key] && (
                    <>
                      <span className="text-xs text-zinc-500">setup</span>
                      <input
                        type="number"
                        min={0}
                        value={costParams[setupKey]}
                        onChange={(e) =>
                          setCostParams((p) => ({
                            ...p,
                            [setupKey]: Math.max(0, Number(e.target.value)),
                          }))
                        }
                        className="w-14 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs font-mono text-zinc-200"
                      />
                      <span className="text-xs text-zinc-500">min</span>
                    </>
                  )}
                </div>
              ))}
            </div>

            {costParams.processes.welding && (
              <div className="flex flex-col gap-1">
                <label className="text-xs text-zinc-500">Weld length (mm)</label>
                <input
                  type="number"
                  min={0}
                  value={costParams.weldLengthMm}
                  onChange={(e) =>
                    setCostParams((p) => ({
                      ...p,
                      weldLengthMm: Math.max(0, Number(e.target.value)),
                    }))
                  }
                  className="w-36 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-mono text-zinc-200"
                />
              </div>
            )}

            <div className="overflow-hidden rounded-lg bg-zinc-900">
              <table className="w-full text-sm">
                <tbody>
                  <tr className="border-b border-zinc-800">
                    <td className="px-3 py-2 text-zinc-400">Material</td>
                    <td className="px-3 py-2 text-right font-mono text-zinc-200">
                      ${costBreakdown.materialUnit.toFixed(2)}
                      <span className="ml-1 text-xs text-zinc-500">
                        ({costBreakdown.blankMassKg.toFixed(3)} kg)
                      </span>
                    </td>
                  </tr>
                  {costParams.processes.laser && (
                    <tr className="border-b border-zinc-800">
                      <td className="px-3 py-2 text-zinc-400">Laser / Turret</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-200">
                        ${costBreakdown.cuttingUnit.toFixed(2)}
                      </td>
                    </tr>
                  )}
                  {costParams.processes.bending && analysis.bend_count > 0 && (
                    <tr className="border-b border-zinc-800">
                      <td className="px-3 py-2 text-zinc-400">
                        CNC Bending ({analysis.bend_count} bend{analysis.bend_count !== 1 ? "s" : ""})
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-200">
                        ${costBreakdown.bendingUnit.toFixed(2)}
                      </td>
                    </tr>
                  )}
                  {costParams.processes.welding && (
                    <tr className="border-b border-zinc-800">
                      <td className="px-3 py-2 text-zinc-400">Welding</td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-200">
                        ${costBreakdown.weldingUnit.toFixed(2)}
                      </td>
                    </tr>
                  )}
                  <tr className="border-b border-zinc-700 bg-zinc-800/60">
                    <td className="px-3 py-2 font-medium text-zinc-200">Total / unit</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-white">
                      ${costBreakdown.totalUnit.toFixed(2)}
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 text-zinc-400">
                      Total × {costParams.moq} MOQ
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-blue-400">
                      ${costBreakdown.totalAll.toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">
                Sheet yield: {costBreakdown.partsPerSheet} parts/sheet ·{" "}
                {costBreakdown.sheetsNeeded} sheet{costBreakdown.sheetsNeeded !== 1 ? "s" : ""} for {costParams.moq} pcs
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Flat pattern panel */}
      {showViewer && (flatSvg || flatLoading) && (
        <div className="w-full max-w-4xl rounded-xl border border-zinc-700 p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-200">Flat Pattern</h2>
            {flatMeta && (
              <div className="flex gap-4 text-xs text-zinc-400">
                <span>
                  <span className="text-zinc-500">Blank: </span>
                  {flatMeta.blank_w_mm} × {flatMeta.blank_h_mm} mm
                </span>
                <span>
                  <span className="text-zinc-500">t: </span>
                  {flatMeta.thickness_mm} mm
                </span>
                <span>
                  <span className="text-zinc-500">Bends: </span>
                  {flatMeta.bends}
                </span>
              </div>
            )}
          </div>

          {flatLoading && (
            <div className="flex items-center gap-3 text-sm text-zinc-400 py-8 justify-center">
              <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v8H4z" />
              </svg>
              Generating flat pattern...
            </div>
          )}

          {flatSvg && !flatLoading && (
            <div
              className="rounded-lg bg-white overflow-auto"
              style={{ maxHeight: 480 }}
              dangerouslySetInnerHTML={{ __html: flatSvg }}
            />
          )}
        </div>
      )}
    </main>
  );
}

export default Home;
