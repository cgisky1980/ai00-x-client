/* eslint-disable react-refresh/only-export-components */
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfigPageLayout, ConfigPageContent, ConfigPageHeader, ConfigPageSection, ConfigPageRow } from '../../../../infrastructure/config/components/common'
import { vrmApi } from '@/tools/vrm/api/vrmApi'
import type { GestureConfig, GestureActionType, GestureTemplateConfig } from '@/tools/vrm/types'
import PatternRecorder from './PatternRecorder'
import PatternPreview from './PatternPreview'
import './GestureSettings.scss'

export const ACTION_LABELS: Record<GestureActionType, string> = {
  OpenSettings: 'configCenter.gesture.actions.OpenSettings',
  OpenMain: 'configCenter.gesture.actions.OpenMain',
  ToggleUnderlay: 'configCenter.gesture.actions.ToggleUnderlay',
  CustomCommand: 'configCenter.gesture.actions.CustomCommand',
  None: 'configCenter.gesture.actions.None',
}

export const ACTION_OPTIONS: GestureActionType[] = ['OpenSettings', 'OpenMain', 'ToggleUnderlay', 'None']

export function useGestureConfig() {
  const [config, setConfig] = useState<GestureConfig | null>(null)

  const loadConfig = useCallback(async () => {
    try {
      const c = await vrmApi.gesture.getConfig()
      setConfig(c)
    } catch (_e) {
      setConfig(null)
    }
  }, [])

  useEffect(() => {
    loadConfig()
  }, [loadConfig])

  const saveConfig = useCallback(async (newConfig: GestureConfig) => {
    try {
      await vrmApi.gesture.setConfig(newConfig)
      setConfig(newConfig)
    } catch (_e) {
      // ignore
    }
  }, [])

  return { config, loadConfig, saveConfig }
}

export function GestureConfigSection() {
  const { t } = useTranslation('settings')
  const { config, saveConfig } = useGestureConfig()

  const handleToggleEnabled = useCallback(() => {
    if (!config) return
    saveConfig({ ...config, enabled: !config.enabled })
  }, [config, saveConfig])

  const handleGridSpacingChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (!config) return
      saveConfig({ ...config, grid_spacing: parseFloat(e.target.value) })
    },
    [config, saveConfig],
  )

  if (!config) return null

  return (
    <ConfigPageSection title="">
      <ConfigPageRow label={t('configCenter.gesture.enabled')} align="center">
        <div className="gesture-settings__toggle">
          <label className="gesture-settings__switch">
            <input type="checkbox" checked={config.enabled} onChange={handleToggleEnabled} />
            <span className="gesture-settings__slider" />
          </label>
          <span>{config.enabled ? 'ON' : 'OFF'}</span>
        </div>
      </ConfigPageRow>

      <ConfigPageRow label={t('configCenter.gesture.gridSpacing')} align="center">
        <div className="gesture-settings__threshold">
          <input
            type="range"
            min="50"
            max="120"
            step="5"
            value={config.grid_spacing}
            onChange={handleGridSpacingChange}
          />
          <span className="gesture-settings__threshold-value">{config.grid_spacing}px</span>
        </div>
      </ConfigPageRow>
    </ConfigPageSection>
  )
}

const GROUP_LABELS_KEY = 'gesture_group_labels'

export function useGroupLabels(): [Record<number, string>, (node: number, label: string) => void] {
  const [labels, setLabels] = useState<Record<number, string>>({})

  useEffect(() => {
    try {
      const raw = localStorage.getItem(GROUP_LABELS_KEY)
      if (raw) setLabels(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])

  const updateLabel = useCallback((node: number, label: string) => {
    setLabels((prev) => {
      const next = { ...prev }
      if (label.trim()) {
        next[node] = label.trim()
      } else {
        delete next[node]
      }
      localStorage.setItem(GROUP_LABELS_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  return [labels, updateLabel]
}

export function GestureTemplateSection() {
  const { t } = useTranslation('settings')
  const { config, loadConfig, saveConfig } = useGestureConfig()
  const [showRecorder, setShowRecorder] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<GestureTemplateConfig | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameValue, setNameValue] = useState('')
  const [groupLabels, updateGroupLabel] = useGroupLabels()
  const [editingGroupLabel, setEditingGroupLabel] = useState<number | null>(null)
  const [groupLabelValue, setGroupLabelValue] = useState('')
  const [activeGroup, setActiveGroup] = useState<number | null>(null)
  const groupRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const sectionRef = useRef<HTMLDivElement>(null)

  const handleBindingChange = useCallback(
    (gestureName: string, actionType: GestureActionType, command?: string) => {
      if (!config) return
      const bindings = config.bindings.filter((b) => b.gesture_name !== gestureName)
      const action: { type: GestureActionType; params?: { command: string } } = { type: actionType }
      if (actionType === 'CustomCommand' && command) {
        action.params = { command }
      }
      bindings.push({ gesture_name: gestureName, action })
      saveConfig({ ...config, bindings })
    },
    [config, saveConfig],
  )

  const getBinding = (gestureName: string) => {
    if (!config) return { type: 'None' as GestureActionType }
    const b = config.bindings.find((b) => b.gesture_name === gestureName)
    return b ? b.action : { type: 'None' as GestureActionType }
  }

  const handleStartEditName = useCallback((template: GestureTemplateConfig) => {
    setEditingName(template.name)
    setNameValue(template.description || template.name)
  }, [])

  const handleSaveName = useCallback(async (oldName: string) => {
    if (!config || !editingName) return
    const trimmed = nameValue.trim()
    if (!trimmed || trimmed === oldName) {
      setEditingName(null)
      return
    }
    const newConfig = { ...config }
    const idx = newConfig.templates.findIndex((t) => t.name === oldName)
    if (idx < 0) return
    newConfig.templates = [...newConfig.templates]
    newConfig.templates[idx] = { ...newConfig.templates[idx], name: trimmed, description: trimmed }
    newConfig.bindings = newConfig.bindings.map((b) =>
      b.gesture_name === oldName ? { ...b, gesture_name: trimmed } : b,
    )
    await saveConfig(newConfig)
    setEditingName(null)
  }, [config, nameValue, editingName, saveConfig])

  const handleNameKeyDown = useCallback(
    (e: React.KeyboardEvent, oldName: string) => {
      if (e.key === 'Enter') handleSaveName(oldName)
      if (e.key === 'Escape') setEditingName(null)
    },
    [handleSaveName],
  )

  const handleDeleteTemplate = useCallback(
    async (name: string) => {
      try {
        await vrmApi.gesture.removeTemplate(name)
        await loadConfig()
      } catch (_e) {
        // ignore
      }
    },
    [loadConfig],
  )

  const handleStartEdit = useCallback((template: GestureTemplateConfig) => {
    setEditingTemplate(template)
  }, [])

  const handleEditSave = useCallback(
    async (sequence: number[], patternName: string) => {
      if (!editingTemplate) return
      try {
        await vrmApi.gesture.removeTemplate(editingTemplate.name)
        if (editingTemplate.name !== patternName) {
          const newConfig = { ...config! }
          newConfig.bindings = newConfig.bindings.map((b) =>
            b.gesture_name === editingTemplate.name ? { ...b, gesture_name: patternName } : b,
          )
          await vrmApi.gesture.setConfig(newConfig)
        }
        await vrmApi.gesture.addTemplate({
          name: patternName,
          description: patternName,
          grid_size: 3,
          sequence,
          builtin: false,
        })
        setEditingTemplate(null)
        await loadConfig()
      } catch (_e) {
        // ignore
      }
    },
    [editingTemplate, config, loadConfig],
  )

  const scrollToGroup = useCallback((startNode: number) => {
    const el = groupRefs.current.get(startNode)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  useEffect(() => {
    const el = sectionRef.current
    if (!el) return
    const handleScroll = () => {
      let closest: number | null = null
      let closestDist = Infinity
      for (const [node, ref] of groupRefs.current.entries()) {
        const rect = ref.getBoundingClientRect()
        const containerRect = el.getBoundingClientRect()
        const dist = Math.abs(rect.top - containerRect.top - 80)
        if (dist < closestDist) {
          closestDist = dist
          closest = node
        }
      }
      if (closest !== null) setActiveGroup(closest)
    }
    handleScroll()
    el.addEventListener('scroll', handleScroll, { passive: true })
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  const handleStartEditGroupLabel = useCallback((node: number) => {
    setEditingGroupLabel(node)
    setGroupLabelValue(groupLabels[node] || t('configCenter.gesture.startNode', { node }))
  }, [groupLabels, t])

  const handleSaveGroupLabel = useCallback((node: number) => {
    updateGroupLabel(node, groupLabelValue)
    setEditingGroupLabel(null)
  }, [groupLabelValue, updateGroupLabel])

  const handleGroupLabelKeyDown = useCallback(
    (e: React.KeyboardEvent, node: number) => {
      if (e.key === 'Enter') handleSaveGroupLabel(node)
      if (e.key === 'Escape') setEditingGroupLabel(null)
    },
    [handleSaveGroupLabel],
  )

  const groupedTemplates = useMemo(() => {
    if (!config) return []
    const groups = new Map<number, GestureTemplateConfig[]>()
    for (const t of config.templates) {
      const first = t.sequence.length > 0 ? t.sequence[0] : 0
      if (!groups.has(first)) groups.set(first, [])
      groups.get(first)!.push(t)
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a - b)
      .map(([startNode, templates]) => ({
        startNode,
        templates: templates.sort((a, b) => (a.description || a.name).localeCompare(b.description || b.name)),
      }))
  }, [config])

  if (!config) return null

  return (
    <>
      <ConfigPageSection title={t('configCenter.gesture.customTemplates')}>
        <div className="gesture-settings__template-section-body">
        <div className="gesture-settings__template-scroll-area" ref={sectionRef}>
          {groupedTemplates.map((group) => (
            <div
              key={group.startNode}
              className="gesture-settings__template-group"
              ref={(el) => {
                if (el) groupRefs.current.set(group.startNode, el)
                else groupRefs.current.delete(group.startNode)
              }}
            >
              <div className="gesture-settings__template-group-header">
                {editingGroupLabel === group.startNode ? (
                  <input
                    className="gesture-settings__group-label-input"
                    value={groupLabelValue}
                    onChange={(e) => setGroupLabelValue(e.target.value)}
                    onBlur={() => handleSaveGroupLabel(group.startNode)}
                    onKeyDown={(e) => handleGroupLabelKeyDown(e, group.startNode)}
                    autoFocus
                  />
                ) : (
                  <span
                    className="gesture-settings__template-group-title"
                    onClick={() => handleStartEditGroupLabel(group.startNode)}
                    title={t('configCenter.gesture.clickToRenameGroup')}
                  >
                    {groupLabels[group.startNode] || t('configCenter.gesture.startNode', { node: group.startNode })}
                  </span>
                )}
                <span className="gesture-settings__template-group-count">
                  {group.templates.length}
                </span>
              </div>
              <div className="gesture-settings__template-grid">
              {group.templates.map((template) => (
                <div key={template.name} className="gesture-settings__template-card">
              <div className="gesture-settings__template-preview">
                <PatternPreview
                  name={template.name}
                  sequence={template.sequence}
                  gridSize={template.grid_size}
                  size={56}
                />
              </div>
              <div className="gesture-settings__template-info">
                {editingName === template.name ? (
                  <input
                    className="gesture-settings__name-edit-input"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onBlur={() => handleSaveName(template.name)}
                    onKeyDown={(e) => handleNameKeyDown(e, template.name)}
                    autoFocus
                  />
                ) : (
                  <span
                    className="gesture-settings__template-name"
                    onClick={() => handleStartEditName(template)}
                    title={t('configCenter.gesture.clickToRename')}
                  >
                    {template.description || template.name}
                  </span>
                )}
                <span className="gesture-settings__template-meta">
                  {t('configCenter.gesture.pointCount', { count: template.sequence.length })}
                </span>
              </div>
              <div className="gesture-settings__template-binding">
                <select
                  value={getBinding(template.name).type}
                  onChange={(e) => handleBindingChange(template.name, e.target.value as GestureActionType)}
                >
                  {ACTION_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>{t(ACTION_LABELS[opt])}</option>
                  ))}
                </select>
                {getBinding(template.name).type === 'CustomCommand' && (
                  <input
                    type="text"
                    className="gesture-settings__command-input"
                    placeholder={t('configCenter.gesture.commandPlaceholder')}
                    value={(getBinding(template.name) as { type: string; params?: { command: string } }).params?.command || ''}
                    onChange={(e) => handleBindingChange(template.name, 'CustomCommand', e.target.value)}
                  />
                )}
              </div>
              <div className="gesture-settings__template-actions">
                <button
                  className="gesture-settings__action-btn gesture-settings__action-btn--edit"
                  onClick={() => handleStartEdit(template)}
                >
                  {t('configCenter.gesture.edit')}
                </button>
                <button
                  className="gesture-settings__action-btn gesture-settings__action-btn--delete"
                  onClick={() => handleDeleteTemplate(template.name)}
                >
                  {t('configCenter.gesture.deleteTemplate')}
                </button>
              </div>
            </div>
      ))}
        </div>
      </div>
    ))}
        </div>

        <div className="gesture-settings__group-nav">
          {groupedTemplates.map((group) => (
            <button
              key={group.startNode}
              className={`gesture-settings__group-nav-item ${activeGroup === group.startNode ? 'is-active' : ''}`}
              onClick={() => scrollToGroup(group.startNode)}
              title={groupLabels[group.startNode] || t('configCenter.gesture.startNode', { node: group.startNode })}
            >
              <span className="gesture-settings__group-nav-dot">{group.startNode}</span>
              <span className="gesture-settings__group-nav-label">
                {groupLabels[group.startNode] || t('configCenter.gesture.startNode', { node: group.startNode })}
              </span>
            </button>
          ))}
        </div>
        </div>
  </ConfigPageSection>

      <div className="gesture-settings__record-wrapper">
        <button className="gesture-settings__record-btn" onClick={() => setShowRecorder(true)}>
          {t('configCenter.gesture.recordPattern')}
        </button>
      </div>

      {showRecorder && (
        <PatternRecorder
          initialName={`Pattern-${config.templates.length + 1}`}
          onSave={async (sequence: number[], patternName: string) => {
            const existing = config.templates.find(
              (t) => t.sequence.length === sequence.length && t.sequence.every((v, i) => v === sequence[i])
            )
            if (existing) {
              alert(t('configCenter.gesture.duplicatePattern'))
              return
            }
            try {
              await vrmApi.gesture.addTemplate({
                name: patternName,
                description: patternName,
                grid_size: 3,
                sequence,
                builtin: false,
              })
              setShowRecorder(false)
              await loadConfig()
            } catch (_e) {
              // ignore
            }
          }}
          onCancel={() => setShowRecorder(false)}
        />
      )}

      {editingTemplate && (
        <PatternRecorder
          initialName={editingTemplate.description || editingTemplate.name}
          initialSequence={editingTemplate.sequence}
          onSave={handleEditSave}
          onCancel={() => setEditingTemplate(null)}
        />
      )}
    </>
  )
}

const GestureSettings: React.FC = () => {
  const { t } = useTranslation('settings')
  const { config } = useGestureConfig()

  if (!config) {
    return (
      <ConfigPageLayout>
        <ConfigPageContent>
          <ConfigPageHeader title={t('configCenter.tabs.gesture')} />
          <p>{t('common.loading')}</p>
        </ConfigPageContent>
      </ConfigPageLayout>
    )
  }

  return (
    <ConfigPageLayout>
      <ConfigPageContent>
        <ConfigPageHeader title={t('configCenter.tabs.gesture')} />
        <GestureConfigSection />
        <GestureTemplateSection />
      </ConfigPageContent>
    </ConfigPageLayout>
  )
}

export default GestureSettings