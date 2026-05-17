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
  const [analysis, setAnalysis] = useState<PartAnalysis | null>(null);
  const [costParams, setCostParams] = useState<CostParams>({
    moq: 1,
    materialKey: "Mild Steel",
    sheetCost: 80,
    thicknessOverrideMm: null,
    sheetIndex: 0,
    processes: { laser: true, bending: true, welding: false, finishing: false, packing: true },
    laserPcsPerHour: 0,
    bendingPcsPerHour: 0,
    weldingPcsPerHour: 0,
    finishingPcsPerHour: 60,
    packingPcsPerHour: 120,
    laserSetupMin: DEFAULT_SETUP_MIN,
    bendingSetupMin: DEFAULT_SETUP_MIN,
    weldingSetupMin: DEFAULT_SETUP_MIN,
    finishingSetupMin: DEFAULT_SETUP_MIN,
    packingSetupMin: DEFAULT_SETUP_MIN,
    laserRate: 150,
    bendingRate: 110,
    weldingRate: 95,
    finishingRate: 80,
    finishingCost: 0,
    packingRate: 65,
    weldLengthMm: 0,
    boxLengthMm: 0,
    boxWidthMm: 0,
    boxHeightMm: 0,
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

      const form = new FormData();
      form.append("file", nextFile);

      try {
        const res = await fetch("/api/full-process", { method: "POST", body: form });
        
        if (id !== loadIdRef.current) return;
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        const data = await res.json();
        if (id !== loadIdRef.current) return;

        if (data.analysis) {
          setAnalysis(data.analysis);
        }

        if (data.occ_error || !data.stl_base64) {
          setErrorMsg(data.occ_error || "Could not generate 3D mesh");
          setStatus("error");
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
    setAnalysis(null);
  };

  const showDrop = status === "idle" || status === "error";
  const showViewer = status === "viewing" || status === "exporting";

  return (
    <main className={`min-h-screen flex flex-col items-center p-6 gap-5 ${showViewer ? "justify-start" : "justify-center"}`}>
      <div className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">STEP to Label</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Rotate to pick a view, then export a clean hidden-line JPG.
        </p>
      </div>

      {showDrop && (
        <div
          onDrop={onDrop}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          className={[
            "relative flex h-48 w-80 cursor-pointer select-none flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed transition-colors",
            dragging ? "border-blue-400 bg-blue-950/30" : "border-zinc-700 bg-zinc-900 hover:border-zinc-500",
          ].join(" ")}
        >
          <div 
            className="absolute inset-0 z-0" 
            onClick={() => inputRef.current?.click()} 
          />
          <svg className="pointer-events-none z-10 h-10 w-10 text-zinc-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
            />
          </svg>
          <span className="pointer-events-none z-10 text-sm text-zinc-500">Drop .step / .stp or click</span>
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
              // Reset value so same file can be uploaded again
              e.target.value = "";
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
      <div className={`flex gap-6 items-start ${showViewer ? "" : "hidden"}`}>

        {/* ── Left column: viewer + export controls ── */}
        <div className="flex flex-col gap-3 flex-shrink-0" style={{ width: 520 }}>
          <div
            ref={mountRef}
            className="overflow-hidden rounded-xl border border-zinc-700 bg-white"
            style={{ width: 520, height: 520 }}
          />

          {showViewer && (
            <>
              <p className="text-center text-xs text-zinc-500">
                Left drag to rotate · Right drag to pan · Scroll to zoom
              </p>

              <label className="flex items-center justify-center gap-3 text-sm text-zinc-400">
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

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5">
                <div className="grid grid-cols-[minmax(0,1fr)_4.25rem_3.75rem_4.25rem_3rem] items-end gap-2">
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-zinc-500">Part name</label>
                    <input
                      type="text"
                      value={partName}
                      onChange={(e) => setPartName(e.target.value)}
                      placeholder="BRACKET-001"
                      className="h-9 rounded border border-zinc-700 bg-zinc-950 px-3 text-sm font-mono text-zinc-200 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs text-zinc-500">mm</label>
                    <input
                      type="number"
                      min={5}
                      max={1000}
                      value={Math.round(exportCm * 10)}
                      onChange={(e) => setExportCm(Number(e.target.value) / 10)}
                      className="h-9 rounded border border-zinc-700 bg-zinc-950 px-1.5 text-sm font-mono text-zinc-200"
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
                      className="h-9 rounded border border-zinc-700 bg-zinc-950 px-1.5 text-sm font-mono text-zinc-200"
                    />
                  </div>
                  <button
                    onClick={exportJpg}
                    disabled={status === "exporting"}
                    className="h-9 rounded bg-blue-600 px-3 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50"
                  >
                    {status === "exporting" ? "..." : "Export"}
                  </button>
                  <button
                    onClick={reset}
                    className="h-9 rounded border border-zinc-700 bg-zinc-800 px-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700"
                  >
                    New
                  </button>
                </div>
                <div className="mt-2 text-xs text-zinc-500">
                  {Math.round((exportCm / 2.54) * exportDpi)} x {Math.round((exportCm / 2.54) * exportDpi)} px JPG
                </div>
              </div>

            </>
          )}
        </div>

        {/* ── Right column: cost panel ── */}
        {showViewer && (
          analysis && costBreakdown ? (
            <div className="flex-1 min-w-[440px] max-w-lg rounded-xl border border-zinc-700 p-4 flex flex-col gap-4">
              <h2 className="text-sm font-semibold text-zinc-200">Cost Estimate (AUD)</h2>

              <div className="rounded-lg bg-zinc-900 p-3 text-xs text-zinc-400 flex flex-col gap-1">
                <div>
                  <span className="text-zinc-500">Flat blank: </span>
                  {analysis.flat_blank_w_mm > 0
                    ? `${analysis.flat_blank_w_mm} × ${analysis.flat_blank_h_mm} mm`
                    : `${analysis.bbox_mm[0]} × ${analysis.bbox_mm[1]} mm (3D bbox)`}
                  {" · "}
                  <span className="text-zinc-500">t </span>
                  {analysis.thickness_mm} mm
                  {" · "}
                  <span className="text-zinc-500">weight </span>
                  {costBreakdown.blankMassKg.toFixed(3)} kg
                </div>
                <div className="flex gap-3">
                  <span>{analysis.bend_count} bend{analysis.bend_count !== 1 ? "s" : ""}</span>
                  <span>·</span>
                  <span>{analysis.hole_count} hole{analysis.hole_count !== 1 ? "s" : ""}</span>
                  {analysis.cut_perimeter_mm > 0 && (
                    <>
                      <span>·</span>
                      <span>{(analysis.cut_perimeter_mm / 1000).toFixed(2)} m cut</span>
                    </>
                  )}
                </div>
                <div>
                  <span className="text-zinc-500">Sheet yield: </span>
                  {costBreakdown.partsPerSheet} parts/sheet ·{" "}
                  {costBreakdown.sheetsNeeded} sheet{costBreakdown.sheetsNeeded !== 1 ? "s" : ""} for {costParams.moq} pcs
                </div>
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
              </div>

              {costParams.processes.welding && (
                <div className="flex items-center justify-between gap-3 rounded-lg bg-zinc-900 px-3 py-2">
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
                    className="w-24 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-right text-sm font-mono text-zinc-200"
                  />
                </div>
              )}

              {costParams.processes.packing && (
                <div className="flex items-center justify-between gap-3 rounded-lg bg-zinc-900 px-3 py-2">
                  <label className="text-xs text-zinc-500">Box size (mm)</label>
                  <div className="flex gap-2">
                    {(
                      [
                        ["boxLengthMm", "L"],
                        ["boxWidthMm", "W"],
                        ["boxHeightMm", "H"],
                      ] as const
                    ).map(([field, label]) => (
                      <input
                        key={field}
                        type="number"
                        min={0}
                        placeholder={label}
                        aria-label={`Box ${label}`}
                        value={costParams[field] || ""}
                        onChange={(e) =>
                          setCostParams((p) => ({
                            ...p,
                            [field]: Math.max(0, Number(e.target.value)),
                          }))
                        }
                        className="w-16 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-center text-sm font-mono text-zinc-200"
                      />
                    ))}
                  </div>
                </div>
              )}

              <div className="overflow-hidden rounded-lg bg-zinc-900">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800 text-xs text-zinc-500">
                      <th className="px-3 py-2 text-left font-medium">Process</th>
                      <th className="px-2 py-2 text-center font-medium">pcs/h</th>
                      <th className="px-2 py-2 text-center font-medium">Setup</th>
                      <th className="px-3 py-2 text-center font-medium">Cost</th>
                      <th className="px-3 py-2 text-center font-medium">Unit</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-zinc-800">
                      <td className="px-3 py-2 text-zinc-400">Material</td>
                      <td className="px-2 py-2 text-center text-xs text-zinc-600">-</td>
                      <td className="px-2 py-2 text-center text-xs text-zinc-600">-</td>
                      <td className="px-2 py-2 text-center">
                        <input
                          type="number"
                          min={0}
                          value={costParams.sheetCost}
                          onChange={(e) =>
                            setCostParams((p) => ({
                              ...p,
                              sheetCost: Math.max(0, Number(e.target.value)),
                            }))
                          }
                          className="w-16 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200"
                        />
                      </td>
                      <td className="px-3 py-2 text-center font-mono text-zinc-200">
                        ${costBreakdown.materialUnit.toFixed(2)}
                      </td>
                    </tr>
                    {(
                      [
                        [
                          "laser",
                          "Laser / Turret",
                          "laserSetupMin",
                          "laserPcsPerHour",
                          "laserRate",
                          costBreakdown.cuttingUnit,
                          costBreakdown.laserPcsPerHour,
                        ],
                        [
                          "bending",
                          `CNC Bend (${analysis.bend_count})`,
                          "bendingSetupMin",
                          "bendingPcsPerHour",
                          "bendingRate",
                          costBreakdown.bendingUnit,
                          costBreakdown.bendingPcsPerHour,
                        ],
                        [
                          "welding",
                          "Welding",
                          "weldingSetupMin",
                          "weldingPcsPerHour",
                          "weldingRate",
                          costBreakdown.weldingUnit,
                          costBreakdown.weldingPcsPerHour,
                        ],
                        [
                          "finishing",
                          "Finishing",
                          "finishingSetupMin",
                          "finishingPcsPerHour",
                          "finishingRate",
                          costBreakdown.finishingUnit,
                          costBreakdown.finishingPcsPerHour,
                        ],
                        [
                          "packing",
                          "Pack & Inspect",
                          "packingSetupMin",
                          "packingPcsPerHour",
                          "packingRate",
                          costBreakdown.packingUnit,
                          costBreakdown.packingPcsPerHour,
                        ],
                      ] as const
                    ).map(([key, label, setupKey, pcsKey, rateKey, unitCost, pcsPerHour]) => (
                      <tr key={key} className="border-b border-zinc-800">
                        <td className="px-3 py-2">
                          <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
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
                            <span className={costParams.processes[key] ? "" : "text-zinc-600"}>
                              {label}
                            </span>
                          </label>
                        </td>
                        <td className="px-2 py-2 text-center font-mono text-xs text-zinc-300">
                          {key === "finishing" ? (
                            <span className="text-zinc-600">-</span>
                          ) : (
                            <input
                              type="number"
                              min={0}
                              disabled={!costParams.processes[key]}
                              value={costParams[pcsKey] || Math.round(pcsPerHour)}
                              onChange={(e) =>
                                setCostParams((p) => ({
                                  ...p,
                                  [pcsKey]: Math.max(0, Number(e.target.value)),
                                }))
                              }
                              className="w-14 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35"
                            />
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          {key === "finishing" ? (
                            <span className="text-xs text-zinc-600">-</span>
                          ) : (
                            <input
                              type="number"
                              min={0}
                              disabled={!costParams.processes[key]}
                              value={costParams[setupKey]}
                              onChange={(e) =>
                                setCostParams((p) => ({
                                  ...p,
                                  [setupKey]: Math.max(0, Number(e.target.value)),
                                }))
                              }
                              className="w-12 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35"
                            />
                          )}
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-zinc-200">
                          <input
                            type="number"
                            min={0}
                            disabled={!costParams.processes[key]}
                            value={key === "finishing" ? costParams.finishingCost : costParams[rateKey]}
                            onChange={(e) =>
                              setCostParams((p) => ({
                                ...p,
                                [key === "finishing" ? "finishingCost" : rateKey]: Math.max(
                                  0,
                                  Number(e.target.value),
                                ),
                              }))
                            }
                            className="w-14 rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5 text-center text-xs font-mono text-zinc-200 disabled:opacity-35"
                          />
                        </td>
                        <td className="px-3 py-2 text-center font-mono text-zinc-200">
                          {costParams.processes[key] ? `$${unitCost.toFixed(2)}` : "-"}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b border-zinc-700 bg-zinc-800/60">
                      <td className="px-3 py-2 font-medium text-zinc-200">Total / unit</td>
                      <td className="px-2 py-2" />
                      <td className="px-2 py-2" />
                      <td className="px-2 py-2" />
                      <td className="px-3 py-2 text-center font-mono font-semibold text-white">
                        ${costBreakdown.totalUnit.toFixed(2)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="rounded-lg border border-blue-900/60 bg-blue-950/30 px-3 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-xs text-zinc-400">Total x {costParams.moq} MOQ</div>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      ${costBreakdown.totalUnit.toFixed(2)} / unit
                    </div>
                  </div>
                  <div className="text-right font-mono text-lg font-semibold text-blue-300">
                    ${costBreakdown.totalAll.toFixed(2)}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-[440px] max-w-lg rounded-xl border border-zinc-800 bg-zinc-900/30 p-8 flex flex-col items-center justify-center text-center gap-3">
              <svg className="h-8 w-8 text-zinc-600 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <div className="text-sm text-zinc-400 font-medium">Analyzing part geometry...</div>
              <div className="text-xs text-zinc-500 max-w-[200px]">Extracting features for cost estimation (bends, perimeter, holes)</div>
            </div>
          )
        )}
      </div>
    </main>
  );
}

export default Home;
