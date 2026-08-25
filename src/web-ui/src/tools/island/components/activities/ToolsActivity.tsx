import React, { useState } from 'react'
import {
  AppWindow,
  LayoutGrid,
  ListTodo,
  MonitorSmartphone,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useTodoStore } from '../../../todo'
import './ToolsActivity.scss'

/**
 * Tools activity — the island's function dock (滚轮切换第三页).
 *
 * A single dock row of evenly-spaced buttons: desktop pet toggle, task
 * window, plus anything injected by plugins via the `overlay:island` hook
 * (#ai00-island-slot renders inline in the SAME row — one dock, no second
 * line). The slot keeps the DOM id it had before, so the plugin runtime
 * picks it up with zero changes.
 */
export const ToolsActivity: React.FC = () => {
  // Desktop pet visibility (local toggle state; migrated from MusicActivity
  // where it crowded the playback controls).
  const [underlayVisible, setUnderlayVisible] = useState(false)

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
      key: 'task',
      icon: AppWindow,
      label: '打开任务窗口',
      onClick: () => {
        invoke('open_task_window', {
          sessionId: null,
          sessionTitle: null,
          openSettings: true,
        }).catch(() => {})
      },
    },
    {
      key: 'todo',
      icon: ListTodo,
      label: '待办清单',
      onClick: () => {
        useTodoStore.getState().togglePanel()
      },
    },
  ]

  return (
    <>
      <div className="island-layer island-layer--compact">
        <div className="tools-activity tools-activity--compact">
          <LayoutGrid size={14} className="tools-activity__icon" />
        </div>
      </div>
      <div className="island-layer island-layer--expanded">
        <div className="tools-activity tools-activity--expanded">
          {/* Dock row: host buttons + plugin slot share ONE flex row —
              evenly spaced, centered, no wrapping. */}
          <div className="tools-activity__dock">
            {actions.map((a) => (
              <button
                key={a.key}
                className="tools-activity__btn"
                onClick={(e) => {
                  e.stopPropagation()
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
    </>
  )
}
