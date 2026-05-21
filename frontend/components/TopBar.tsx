'use client';

import React from 'react';

export type RightTab = 'MLB' | 'PFC' | 'DATA';

interface TopBarProps {
  activeTab: RightTab;
  onTabChange: (tab: RightTab) => void;
  onNew: () => void;
}

const TABS: RightTab[] = ['MLB', 'PFC', 'DATA'];

export default function TopBar({
  activeTab,
  onTabChange,
  onNew,
}: TopBarProps) {
  return (
    <div className="h-[38px] flex-shrink-0 flex items-stretch bg-[#f8f5f0] border-b border-[#cec8be]">
      {/* Logo */}
      <div className="px-4 flex-shrink-0 flex items-center border-r border-[#cec8be]">
        <span className="font-['Caveat',cursive] text-[22px] font-bold leading-none tracking-tight select-none">
          <span style={{ color: '#1c1814' }}>fab</span><span style={{ color: '#7a7060' }}>bie</span>
        </span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Tab switcher */}
      <div className="flex items-stretch flex-shrink-0">
        {TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => onTabChange(tab)}
            className={[
              'flex items-center px-[18px] font-mono text-[11px] border-r border-[#cec8be] transition-colors',
              activeTab === tab
                ? 'border-b-2 border-b-[#1c1814] text-[#1c1814] bg-[#e6e1d8]'
                : 'border-b-2 border-b-transparent text-[#7a7060] hover:text-[#1c1814] bg-transparent',
            ].join(' ')}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* New button */}
      <div className="flex items-center px-3.5">
        <button
          onClick={onNew}
          className="font-mono text-[11px] text-white bg-[#1c1814] rounded-sm px-3 py-1 hover:bg-[#3d3730] transition-colors"
        >
          New
        </button>
      </div>
    </div>
  );
}
