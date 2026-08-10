import React, { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfigPageLayout, ConfigPageContent, ConfigPageHeader } from '../../../../infrastructure/config/components/common'
import { vrmApi } from '@/tools/vrm/api/vrmApi'
import type { SavedAction } from '@/tools/vrm/types'
import { useGestureConfig } from './GestureSettings'
import './GestureSettings.scss'

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

const emptyAction = (): SavedAction => ({
  id: generateId(),
  name: '',
  command: '',
  args: undefined,
  working_dir: undefined,
})

const GestureActionSettings: React.FC = () => {
  const { t } = useTranslation('settings')
  const { config, loadConfig } = useGestureConfig()
  const [isEditing, setIsEditing] = useState(false)
  const [editAction, setEditAction] = useState<SavedAction>(emptyAction())
  const [isNew, setIsNew] = useState(true)

  const savedActions = config?.saved_actions ?? []

  const handleAdd = useCallback(() => {
    setEditAction(emptyAction())
    setIsNew(true)
    setIsEditing(true)
  }, [])

  const handleEdit = useCallback((action: SavedAction) => {
    setEditAction({ ...action })
    setIsNew(false)
    setIsEditing(true)
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await vrmApi.gesture.removeSavedAction(id)
      await loadConfig()
    } catch { /* ignore */ }
  }, [loadConfig])

  const handleSave = useCallback(async () => {
    const trimmed = { ...editAction, name: editAction.name.trim(), command: editAction.command.trim() }
    if (!trimmed.name || !trimmed.command) return
    try {
      if (isNew) {
        await vrmApi.gesture.addSavedAction(trimmed)
      } else {
        await vrmApi.gesture.updateSavedAction(trimmed)
      }
      setIsEditing(false)
      await loadConfig()
    } catch { /* ignore */ }
  }, [editAction, isNew, loadConfig])

  const handleCancel = useCallback(() => {
    setIsEditing(false)
  }, [])

  const updateField = useCallback(
    <K extends keyof SavedAction>(field: K, value: SavedAction[K]) => {
      setEditAction((prev) => ({ ...prev, [field]: value }))
    },
    [],
  )

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('configCenter.tabs.gestureActions')}
        subtitle={t('configCenter.tabDescriptions.gestureActions')}
      />

      <ConfigPageContent>
        <div className="gesture-actions__list">
          {savedActions.length === 0 && !isEditing && (
            <div className="gesture-actions__empty">
              {t('configCenter.gesture.actions.noActions')}
            </div>
          )}

          {savedActions.map((action) => (
            <div key={action.id} className="gesture-actions__card">
              <div className="gesture-actions__card-info">
                <span className="gesture-actions__card-name">{action.name}</span>
                <span className="gesture-actions__card-command">{action.command}</span>
                {action.args && action.args.length > 0 && (
                  <span className="gesture-actions__card-args">
                    {action.args.join(' ')}
                  </span>
                )}
                {action.working_dir && (
                  <span className="gesture-actions__card-dir">{action.working_dir}</span>
                )}
              </div>
              <div className="gesture-actions__card-actions">
                <button
                  className="gesture-settings__action-btn gesture-settings__action-btn--edit"
                  onClick={() => handleEdit(action)}
                >
                  {t('configCenter.gesture.edit')}
                </button>
                <button
                  className="gesture-settings__action-btn gesture-settings__action-btn--delete"
                  onClick={() => handleDelete(action.id)}
                >
                  {t('configCenter.gesture.actions.deleteAction')}
                </button>
              </div>
            </div>
          ))}

          {isEditing && (
            <div className="gesture-actions__editor">
              <div className="gesture-actions__editor-title">
                {isNew
                  ? t('configCenter.gesture.actions.addAction')
                  : t('configCenter.gesture.actions.editAction')}
              </div>

              <div className="gesture-actions__field">
                <label className="gesture-actions__label">
                  {t('configCenter.gesture.actions.actionName')}
                </label>
                <input
                  type="text"
                  className="gesture-actions__input"
                  value={editAction.name}
                  onChange={(e) => updateField('name', e.target.value)}
                  placeholder={t('configCenter.gesture.actions.actionName')}
                />
              </div>

              <div className="gesture-actions__field">
                <label className="gesture-actions__label">
                  {t('configCenter.gesture.actions.command')}
                </label>
                <input
                  type="text"
                  className="gesture-actions__input"
                  value={editAction.command}
                  onChange={(e) => updateField('command', e.target.value)}
                  placeholder={t('configCenter.gesture.actions.command')}
                />
              </div>

              <div className="gesture-actions__field">
                <label className="gesture-actions__label">
                  {t('configCenter.gesture.actions.args')}
                </label>
                <input
                  type="text"
                  className="gesture-actions__input"
                  value={editAction.args?.join(' ') ?? ''}
                  onChange={(e) => {
                    const val = e.target.value.trim()
                    updateField('args', val ? val.split(/\s+/) : undefined)
                  }}
                  placeholder={t('configCenter.gesture.actions.args')}
                />
              </div>

              <div className="gesture-actions__field">
                <label className="gesture-actions__label">
                  {t('configCenter.gesture.actions.workingDir')}
                </label>
                <input
                  type="text"
                  className="gesture-actions__input"
                  value={editAction.working_dir ?? ''}
                  onChange={(e) => updateField('working_dir', e.target.value || undefined)}
                  placeholder={t('configCenter.gesture.actions.workingDir')}
                />
              </div>

              <div className="gesture-actions__editor-buttons">
                <button className="gesture-settings__action-btn gesture-settings__action-btn--edit" onClick={handleSave}>
                  {t('configCenter.gesture.save')}
                </button>
                <button className="gesture-settings__action-btn gesture-settings__action-btn--delete" onClick={handleCancel}>
                  {t('configCenter.gesture.cancel')}
                </button>
              </div>
            </div>
          )}
        </div>

        {!isEditing && (
          <div className="gesture-actions__add-wrapper">
            <button className="gesture-settings__record-btn" onClick={handleAdd}>
              {t('configCenter.gesture.actions.addAction')}
            </button>
          </div>
        )}
      </ConfigPageContent>
    </ConfigPageLayout>
  )
}

export default GestureActionSettings