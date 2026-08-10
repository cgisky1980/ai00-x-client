import React, { useState } from 'react'
import { Save, Loader2, Plus, Music, Wand2 } from 'lucide-react'
import { useAudioPlayback } from '../hooks/useAudioPlayback'
import { useI18n } from '../../../infrastructure/i18n'
import { audioPlaybackApi } from '../lib/audioPlaybackApi'

type GenSubTab = 'music' | 'sfx'

interface AudioGenPanelProps {
  variant: 'music' | 'sfx'
}

export const AudioGenPanel: React.FC<AudioGenPanelProps> = () => {
  const audio = useAudioPlayback()
  const { t } = useI18n('vrm')
  const [subTab, setSubTab] = useState<GenSubTab>('music')
  const isMusic = subTab === 'music'

  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [duration, setDuration] = useState(isMusic ? 10 : 5)
  const [error, setError] = useState<string | null>(null)
  const [saveMode, setSaveMode] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveCategory, setSaveCategory] = useState('generated')

  const handleGenerate = async () => {
    if (!prompt.trim() || audio.generating) return

    setError(null)
    audio.setPreviewFilePath(null)
    audio.setGenerating(true)

    try {
      const result = await audioPlaybackApi.generateAudio({
        prompt: prompt.trim(),
        negative_prompt: negativePrompt.trim(),
        duration: Math.max(1, Math.min(120, duration)),
        steps: 8,
        cfg_scale: 1.0,
        seed: null,
        variant: isMusic ? 'sm-music' : 'sm-sfx',
      })

      try {
        await audio.playPreview(result.file_path, 0.5)
      } catch {
        // preview failure is non-critical
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('not initialized')) {
        setError(t('audio.create.engineNotInitialized'))
      } else {
        setError(msg)
      }
    } finally {
      audio.setGenerating(false)
    }
  }

  const handleSave = () => {
    if (!audio.previewFilePath || !saveName.trim()) return
    audio.saveToLibrary(audio.previewFilePath, saveCategory, saveName.trim(), prompt.trim())
    setSaveMode(false)
    setSaveName('')
  }

  const handleAddToPlaylist = () => {
    if (!audio.previewFilePath) return
    const name = prompt.trim().slice(0, 30) || 'Generated Music'
    audio.addToPlaylist({
      id: `gen-${Date.now()}`,
      name,
      filePath: audio.previewFilePath,
      source: 'generated',
      prompt: prompt.trim(),
    })
  }

  return (
    <div className="audio-gen-panel">
      {/* Sub-tab switcher: Music / SFX */}
      <div className="audio-gen-subtabs">
        <button
          className={`audio-gen-subtab ${isMusic ? 'audio-gen-subtab--active' : ''}`}
          onClick={() => setSubTab('music')}
        >
          <Music size={12} />
          <span>{t('audio.create.music')}</span>
        </button>
        <button
          className={`audio-gen-subtab ${!isMusic ? 'audio-gen-subtab--active' : ''}`}
          onClick={() => setSubTab('sfx')}
        >
          <Wand2 size={12} />
          <span>{t('audio.create.sfx')}</span>
        </button>
      </div>

      {/* Prompt */}
      <div className="audio-gen-field">
        <label className="audio-gen-label">{t('audio.create.prompt')}</label>
        <textarea
          className="audio-gen-textarea"
          placeholder={isMusic ? t('audio.create.promptPlaceholderMusic') : t('audio.create.promptPlaceholderSfx')}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
        />
      </div>

      {/* Negative Prompt */}
      <div className="audio-gen-field">
        <label className="audio-gen-label">{t('audio.create.negativePrompt')}</label>
        <input
          type="text"
          className="audio-gen-input"
          placeholder={t('audio.create.negativePromptPlaceholder')}
          value={negativePrompt}
          onChange={(e) => setNegativePrompt(e.target.value)}
        />
      </div>

      {/* Duration */}
      <div className="audio-gen-field">
        <label className="audio-gen-label">{t('audio.create.duration')}</label>
        <input
          type="number"
          className="audio-gen-input"
          min={1}
          max={120}
          value={duration}
          onChange={(e) => setDuration(parseInt(e.target.value) || (isMusic ? 10 : 5))}
        />
      </div>

      {/* Error */}
      {error && (
        <div className="audio-gen-error">{error}</div>
      )}

      {/* Generate Button */}
      <button
        className="audio-gen-button"
        onClick={handleGenerate}
        disabled={!prompt.trim() || audio.generating}
      >
        {audio.generating ? (
          <>
            <Loader2 size={16} className="audio-gen-spinner" />
            {t('audio.create.generating')}
          </>
        ) : (
          isMusic ? t('audio.create.generateMusic') : t('audio.create.generateSfx')
        )}
      </button>

      {/* Result actions */}
      {audio.previewFilePath && !audio.generating && (
        <div className="audio-gen-result">
          <span className="audio-gen-result-text">{t('audio.create.generated')}</span>
          <div className="audio-gen-result-actions">
            {isMusic && (
              <button
                className="audio-action-btn audio-action-btn--playlist"
                onClick={handleAddToPlaylist}
              >
                <Plus size={14} />
                {t('audio.create.addToPlaylist')}
              </button>
            )}
            {!saveMode ? (
              <button
                className="audio-action-btn"
                onClick={() => setSaveMode(true)}
              >
                <Save size={14} />
                {t('audio.create.saveToLibrary')}
              </button>
            ) : (
              <div className="audio-save-inline">
                <input
                  type="text"
                  className="audio-save-input"
                  placeholder={t('audio.create.saveName')}
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                />
                <select
                  className="audio-save-select"
                  value={saveCategory}
                  onChange={(e) => setSaveCategory(e.target.value)}
                >
                  <option value="generated">Custom</option>
                  <option value="nature">Nature</option>
                  <option value="rain">Rain</option>
                  <option value="animals">Animals</option>
                  <option value="urban">Urban</option>
                  <option value="places">Places</option>
                  <option value="transport">Transport</option>
                  <option value="things">Things</option>
                  <option value="noise">Noise</option>
                </select>
                <button
                  className="audio-icon-btn audio-icon-btn--accent"
                  onClick={handleSave}
                  disabled={!saveName.trim()}
                  title={t('audio.create.save')}
                >
                  <Save size={14} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
