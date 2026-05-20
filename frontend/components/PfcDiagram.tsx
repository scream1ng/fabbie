'use client';

import React, { useEffect, useRef, useId } from 'react';
import type { BomRow } from './MlbSection';
import { buildMermaidFromMlb } from '../app/bom';

interface PfcDiagramProps {
  rows: BomRow[];
  isAssembly: boolean;
}

export default function PfcDiagram({ rows }: PfcDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rawId = useId();
  const stableId = rawId.replace(/:/g, '');
  const definition = buildMermaidFromMlb(rows);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !definition) return;

    let cancelled = false;

    import('mermaid').then(({ default: mermaid }) => {
      if (cancelled) return;
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        themeVariables: {
          primaryColor: '#3f3f46',
          primaryTextColor: '#e4e4e7',
          primaryBorderColor: '#52525b',
          lineColor: '#71717a',
          secondaryColor: '#27272a',
          tertiaryColor: '#18181b',
          background: '#09090b',
          mainBkg: '#27272a',
          nodeBorder: '#52525b',
          clusterBkg: '#18181b',
          titleColor: '#a1a1aa',
          edgeLabelBackground: '#18181b',
          fontFamily: 'ui-monospace, monospace',
          fontSize: '12px',
        },
      });

      const diagId = `pfc-${stableId}`;
      mermaid
        .render(diagId, definition)
        .then(({ svg }) => {
          if (!cancelled && containerRef.current) {
            containerRef.current.innerHTML = svg;
            // make SVG responsive
            const svgEl = containerRef.current.querySelector('svg');
            if (svgEl) {
              svgEl.removeAttribute('height');
              svgEl.style.maxWidth = '100%';
            }
          }
        })
        .catch((err) => {
          if (!cancelled && containerRef.current) {
            containerRef.current.innerHTML = `<pre class="text-xs text-red-400 whitespace-pre-wrap">${String(err)}\n\n${definition}</pre>`;
          }
        });
    });

    return () => {
      cancelled = true;
    };
  }, [definition, stableId]);

  if (!definition) return null;

  return (
    <div
      ref={containerRef}
      className="w-full overflow-x-auto min-h-[80px] flex items-start justify-center"
    >
      <div className="text-xs text-zinc-600 animate-pulse py-8">Rendering diagram…</div>
    </div>
  );
}
