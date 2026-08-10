import React, { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { MonitorSmartphone, AppWindow } from 'lucide-react'
import { useTheme } from '../../../../infrastructure/theme/hooks/useTheme'
import { useIslandStore } from '../../store/islandStore'
import { useI18n } from '../../../../infrastructure/i18n'
import './ThemeActivity.scss'

export const ThemeActivity: React.FC = () => {
  const { t } = useI18n('vrm')
  const {
    accentHue,
    setAccentHue,
  } = useTheme()
  const activities = useIslandStore((s) => s.activities)
  const activeActivityId = useIslandStore((s) => s.activeActivityId)
  const [underlayVisible, setUnderlayVisible] = useState(false)

  // === Compact: hue circle ===
  const renderCompact = () => (
    <div className="theme-activity theme-activity--compact">
      <span
        className="theme-activity__hue-dot"
        style={{ background: `hsl(${accentHue ?? 200}, 72%, 65%)` }}
      />
    </div>
  )

  // === Expanded: hue bar + quick action buttons (no expand button) ===
  const renderExpanded = () => {
    return (
      <div className="theme-activity theme-activity--expanded">
        {/* Page indicator dots (top center) — one per visible activity */}
        <div className="theme-activity__indicators">
          {activities.filter(a => a.visible).map(a => (
            <span
              key={a.id}
              className={`theme-activity__indicator ${a.id === activeActivityId ? 'theme-activity__indicator--active' : ''}`}
            />
          ))}
        </div>
        <div className="theme-activity__info">
          <div className="theme-activity__hue-bar">
            <input
              type="range"
              min={0}
              max={360}
              value={accentHue ?? 200}
              onChange={(e) => {
                e.stopPropagation()
                setAccentHue(parseInt(e.target.value, 10))
              }}
              onClick={(e) => e.stopPropagation()}
              className="theme-activity__hue-slider"
            />
          </div>
        </div>
        {/* Quick action buttons */}
        <div className="theme-activity__actions">
          <button
            className={`theme-activity__action-btn ${underlayVisible ? 'theme-activity__action-btn--active' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              const next = !underlayVisible
              setUnderlayVisible(next)
              invoke('execute_custom_command', { command: next ? 'show_underlay' : 'hide_underlay' }).catch(() => {})
            }}
            title={t('island.action.toggleDesktop')}
          >
            <MonitorSmartphone size={14} />
          </button>
          <button
            className="theme-activity__action-btn"
            onClick={(e) => {
              e.stopPropagation()
              invoke('open_task_window', { sessionId: null, sessionTitle: null, openSettings: true }).catch(() => {})
            }}
            title={t('island.action.openTask')}
          >
            <AppWindow size={14} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="island-layer island-layer--compact">
        {renderCompact()}
      </div>
      <div className="island-layer island-layer--expanded">
        {renderExpanded()}
      </div>
    </>
  )
}
