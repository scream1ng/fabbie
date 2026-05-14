"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";

type Status = "idle" | "loading" | "viewing" | "exporting" | "error";

function cmDpiToPx(cm: number, dpi: number) {
  return Math.round((cm / 2.54) * dpi);
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [linePx, setLinePx] = useState(3);
  const [partName, setPartName] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [exportCm, setExportCm] = useState(26);
  const [exportDpi, setExportDpi] = useState(300);

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

      const meshForm = new FormData();
      meshForm.append("file", nextFile);
      const edgesForm = new FormData();
      edgesForm.append("file", nextFile);

      try {
        const [meshRes, edgesRes] = await Promise.all([
          fetch("/api/mesh", { method: "POST", body: meshForm }),
          fetch("/api/edges", { method: "POST", body: edgesForm }),
        ]);
        if (id !== loadIdRef.current) return;
        if (!meshRes.ok) throw new Error(`Mesh: ${meshRes.status}`);
        if (!edgesRes.ok) throw new Error(`Edges: ${edgesRes.status}`);

        const [stlBlob, edgesData]: [Blob, number[][][]] = await Promise.all([
          meshRes.blob(),
          edgesRes.json(),
        ]);
        if (id !== loadIdRef.current) return;

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

  const reset = () => {
    cleanup();
    setFile(null);
    setStatus("idle");
    setErrorMsg("");
    setPartName("");
  };

  const showDrop = status === "idle" || status === "error";
  const showViewer = status === "viewing" || status === "exporting";

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
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

      <div
        ref={mountRef}
        className={["w-full overflow-hidden rounded-xl border border-zinc-700 bg-white", showViewer ? "" : "hidden"].join(" ")}
        style={{ aspectRatio: "1 / 1", maxWidth: 520 }}
      />

      {showViewer && (
        <div className="flex w-full max-w-lg flex-col items-center gap-4">
          <p className="text-xs text-zinc-500">
            Left drag to rotate | Right drag to pan | Scroll to zoom
          </p>

          <div className="flex w-full max-w-sm flex-col gap-1">
            <label className="text-xs text-zinc-500">Part name (used as file name)</label>
            <input
              type="text"
              value={partName}
              onChange={(e) => setPartName(e.target.value)}
              placeholder="e.g. BRACKET-001"
              className="rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-mono text-zinc-200 focus:border-blue-500 focus:outline-none"
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

          <div className="flex items-end gap-4">
            <div className="flex flex-col">
              <label className="text-xs text-zinc-500">Export size (cm)</label>
              <input
                type="number"
                min={5}
                max={100}
                value={exportCm}
                onChange={(e) => setExportCm(Number(e.target.value))}
                className="w-20 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm font-mono text-zinc-200"
              />
            </div>
            <div className="flex flex-col">
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
            <button
              onClick={exportJpg}
              disabled={status === "exporting"}
              className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium transition-colors hover:bg-blue-500 disabled:opacity-50"
            >
              {status === "exporting" ? "Generating..." : `Export JPG (${exportCm}x${exportCm} cm @ ${exportDpi} dpi)`}
            </button>
            <button
              onClick={reset}
              className="rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 transition-colors hover:bg-zinc-700"
            >
              Load new file
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
