import React, { useState } from 'react'
import { Volume2, Pause, Play, Square, Minimize2, Save, X, Music } from 'lucide-react'
import { useAudioPlayback } from '../hooks/useAudioPlayback'
import type { ChannelInfo } from '../lib/audioPlaybackApi'

export const AudioControlPanel: React.FC = () => {
  const audio = useAudioPlayback()
  const [saveMode, setSaveMode] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveCategory, setSaveCategory] = useState('generated')

  const handleMasterVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    audio.setMasterVolume(v)
  }

  const handleChannelVolumeChange = (id: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value)
    audio.setChannelVolume(id, v)
  }

  const handleSave = () => {
    if (!audio.previewFilePath || !saveName.trim()) return
    audio.saveToLibrary(audio.previewFilePath, saveCategory, saveName.trim(), '')
    setSaveMode(false)
    setSaveName('')
  }

  const getChannelDisplayName = (ch: ChannelInfo): string => {
    if (!ch.source_path) return ch.name
    const normalizedPath = ch.source_path.replace(/\\/g, '/')
    for (const cat of audio.categories) {
      for (const sound of cat.sounds) {
        if (normalizedPath.endsWith(sound.file_path.replace(/\\/g, '/'))) {
          return sound.name
        }
      }
    }
    return ch.name
  }

  return (
    <div className="audio-control-panel">
      {/* Header */}
      <div className="audio-control-header">
        <span className="audio-control-title">音频控制</span>
        <button
          className="audio-icon-btn"
          onClick={() => audio.setOverlayExpanded(false)}
          title="最小化"
        >
          <Minimize2 size={16} />
        </button>
      </div>

      {/* Master Volume */}
      <div className="audio-section">
        <div className="audio-section__title">
          <Volume2 size={14} />
          <span>主音量</span>
          <span className="audio-volume-pct">{Math.round(audio.masterVolume * 100)}%</span>
        </div>
        <input
          type="range"
          className="audio-slider"
          min={0}
          max={1}
          step={0.01}
          value={audio.masterVolume}
          onChange={handleMasterVolumeChange}
        />
      </div>

      {/* BGM Channel */}
      {audio.bgmChannel && (
        <div className="audio-section">
          <div className="audio-section__title">
            <Music size={14} />
            <span>BGM - {audio.bgmChannel.name}</span>
          </div>
          <div className="audio-channel-row">
            <input
              type="range"
              className="audio-slider audio-slider--flex"
              min={0}
              max={1}
              step={0.01}
              value={audio.bgmChannel.volume}
              onChange={(e) => handleChannelVolumeChange(audio.bgmChannel!.id, e)}
            />
            {audio.bgmChannel.state === 'Playing' ? (
              <button
                className="audio-icon-btn"
                onClick={() => audio.pauseChannel(audio.bgmChannel!.id)}
                title="暂停"
              >
                <Pause size={14} />
              </button>
            ) : (
              <button
                className="audio-icon-btn"
                onClick={() => audio.resumeChannel(audio.bgmChannel!.id)}
                title="继续"
              >
                <Play size={14} />
              </button>
            )}
            <button
              className="audio-icon-btn audio-icon-btn--danger"
              onClick={() => audio.stopChannel(audio.bgmChannel!.id)}
              title="停止"
            >
              <Square size={14} />
            </button>
          </div>
        </div>
      )}

      {/* Empty State */}
      {!audio.bgmChannel && audio.sfxChannels.length === 0 && !audio.previewChannel && (
        <div className="audio-empty-state">
          <Volume2 size={24} />
          <span>点击下方"音效库"选择音效</span>
        </div>
      )}

      {/* Active SFX Channels */}
      {audio.sfxChannels.length > 0 && (
        <div className="audio-section">
          <div className="audio-section__title">
            <span>活动音效 ({audio.sfxChannels.length})</span>
            <button
              className="audio-text-btn"
              onClick={() => audio.stopAllSfx()}
            >
              全部停止
            </button>
          </div>
          {audio.sfxChannels.map((ch) => (
            <div key={ch.id} className="audio-channel-row">
              <span className="audio-channel-name">{getChannelDisplayName(ch)}</span>
              <input
                type="range"
                className="audio-slider audio-slider--flex"
                min={0}
                max={1}
                step={0.01}
                value={ch.volume}
                onChange={(e) => handleChannelVolumeChange(ch.id, e)}
              />
              <button
                className="audio-icon-btn audio-icon-btn--danger"
                onClick={() => audio.stopChannel(ch.id)}
                title="停止"
              >
                <Square size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Preview Channel */}
      {audio.previewChannel && (
        <div className="audio-section">
          <div className="audio-section__title">
            <span>试听 - {audio.previewChannel.name}</span>
          </div>
          <div className="audio-channel-row">
            <input
              type="range"
              className="audio-slider audio-slider--flex"
              min={0}
              max={1}
              step={0.01}
              value={audio.previewChannel.volume}
              onChange={(e) => handleChannelVolumeChange(audio.previewChannel!.id, e)}
            />
            <button
              className="audio-icon-btn audio-icon-btn--danger"
              onClick={() => audio.stopPreview()}
              title="停止"
            >
              <Square size={14} />
            </button>
          </div>
          {audio.previewFilePath && !saveMode && (
            <button
              className="audio-action-btn"
              onClick={() => setSaveMode(true)}
            >
              <Save size={14} />
              保存到音效库
            </button>
          )}
          {saveMode && (
            <div className="audio-save-inline">
              <input
                type="text"
                className="audio-save-input"
                placeholder="音效名称"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              />
              <select
                className="audio-save-select"
                value={saveCategory}
                onChange={(e) => setSaveCategory(e.target.value)}
              >
                <option value="generated">自定义</option>
                <option value="nature">自然</option>
                <option value="rain">雨声</option>
                <option value="animals">动物</option>
                <option value="urban">城市</option>
                <option value="places">场所</option>
                <option value="transport">交通</option>
                <option value="things">物品</option>
                <option value="noise">噪音</option>
              </select>
              <button
                className="audio-icon-btn audio-icon-btn--accent"
                onClick={handleSave}
                disabled={!saveName.trim()}
                title="保存"
              >
                <Save size={14} />
              </button>
              <button
                className="audio-icon-btn"
                onClick={() => { setSaveMode(false); setSaveName('') }}
                title="取消"
              >
                <X size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
