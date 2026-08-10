import React, { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfigPageLayout, ConfigPageContent, ConfigPageHeader, ConfigPageSection, ConfigPageRow } from '../../../../infrastructure/config/components/common'
import { useInteractionStore } from '@/tools/vrm/store/interactionStore'
import './ClickEffectSettings.scss'

const ClickEffectSettings: React.FC = () => {
  const { t, i18n } = useTranslation('settings')
  const clickEffectConfig = useInteractionStore((s) => s.clickEffectConfig)
  const setClickEffectConfig = useInteractionStore((s) => s.setClickEffectConfig)
  const resetClickEffectConfig = useInteractionStore((s) => s.resetClickEffectConfig)

  const [newWord, setNewWord] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')

  // Auto-reset blessing words when app language changes
  useEffect(() => {
    const appLang = i18n.language?.startsWith('zh') ? 'zh' : 'en'
    const storedLang = clickEffectConfig.lang
    if (storedLang && storedLang !== appLang) {
      resetClickEffectConfig(i18n.language)
    } else if (!storedLang) {
      // Legacy config without lang field - update lang tag
      setClickEffectConfig({ lang: appLang })
    }
  }, [i18n.language, clickEffectConfig.lang, resetClickEffectConfig, setClickEffectConfig])

  const handleToggleEnabled = useCallback(() => {
    setClickEffectConfig({ enabled: !clickEffectConfig.enabled })
  }, [clickEffectConfig.enabled, setClickEffectConfig])

  const handleAddWord = useCallback(() => {
    const trimmed = newWord.trim()
    if (!trimmed) return
    if (clickEffectConfig.blessingWords.includes(trimmed)) return
    setClickEffectConfig({ blessingWords: [...clickEffectConfig.blessingWords, trimmed] })
    setNewWord('')
  }, [newWord, clickEffectConfig.blessingWords, setClickEffectConfig])

  const handleAddWordKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleAddWord()
  }, [handleAddWord])

  const handleRemoveWord = useCallback((index: number) => {
    const newWords = clickEffectConfig.blessingWords.filter((_, i) => i !== index)
    setClickEffectConfig({ blessingWords: newWords })
  }, [clickEffectConfig.blessingWords, setClickEffectConfig])

  const handleStartEdit = useCallback((index: number) => {
    setEditingIndex(index)
    setEditingValue(clickEffectConfig.blessingWords[index])
  }, [clickEffectConfig.blessingWords])

  const handleSaveEdit = useCallback(() => {
    if (editingIndex === null) return
    const trimmed = editingValue.trim()
    if (!trimmed) {
      handleRemoveWord(editingIndex)
    } else {
      const newWords = [...clickEffectConfig.blessingWords]
      newWords[editingIndex] = trimmed
      setClickEffectConfig({ blessingWords: newWords })
    }
    setEditingIndex(null)
    setEditingValue('')
  }, [editingIndex, editingValue, clickEffectConfig.blessingWords, setClickEffectConfig, handleRemoveWord])

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSaveEdit()
    if (e.key === 'Escape') { setEditingIndex(null); setEditingValue('') }
  }, [handleSaveEdit])

  const handleMinValueChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10)
    if (!isNaN(val) && val >= 0) {
      setClickEffectConfig({ minValue: val })
    }
  }, [setClickEffectConfig])

  const handleMaxValueChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10)
    if (!isNaN(val) && val > 0) {
      setClickEffectConfig({ maxValue: val })
    }
  }, [setClickEffectConfig])

  const handleReset = useCallback(() => {
    resetClickEffectConfig(i18n.language)
  }, [resetClickEffectConfig, i18n.language])

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('clickEffect.title')}
        subtitle={t('clickEffect.subtitle')}
      />
      <ConfigPageContent>
        <ConfigPageSection title="">
          <ConfigPageRow label={t('clickEffect.enabled')} align="center">
            <div className="click-effect-settings__toggle">
              <label className="click-effect-settings__switch">
                <input type="checkbox" checked={clickEffectConfig.enabled} onChange={handleToggleEnabled} />
                <span className="click-effect-settings__slider" />
              </label>
              <span>{clickEffectConfig.enabled ? 'ON' : 'OFF'}</span>
            </div>
          </ConfigPageRow>
        </ConfigPageSection>

        <ConfigPageSection title={t('clickEffect.blessingWords')}>
          <div className="click-effect-settings__section-body">
            <p className="click-effect-settings__hint">{t('clickEffect.blessingWordsHint')}</p>
            <div className="click-effect-settings__words-grid">
              {clickEffectConfig.blessingWords.map((word, index) => (
                <div key={index} className="click-effect-settings__word-chip">
                  {editingIndex === index ? (
                    <input
                      className="click-effect-settings__word-edit-input"
                      value={editingValue}
                      onChange={(e) => setEditingValue(e.target.value)}
                      onBlur={handleSaveEdit}
                      onKeyDown={handleEditKeyDown}
                      autoFocus
                    />
                  ) : (
                    <span
                      className="click-effect-settings__word-text"
                      onClick={() => handleStartEdit(index)}
                      title={t('configCenter.gesture.clickToRename')}
                    >
                      {word}
                    </span>
                  )}
                  <button
                    className="click-effect-settings__word-remove"
                    onClick={() => handleRemoveWord(index)}
                    title="×"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="click-effect-settings__add-word">
              <input
                className="click-effect-settings__add-word-input"
                value={newWord}
                onChange={(e) => setNewWord(e.target.value)}
                onKeyDown={handleAddWordKeyDown}
                placeholder={t('clickEffect.addWordPlaceholder')}
              />
              <button
                className="click-effect-settings__add-word-btn"
                onClick={handleAddWord}
                disabled={!newWord.trim()}
              >
                {t('clickEffect.addWord')}
              </button>
            </div>
          </div>
        </ConfigPageSection>

        <ConfigPageSection title={t('clickEffect.valueRange')}>
          <div className="click-effect-settings__section-body">
            <p className="click-effect-settings__hint">{t('clickEffect.valueRangeHint')}</p>
            <div className="click-effect-settings__range-row">
              <div className="click-effect-settings__range-field">
                <label>{t('clickEffect.minValue')}</label>
                <input
                  type="number"
                  min={0}
                  value={clickEffectConfig.minValue}
                  onChange={handleMinValueChange}
                />
              </div>
              <span className="click-effect-settings__range-separator">~</span>
              <div className="click-effect-settings__range-field">
                <label>{t('clickEffect.maxValue')}</label>
                <input
                  type="number"
                  min={1}
                  value={clickEffectConfig.maxValue}
                  onChange={handleMaxValueChange}
                />
              </div>
            </div>
          </div>
        </ConfigPageSection>

        <ConfigPageSection title="">
          <div className="click-effect-settings__section-body">
            <div className="click-effect-settings__actions">
              <button className="click-effect-settings__reset-btn" onClick={handleReset}>
                {t('clickEffect.resetToDefault')}
              </button>
            </div>
          </div>
        </ConfigPageSection>
      </ConfigPageContent>
    </ConfigPageLayout>
  )
}

export default ClickEffectSettings
