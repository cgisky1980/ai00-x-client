import React, { useState } from 'react'
import {
  AppWindow,
  LayoutGrid,
  MessageCircle,
  MonitorSmartphone,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { WindowAPI } from '@/infrastructure/windows/WindowAPI'
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll'
import './ToolsActivity.scss'

/**
 * ToolsActivity — 灵动岛第 3 行：功能按钮 dock。
 *
 * 单行 dock：内置按钮（桌面宠物切换 / 任务窗口 / 待办）+ 插件槽
 * `#ai00-island-slot`（overlay:island hook，与宿主按钮同行）。
 * 按钮少时居中；溢出时可拖动或滚轮左右滑动。
 */
export const ToolsActivity: React.FC = () => {
  // Desktop pet visibility (local toggle state; migrated from MusicActivity
  // where it crowded the playback controls).
  const [underlayVisible, setUnderlayVisible] = useState(false)
  const scroll = useHorizontalScroll()

  const actions = [
    {
      key: 'desktop',
      icon: MonitorSmartphone,
      label: '切换桌面',
      onClick: () => {
        const next = !underlayVisible
        setUnderlayVisible(next)
        invoke('execute_custom_command', {
          command: next ? 'show_underlay' : 'hide_underlay',
        }).catch(() => {})
      },
    },
    {
      key: 'chat',
      icon: MessageCircle,
      label: '聊天',
      onClick: () => {
        WindowAPI.open('community').catch(() => {})
      },
    },
    {
      key: 'settings',
      icon: AppWindow,
      label: '设置',
      onClick: () => {
        // 「策」窗口已回退为设置窗口（label: settings，2026-11-08）：这里打开
        // 独立设置窗口。到点提醒不依赖本入口——提醒由常驻 overlay 的策运行时
        // （TodoOverlay）驱动。
        WindowAPI.open('settings').catch(() => {})
      },
    },
    {
      key: 'workbench',
      icon: LayoutGrid,
      label: '工作台',
      onClick: () => {
        // 插件工作台的宿主窗口（左侧列表 / 右侧 scene:page）。
        WindowAPI.open('workbench').catch(() => {})
      },
    },
  ]

  return (
    <div className="tools-activity tools-activity--row">
      {/* Dock scroll viewport: drag / wheel scrolls horizontally; content
          centers itself when it fits (inner min-width: max-content). */}
      <div
        className="tools-activity__dock"
        ref={scroll.ref}
        onMouseDown={scroll.onMouseDown}
        onMouseMove={scroll.onMouseMove}
        onMouseUp={scroll.onMouseUp}
        onMouseLeave={scroll.onMouseLeave}
        onWheel={scroll.onWheel}
      >
        <div className="tools-activity__dock-inner">
          {actions.map((a) => (
            <button
              key={a.key}
              className="tools-activity__btn"
              onClick={(e) => {
                e.stopPropagation()
                if (scroll.didDrag.current) return
                a.onClick()
              }}
              title={a.label}
            >
              <a.icon size={18} strokeWidth={1.5} />
            </button>
          ))}
          {/* Plugin extension slot (overlay:island hook) */}
          <div id="ai00-island-slot" className="tools-activity__plugin-slot" />
        </div>
      </div>
    </div>
  )
}
