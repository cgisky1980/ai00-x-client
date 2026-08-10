import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { vrmApi } from '@/tools/vrm/api/vrmApi'
import type { GestureActionType, GestureTemplateConfig, GestureBinding, SavedAction } from '@/tools/vrm/types'
import { useGestureConfig, useGroupLabels, ACTION_LABELS, ACTION_OPTIONS } from './GestureSettings'
import PatternRecorder from './PatternRecorder'
import PatternPreview from './PatternPreview'
import { ConfigPageLayout, ConfigPageContent, ConfigPageHeader } from '../../../../infrastructure/config/components/common'
import './GestureSettings.scss'

const GestureTemplateSettings: React.FC = () => {
  const { t } = useTranslation('settings')
  const { config, loadConfig, saveConfig } = useGestureConfig()
  const [groupLabels, updateGroupLabel] = useGroupLabels()
  const [showRecorder, setShowRecorder] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<GestureTemplateConfig | null>(null)
  const [editingName, setEditingName] = useState<string | null>(null)
  const [nameValue, setNameValue] = useState('')
  const [editingGroupLabel, setEditingGroupLabel] = useState<number | null>(null)
  const [groupLabelValue, setGroupLabelValue] = useState('')
  const [activeGroup, setActiveGroup] = useState<number | null>(null)
  const groupRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const SAVED_ACTION_PREFIX = '__saved__:'

  const handleBindingChange = useCallback(
    (gestureName: string, actionType: GestureActionType, command?: string) => {
      if (!config) return
      const bindings = config.bindings.filter((b: GestureBinding) => b.gesture_name !== gestureName)
      const action: { type: GestureActionType; params?: { command: string } } = { type: actionType }
      if (actionType === 'CustomCommand' && command) {
        action.params = { command }
      }
      bindings.push({ gesture_name: gestureName, action })
      saveConfig({ ...config, bindings })
    },
    [config, saveConfig],
  )

  const handleSelectChange = useCallback(
    (gestureName: string, value: string) => {
      if (value.startsWith(SAVED_ACTION_PREFIX)) {
        const actionId = value.slice(SAVED_ACTION_PREFIX.length)
        const savedAction = config?.saved_actions.find((a: SavedAction) => a.id === actionId)
        if (savedAction) {
          handleBindingChange(gestureName, 'CustomCommand', savedAction.command)
        }
      } else {
        handleBindingChange(gestureName, value as GestureActionType)
      }
    },
    [config, handleBindingChange],
  )

  const getBinding = (gestureName: string) => {
    if (!config) return { type: 'None' as GestureActionType }
    const b = config.bindings.find((b: GestureBinding) => b.gesture_name === gestureName)
    return b ? b.action : { type: 'None' as GestureActionType }
  }

  const getSelectValue = (gestureName: string): string => {
    const binding = getBinding(gestureName)
    if (binding.type === 'CustomCommand' && binding.params?.command) {
      const cmd = binding.params.command as string
      const savedAction = config?.saved_actions.find((a: SavedAction) => a.command === cmd)
      if (savedAction) {
        return SAVED_ACTION_PREFIX + savedAction.id
      }
    }
    return binding.type
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
    const idx = newConfig.templates.findIndex((t: GestureTemplateConfig) => t.name === oldName)
    if (idx < 0) return
    newConfig.templates = [...newConfig.templates]
    newConfig.templates[idx] = { ...newConfig.templates[idx], name: trimmed, description: trimmed }
    newConfig.bindings = newConfig.bindings.map((b: GestureBinding) =>
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
      } catch { /* ignore */ }
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
          newConfig.bindings = newConfig.bindings.map((b: GestureBinding) =>
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
      } catch { /* ignore */ }
    },
    [editingTemplate, config, loadConfig],
  )

  const scrollToGroup = useCallback((startNode: number) => {
    const el = groupRefs.current.get(startNode)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
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

  useEffect(() => {
    if (groupedTemplates.length === 0) return
    const onScroll = () => {
      let closest: number | null = null
      let closestDist = Infinity
      for (const [node, ref] of groupRefs.current.entries()) {
        const rect = ref.getBoundingClientRect()
        const dist = Math.abs(rect.top - 100)
        if (dist < closestDist) {
          closestDist = dist
          closest = node
        }
      }
      if (closest !== null) setActiveGroup(closest)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [groupedTemplates])

  if (!config) return null

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('configCenter.tabs.gestureTemplates')}
        subtitle={t('configCenter.gesture.templateSubtitle')}
      />

      <ConfigPageContent className="gesture-settings__template-page">
        <div className="gesture-settings__template-main">
          {groupedTemplates.map((group) => (
            <div
              key={group.startNode}
              className="gesture-settings__group-area"
              ref={(el) => {
                if (el) groupRefs.current.set(group.startNode, el)
                else groupRefs.current.delete(group.startNode)
              }}
            >
              <div className="gesture-settings__group-header">
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
                    className="gesture-settings__group-tag"
                    onClick={() => handleStartEditGroupLabel(group.startNode)}
                    title={t('configCenter.gesture.clickToRenameGroup')}
                  >
                    {groupLabels[group.startNode] || t('configCenter.gesture.startNode', { node: group.startNode })}
                  </span>
                )}
                <span className="gesture-settings__group-count">
                  {t('configCenter.gesture.templateCount', { count: group.templates.length })}
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
                        showSequenceNumbers
                      />
                    </div>
                    <div className="gesture-settings__template-detail">
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
                        <label className="gesture-settings__binding-label">
                          {t('configCenter.gesture.bindAction')}
                        </label>
                        <select
                          className="gesture-settings__binding-select"
                          value={getSelectValue(template.name)}
                          onChange={(e) => handleSelectChange(template.name, e.target.value)}
                        >
                          {ACTION_OPTIONS.map((opt: GestureActionType) => (
                            <option key={opt} value={opt}>{t(ACTION_LABELS[opt])}</option>
                          ))}
                          {config.saved_actions.length > 0 && (
                            <optgroup label={t('configCenter.gesture.actions.savedActions')}>
                              {config.saved_actions.map((a: SavedAction) => (
                                <option key={a.id} value={SAVED_ACTION_PREFIX + a.id}>{a.name}</option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      </div>

                      {getBinding(template.name).type === 'CustomCommand' && (
                        <div className="gesture-settings__template-binding">
                          <label className="gesture-settings__binding-label">
                            {t('configCenter.gesture.commandPlaceholder')}
                          </label>
                          <input
                            type="text"
                            className="gesture-settings__command-input"
                            value={(getBinding(template.name) as { type: string; params?: { command: string } }).params?.command || ''}
                            onChange={(e) => handleBindingChange(template.name, 'CustomCommand', e.target.value)}
                          />
                        </div>
                      )}

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
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <nav className="gesture-settings__template-side-nav">
          <div className="gesture-settings__side-nav-inner">
            {groupedTemplates.map((group) => (
              <button
                key={group.startNode}
                className={`gesture-settings__side-nav-item ${activeGroup === group.startNode ? 'is-active' : ''}`}
                onClick={() => scrollToGroup(group.startNode)}
                title={groupLabels[group.startNode] || t('configCenter.gesture.startNode', { node: group.startNode })}
              >
                <span className="gesture-settings__side-nav-dot">{group.startNode}</span>
                <span className="gesture-settings__side-nav-label">
                  {groupLabels[group.startNode] || t('configCenter.gesture.startNode', { node: group.startNode })}
                </span>
                <span className="gesture-settings__side-nav-count">{group.templates.length}</span>
              </button>
            ))}
          </div>
        </nav>
      </ConfigPageContent>

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
              (t: GestureTemplateConfig) => t.sequence.length === sequence.length && t.sequence.every((v: number, i: number) => v === sequence[i])
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
            } catch { /* ignore */ }
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
    </ConfigPageLayout>
  )
}

export default GestureTemplateSettings