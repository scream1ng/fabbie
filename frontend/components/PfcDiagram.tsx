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
        theme: 'base',
        themeVariables: {
          primaryColor: '#ffffff',
          primaryTextColor: '#1c1814',
          primaryBorderColor: '#cec8be',
          lineColor: '#aca49a',
          secondaryColor: '#f8f5f0',
          tertiaryColor: '#f0ece5',
          background: '#f0ece5',
          mainBkg: '#ffffff',
          nodeBorder: '#cec8be',
          clusterBkg: '#f8f5f0',
          titleColor: '#7a7060',
          edgeLabelBackground: '#f0ece5',
          fontFamily: "'IBM Plex Mono', monospace",
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
              svgEl.removeAttribute('width');
              svgEl.removeAttribute('height');
              svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
              svgEl.style.width = '100%';
              svgEl.style.height = '100%';
              // force small font — themeVariables fontSize doesn't reach foreignObject labels
              const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
              styleEl.textContent = `
                .nodeLabel, .nodeLabel p, .nodeLabel div,
                .label, .label p, .label div,
                foreignObject div, foreignObject p, foreignObject span {
                  font-size: 11px !important;
                  font-family: 'IBM Plex Mono', monospace !important;
                  line-height: 1.4 !important;
                  text-align: center !important;
                  display: block !important;
                  width: 100% !important;
                }
              `;
              svgEl.insertBefore(styleEl, svgEl.firstChild);
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
      className="flex-1 min-h-0 w-full overflow-hidden flex items-center justify-center"
    >
      <div className="text-xs text-zinc-600 animate-pulse py-8">Rendering diagram…</div>
    </div>
  );
}
