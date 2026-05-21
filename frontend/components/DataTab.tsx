'use client';

import { useEffect, useState } from 'react';

export interface ProcPreset {
  proc: string;
  suffix: string;
  model: 'rate' | 'flat';
  rate: number;
  setup: number;
  pph: number;
}

export interface MaterialEntry {
  id: string;
  p: string;
  d: string;
  cost: number;
}

const DEFAULT_PROCS: ProcPreset[] = [
  { proc: 'LASER',  suffix: 'L', model: 'rate', rate: 150, setup: 15, pph: 60  },
  { proc: 'BEND',   suffix: 'B', model: 'rate', rate: 110, setup: 15, pph: 20  },
  { proc: 'WELD',   suffix: '',  model: 'rate', rate: 95,  setup: 15, pph: 60  },
  { proc: 'ECOAT',  suffix: 'E', model: 'flat', rate: 0,   setup: 0,  pph: 0   },
];

const DEFAULT_MATS: MaterialEntry[] = [
  { id: '1', p: '720334', d: '2.0 HA3P 2440 × 1220 SHT', cost: 80 },
  { id: '2', p: '720335', d: '3.0 HA3P 2440 × 1220 SHT', cost: 95 },
  { id: '3', p: '720336', d: '1.6 HA3P 2440 × 1220 SHT', cost: 72 },
];

const LS_PROCS = 'fabbie_proc_presets';
const LS_MATS  = 'fabbie_materials';

function load<T>(key: string, def: T): T {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : def; } catch { return def; }
}

function InlineNum({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);
  const commit = () => { setEditing(false); const n = Number(draft); if (!isNaN(n)) onChange(Math.max(0, n)); };
  if (editing) return (
    <input autoFocus type="number" min={0} value={draft}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
      className="w-full h-full px-1.5 text-[11px] font-mono outline-none border border-[#1c1814] rounded bg-white text-right text-[#1c1814]"
    />
  );
  return (
    <div className="flex items-center justify-end px-1.5 h-full cursor-text group" onClick={() => { setDraft(String(value)); setEditing(true); }}>
      <span className="text-[11px] font-mono text-[#1c1814] group-hover:underline group-hover:decoration-dotted">{value}</span>
    </div>
  );
}

function InlineText({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const commit = () => { setEditing(false); onChange(draft); };
  if (editing) return (
    <input autoFocus value={draft}
      onChange={e => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur(); }}
      className="w-full h-full px-1.5 text-[11px] font-mono outline-none border border-[#1c1814] rounded bg-white text-[#1c1814]"
    />
  );
  return (
    <div className="flex items-center px-1.5 h-full cursor-text group min-w-0" onClick={() => { setDraft(value); setEditing(true); }}>
      <span className="truncate text-[11px] font-mono text-[#1c1814] group-hover:underline group-hover:decoration-dotted">{value || <span className="text-[#aca49a]">—</span>}</span>
    </div>
  );
}

export default function DataTab() {
  const [procs, setProcs] = useState<ProcPreset[]>(() => load(LS_PROCS, DEFAULT_PROCS));
  const [mats, setMats]   = useState<MaterialEntry[]>(() => load(LS_MATS, DEFAULT_MATS));

  useEffect(() => { localStorage.setItem(LS_PROCS, JSON.stringify(procs)); }, [procs]);
  useEffect(() => { localStorage.setItem(LS_MATS,  JSON.stringify(mats));  }, [mats]);

  const updateProc = (i: number, patch: Partial<ProcPreset>) =>
    setProcs(ps => ps.map((p, j) => j === i ? { ...p, ...patch } : p));
  const addProc = () => setProcs(ps => [...ps, { proc: '', suffix: '', model: 'rate', rate: 0, setup: 0, pph: 0 }]);
  const delProc = (i: number) => setProcs(ps => ps.filter((_, j) => j !== i));

  const updateMat = (id: string, patch: Partial<MaterialEntry>) =>
    setMats(ms => ms.map(m => m.id === id ? { ...m, ...patch } : m));

  const addMat = () => setMats(ms => [...ms, { id: Date.now().toString(), p: '', d: '', cost: 0 }]);
  const delMat = (id: string) => setMats(ms => ms.filter(m => m.id !== id));

  const copyPart = (p: string) => navigator.clipboard?.writeText(p);

  return (
    <div className="h-full overflow-y-auto p-4" style={{ background: '#f8f5f0' }}>
      <div className="flex flex-col gap-4 max-w-2xl mx-auto w-full">

        {/* Process presets */}
        <div className="border border-[#cec8be] rounded-lg overflow-hidden">
          <div className="px-3.5 py-2 border-b border-[#cec8be] bg-white flex items-center justify-between">
            <div>
              <span className="text-[9px] font-mono uppercase tracking-wider text-[#7a7060]">Process Presets</span>
              <span className="ml-2 text-[9px] font-mono text-[#aca49a]">used for auto-fill when setting Proc in MLB</span>
            </div>
            <button onClick={addProc}
              className="text-[10px] font-mono text-[#1c1814] hover:underline">+ add</button>
          </div>
          <div className="grid bg-[#f8f5f0] px-0.5 h-6 items-center border-b border-[#cec8be]"
            style={{ gridTemplateColumns: '20px 1fr 44px 72px 72px 64px 64px' }}>
            <span />
            <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5">PROC</span>
            <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-center">SFX</span>
            <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-center">MODEL</span>
            <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-right">RATE/$</span>
            <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-right">SETUP</span>
            <span className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5 text-right">PCS/H</span>
          </div>
          {procs.map((p, i) => (
            <div key={i} className="grid items-stretch h-[30px] border-b border-[#cec8be] last:border-b-0 group hover:bg-[#f8f5f0]"
              style={{ gridTemplateColumns: '20px 1fr 44px 72px 72px 64px 64px' }}>
              <div className="flex items-center justify-center opacity-0 group-hover:opacity-100">
                <button onClick={() => delProc(i)}
                  className="w-4 h-4 flex items-center justify-center rounded text-[11px] text-[#aca49a] hover:bg-red-100 hover:text-red-500">×</button>
              </div>
              <InlineText value={p.proc} onChange={v => updateProc(i, { proc: v })} />
              <div className="flex items-center justify-center px-1">
                <span className="text-[11px] font-mono text-[#7a7060] cursor-pointer" onClick={() => {
                  const v = prompt('Suffix letter', p.suffix) ?? p.suffix;
                  updateProc(i, { suffix: v });
                }}>{p.suffix || <span className="text-[#cec8be]">—</span>}</span>
              </div>
              <div className="flex items-center justify-center px-1.5">
                <button
                  onClick={() => updateProc(i, { model: p.model === 'rate' ? 'flat' : 'rate' })}
                  className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-[#cec8be] hover:border-[#1c1814] text-[#7a7060] hover:text-[#1c1814]"
                >{p.model === 'rate' ? '$/h' : '$/part'}</button>
              </div>
              <InlineNum value={p.rate} onChange={v => updateProc(i, { rate: v })} />
              {p.model === 'rate'
                ? <InlineNum value={p.setup} onChange={v => updateProc(i, { setup: v })} />
                : <div className="flex items-center justify-end px-1.5"><span className="text-[11px] font-mono text-[#cec8be]">—</span></div>
              }
              {p.model === 'rate'
                ? <InlineNum value={p.pph ?? 0} onChange={v => updateProc(i, { pph: v })} />
                : <div className="flex items-center justify-end px-1.5"><span className="text-[11px] font-mono text-[#cec8be]">—</span></div>
              }
            </div>
          ))}
        </div>

        {/* Material library */}
        <div className="border border-[#cec8be] rounded-lg overflow-hidden">
          <div className="px-3.5 py-2 border-b border-[#cec8be] bg-white flex items-center justify-between">
            <div>
              <span className="text-[9px] font-mono uppercase tracking-wider text-[#7a7060]">Raw Material Library</span>
              <span className="ml-2 text-[9px] font-mono text-[#aca49a]">reference / lookup</span>
            </div>
            <button onClick={addMat}
              className="text-[10px] font-mono text-[#1c1814] hover:underline">+ add</button>
          </div>
          <div className="grid bg-[#f8f5f0] px-0.5 h-6 items-center border-b border-[#cec8be]"
            style={{ gridTemplateColumns: '20px 100px 1fr 72px' }}>
            <span />
            {['PART #', 'DESCRIPTION', '$/UNIT'].map(h => (
              <span key={h} className="text-[9px] font-mono uppercase tracking-wider text-[#aca49a] px-1.5">{h}</span>
            ))}
          </div>
          {mats.map(m => (
            <div key={m.id} className="grid items-stretch h-[30px] border-b border-[#cec8be] last:border-b-0 group hover:bg-[#f8f5f0]"
              style={{ gridTemplateColumns: '20px 100px 1fr 72px' }}>
              <div className="flex items-center justify-center opacity-0 group-hover:opacity-100">
                <button onClick={() => delMat(m.id)}
                  className="w-4 h-4 flex items-center justify-center rounded text-[11px] text-[#aca49a] hover:bg-red-100 hover:text-red-500">×</button>
              </div>
              <div className="flex items-stretch min-w-0">
                <div className="flex-1 min-w-0">
                  <InlineText value={m.p} onChange={v => updateMat(m.id, { p: v })} />
                </div>
                <button onClick={() => copyPart(m.p)} title="Copy part#"
                  className="flex-shrink-0 px-1 text-[#cec8be] hover:text-[#1c1814] text-[10px] opacity-0 group-hover:opacity-100">⎘</button>
              </div>
              <InlineText value={m.d} onChange={v => updateMat(m.id, { d: v })} />
              <InlineNum value={m.cost} onChange={v => updateMat(m.id, { cost: v })} />
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
