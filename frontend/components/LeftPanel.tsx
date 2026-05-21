'use client';

import React from 'react';

interface LeftPanelProps {
  mountRef: React.RefObject<HTMLDivElement>;
  status: 'idle' | 'loading' | 'viewing' | 'exporting' | 'error';
  errorMsg: string;
  linePx: number;
  onLinePxChange: (v: number) => void;
  partName: string;
  onPartNameChange: (v: string) => void;
  exportSizeMm: number;
  onExportSizeMmChange: (v: number) => void;
  exportDpi: number;
  onExportDpiChange: (v: number) => void;
  onExport: () => void;
  onNew: () => void;
  /** file input ref — click to open file picker */
  inputRef: React.RefObject<HTMLInputElement>;
  onFileChange: (f: File) => void;
  dragging: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

export default function LeftPanel({
  mountRef,
  status,
  errorMsg,
  linePx,
  onLinePxChange,
  partName,
  onPartNameChange,
  exportSizeMm,
  onExportSizeMmChange,
  exportDpi,
  onExportDpiChange,
  onExport,
  onNew,
  inputRef,
  onFileChange,
  dragging,
  onDragOver,
  onDragLeave,
  onDrop,
}: LeftPanelProps) {
  const showViewer = status === 'viewing' || status === 'exporting';
  const showDrop   = status === 'idle' || status === 'error';
  const exportPx   = Math.round((exportSizeMm / 25.4) * exportDpi);

  return (
    <div
      className="w-[360px] flex-shrink-0 flex flex-col h-full bg-white border-r border-[#cec8be]"
      style={{ fontFamily: "'IBM Plex Mono', monospace" }}
    >
      {/* ── 3D Viewport ── */}
      <div
        className="flex-1 min-h-0 max-h-[320px] m-2.5 mb-0 relative rounded overflow-hidden"
        style={{ background: '#111009', border: '1px solid #302c24' }}
      >
        {/* Drop overlay — only shown when idle/error */}
        {showDrop && (
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => inputRef.current?.click()}
            className={[
              'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors',
              dragging ? 'bg-[#0d1a3a]/80' : '',
            ].join(' ')}
          >
            <svg className="w-10 h-10 text-[#46433c]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" />
            </svg>
            <span className="text-[11px] text-[#46433c] select-none">Drop .step / .stp or click</span>
          </div>
        )}

        {/* Loading spinner */}
        {status === 'loading' && (
          <div className="absolute inset-0 z-10 flex items-center justify-center">
            <svg className="w-7 h-7 animate-spin text-[#46433c]" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v8H4z" />
            </svg>
          </div>
        )}

        {/* Error overlay inside viewport */}
        {errorMsg && showViewer && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#111009]/80 p-4">
            <p className="text-[10px] text-red-400 text-center">{errorMsg}</p>
          </div>
        )}

        {/* Three.js canvas mount */}
        <div ref={mountRef} className="w-full h-full" />

        {/* Viewport hint */}
        {showViewer && (
          <div className="absolute bottom-2 left-0 right-0 text-center text-[9px] text-[#46433c] select-none pointer-events-none">
            Left drag to rotate · Right drag to pan · Scroll to zoom
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept=".step,.stp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFileChange(f);
            e.target.value = '';
          }}
        />
      </div>

      {/* ── Controls ── */}
      <div
        className="flex-shrink-0 p-2.5 bg-white border-t border-[#cec8be]"
        style={{ fontFamily: "'IBM Plex Mono', monospace" }}
      >
        {/* Line thickness — only when viewer active */}
        {showViewer && (
          <div className="flex items-center gap-2 mb-2.5">
            <span className="text-[10px] text-[#7a7060] whitespace-nowrap">Line Thickness</span>
            <input
              type="range" min={1} max={10} value={linePx}
              onChange={(e) => onLinePxChange(Number(e.target.value))}
              className="flex-1 accent-[#1c1814]"
            />
            <span className="text-[10px] text-[#1c1814] w-3.5 text-right">{linePx}</span>
          </div>
        )}

        <div className="h-px bg-[#cec8be] mb-2.5" />

        {/* Part name */}
        <div className="flex flex-col gap-1 mb-2">
          <span className="text-[9px] text-[#7a7060] uppercase tracking-wider">Part Name</span>
          <input
            type="text"
            value={partName}
            onChange={(e) => onPartNameChange(e.target.value)}
            placeholder="BRACKET-001…"
            className="h-8 rounded-sm border border-[#cec8be] bg-white px-2 text-[11px] text-[#1c1814] focus:border-[#1c1814] focus:outline-none"
          />
        </div>

        {/* Size + DPI */}
        <div className="flex gap-2 mb-2.5">
          <div className="flex flex-col gap-1 flex-1">
            <span className="text-[9px] text-[#7a7060] uppercase tracking-wider">Size (mm)</span>
            <input
              type="number" min={5} max={1000}
              value={exportSizeMm}
              onChange={(e) => onExportSizeMmChange(Math.max(5, Number(e.target.value)))}
              className="h-8 rounded-sm border border-[#cec8be] bg-white px-2 text-[11px] font-mono text-[#1c1814] focus:border-[#1c1814] focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1">
            <span className="text-[9px] text-[#7a7060] uppercase tracking-wider">DPI</span>
            <input
              type="number" min={72} max={1200}
              value={exportDpi}
              onChange={(e) => onExportDpiChange(Math.max(72, Number(e.target.value)))}
              className="h-8 rounded-sm border border-[#cec8be] bg-white px-2 text-[11px] font-mono text-[#1c1814] focus:border-[#1c1814] focus:outline-none"
            />
          </div>
        </div>

        {/* Buttons */}
        <div className="flex gap-1.5 mb-1.5">
          <button
            onClick={onExport}
            disabled={!showViewer || status === 'exporting'}
            className="flex-1 h-8 rounded-sm bg-[#1c1814] text-white text-[11px] hover:bg-[#3d3730] disabled:opacity-40 transition-colors"
          >
            {status === 'exporting' ? 'Exporting…' : 'Export'}
          </button>
          <button
            onClick={onNew}
            className="h-8 px-3 rounded-sm border border-[#cec8be] bg-[#e6e1d8] text-[11px] text-[#1c1814] hover:bg-[#cec8be] transition-colors"
          >
            New
          </button>
        </div>

        {/* Pixel hint */}
        <div className="text-[9px] text-[#aca49a]">
          {exportSizeMm} × {exportSizeMm} mm — {exportPx} × {exportPx} px JPG
        </div>

        {/* Error message below controls */}
        {errorMsg && !showViewer && (
          <p className="mt-2 text-[10px] text-red-500 break-words">{errorMsg}</p>
        )}
      </div>
    </div>
  );
}
