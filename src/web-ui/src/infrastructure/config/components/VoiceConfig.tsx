import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { RefreshCw, Mic, MicOff } from 'lucide-react';
import { useInteractionStore } from '@/tools/vrm/store/interactionStore';
import { vrmApi, type AudioDeviceInfo, type EngineInitStatus } from '@/tools/vrm/api/vrmApi';
import {
  ConfigPageLayout,
  ConfigPageContent,
  ConfigPageHeader,
  ConfigPageSection,
  ConfigPageRow,
} from './common';
import './VoiceConfig.scss';

export function VoiceEngineStatusSection() {
  const { t } = useTranslation('settings/voice');
  const [engineStatus, setEngineStatus] = useState<EngineInitStatus | null>(null);
  const [asrReiniting, setAsrReiniting] = useState(false);
  const [ttsReiniting, setTtsReiniting] = useState(false);
  const [audioGenReiniting, setAudioGenReiniting] = useState(false);
  const [audioGenBackend, setAudioGenBackend] = useState<string>('');
  const [reinitError, setReinitError] = useState<string | null>(null);

  const loadEngineStatus = useCallback(async () => {
    try {
      const status = await vrmApi.engine.getInitStatus();
      setEngineStatus(status);
    } catch {
      setEngineStatus(null);
    }
    try {
      const gpuInfo = await invoke<{ cuda_available: boolean; vulkan_available: boolean; recommended_backend: number }>('detect_mnn_gpu');
      const backendName = gpuInfo.recommended_backend === 1 ? 'CUDA' : gpuInfo.recommended_backend === 2 ? 'Vulkan' : 'CPU';
      setAudioGenBackend(backendName);
    } catch {
      setAudioGenBackend('CPU');
    }
  }, []);

  useEffect(() => {
    loadEngineStatus();
  }, [loadEngineStatus]);

  const handleReinitAsr = useCallback(async () => {
    setAsrReiniting(true);
    setReinitError(null);
    try {
      const exeDir = await invoke<string>('get_exe_dir_cmd');
      await vrmApi.engine.reinitAsr(exeDir + '/models/asr');
      await loadEngineStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setReinitError(`ASR: ${msg}`);
    } finally {
      setAsrReiniting(false);
    }
  }, [loadEngineStatus]);

  const handleReinitTts = useCallback(async () => {
    setTtsReiniting(true);
    setReinitError(null);
    try {
      const exeDir = await invoke<string>('get_exe_dir_cmd');
      await vrmApi.engine.reinitTts(exeDir + '/models/tts', 'q4km');
      await loadEngineStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setReinitError(`TTS: ${msg}`);
    } finally {
      setTtsReiniting(false);
    }
  }, [loadEngineStatus]);

  const handleReinitAudioGen = useCallback(async () => {
    setAudioGenReiniting(true);
    setReinitError(null);
    try {
      const exeDir = await invoke<string>('get_exe_dir_cmd');
      const gpuInfo = await invoke<{ cuda_available: boolean; vulkan_available: boolean; recommended_backend: number }>('detect_mnn_gpu');
      await vrmApi.engine.reinitAudioGen(exeDir + '/models/sa3', 'sm-music', gpuInfo.recommended_backend, true, 10.0);
      await loadEngineStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setReinitError(`Audio Gen: ${msg}`);
    } finally {
      setAudioGenReiniting(false);
    }
  }, [loadEngineStatus]);

  return (
    <ConfigPageSection
      title={t('engineStatus.title', { defaultValue: 'Engine Status' })}
      description={t('engineStatus.description', { defaultValue: 'ASR (speech recognition) and TTS (speech synthesis) engine initialization status' })}
    >
      <ConfigPageRow
        label={t('engineStatus.asrLabel')}
        description={t('engineStatus.asrDesc', { defaultValue: 'Speech recognition engine' })}
        align="center"
      >
        <div className="ai00-x-voice-config__engine-row">
          <span className={`ai00-x-voice-config__status ${engineStatus?.asr_initialized ? 'is-running' : 'is-stopped'}`}>
            {engineStatus?.asr_initialized
              ? t('engineStatus.initialized', { defaultValue: 'Initialized' })
              : t('engineStatus.notInitialized', { defaultValue: 'Not Initialized' })}
          </span>
          <button
            type="button"
            className="ai00-x-voice-config__refresh-btn"
            onClick={handleReinitAsr}
            disabled={asrReiniting}
            title={t('engineStatus.reinitAsr', { defaultValue: 'Re-initialize ASR engine' })}
          >
            <RefreshCw size={14} className={asrReiniting ? 'is-spinning' : ''} />
          </button>
        </div>
      </ConfigPageRow>

      <ConfigPageRow
        label={t('engineStatus.ttsLabel')}
        description={t('engineStatus.ttsDesc', { defaultValue: 'Speech synthesis engine' })}
        align="center"
      >
        <div className="ai00-x-voice-config__engine-row">
          <span className={`ai00-x-voice-config__status ${engineStatus?.tts_initialized ? 'is-running' : 'is-stopped'}`}>
            {engineStatus?.tts_initialized
              ? t('engineStatus.initialized', { defaultValue: 'Initialized' })
              : t('engineStatus.notInitialized', { defaultValue: 'Not Initialized' })}
          </span>
          <button
            type="button"
            className="ai00-x-voice-config__refresh-btn"
            onClick={handleReinitTts}
            disabled={ttsReiniting}
            title={t('engineStatus.reinitTts', { defaultValue: 'Re-initialize TTS engine' })}
          >
            <RefreshCw size={14} className={ttsReiniting ? 'is-spinning' : ''} />
          </button>
        </div>
      </ConfigPageRow>

      <ConfigPageRow
        label={t('engineStatus.audioGenLabel')}
        description={t('engineStatus.audioGenDesc', { defaultValue: 'Music and sound effect generation engine' })}
        align="center"
      >
        <div className="ai00-x-voice-config__engine-row">
          <span className={`ai00-x-voice-config__status ${engineStatus?.audio_gen_initialized ? 'is-running' : 'is-stopped'}`}>
            {engineStatus?.audio_gen_initialized
              ? t('engineStatus.initialized', { defaultValue: 'Initialized' })
              : t('engineStatus.notInitialized', { defaultValue: 'Not Initialized' })}
          </span>
          {audioGenBackend && (
            <span className="ai00-x-voice-config__backend-tag">{audioGenBackend}</span>
          )}
          <button
            type="button"
            className="ai00-x-voice-config__refresh-btn"
            onClick={handleReinitAudioGen}
            disabled={audioGenReiniting}
            title={t('engineStatus.reinitAudioGen', { defaultValue: 'Re-initialize Audio Generation engine' })}
          >
            <RefreshCw size={14} className={audioGenReiniting ? 'is-spinning' : ''} />
          </button>
        </div>
      </ConfigPageRow>

      {reinitError && (
        <ConfigPageRow
          label={t('engineStatus.error', { defaultValue: 'Error' })}
          align="center"
        >
          <span className="ai00-x-voice-config__error-text">{reinitError}</span>
        </ConfigPageRow>
      )}
    </ConfigPageSection>
  );
}

export function VoiceDeviceSelectionSection() {
  const { t } = useTranslation('settings/voice');
  const voiceInputConfig = useInteractionStore((s) => s.voiceInputConfig);
  const setVoiceInputConfig = useInteractionStore((s) => s.setVoiceInputConfig);
  const [inputDevices, setInputDevices] = useState<AudioDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);

  const loadAudioDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const [inputs, outputs] = await Promise.all([
        vrmApi.voice.getAudioInputDevices(),
        vrmApi.voice.getAudioOutputDevices(),
      ]);
      setInputDevices(inputs);
      setOutputDevices(outputs);
    } catch (e) {
      console.error('[VoiceConfig] Failed to enumerate devices:', e);
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAudioDevices();
  }, [loadAudioDevices]);

  return (
    <ConfigPageSection
      title={t('deviceSelection.title', { defaultValue: 'Device Selection' })}
      extra={
        <button
          type="button"
          className="ai00-x-voice-config__refresh-btn"
          onClick={loadAudioDevices}
          disabled={devicesLoading}
          title={t('deviceSelection.refresh', { defaultValue: 'Refresh devices' })}
        >
          <RefreshCw size={14} className={devicesLoading ? 'is-spinning' : ''} />
        </button>
      }
    >
      <ConfigPageRow
        label={t('deviceSelection.inputDevice', { defaultValue: 'Input Device (Microphone)' })}
        align="center"
      >
        <select
          className="ai00-x-voice-config__select"
          value={voiceInputConfig.input_device_id}
          onChange={(e) => setVoiceInputConfig({ input_device_id: e.target.value })}
          disabled={devicesLoading}
        >
          <option value="">{t('deviceSelection.defaultDevice', { defaultValue: 'Default Device' })}</option>
          {inputDevices.map((device) => (
            <option key={device.device_id} value={device.device_id}>
              {device.name}{device.is_default ? ` (${t('deviceSelection.defaultDevice')})` : ''}
            </option>
          ))}
        </select>
      </ConfigPageRow>

      <ConfigPageRow
        label={t('deviceSelection.outputDevice', { defaultValue: 'Output Device (Speaker)' })}
        align="center"
      >
        <select
          className="ai00-x-voice-config__select"
          value={voiceInputConfig.output_device_id}
          onChange={(e) => setVoiceInputConfig({ output_device_id: e.target.value })}
          disabled={devicesLoading}
        >
          <option value="">{t('deviceSelection.defaultDevice', { defaultValue: 'Default Device' })}</option>
          {outputDevices.map((device) => (
            <option key={device.device_id} value={device.device_id}>
              {device.name}{device.is_default ? ` (${t('deviceSelection.defaultDevice')})` : ''}
            </option>
          ))}
        </select>
      </ConfigPageRow>
    </ConfigPageSection>
  );
}

export function VoiceInputSection() {
  const { t } = useTranslation('settings/voice');
  const voiceInputConfig = useInteractionStore((s) => s.voiceInputConfig);
  const setVoiceInputConfig = useInteractionStore((s) => s.setVoiceInputConfig);
  const [voiceStatus, setVoiceStatus] = useState<{ running: boolean } | null>(null);

  const loadVoiceStatus = useCallback(async () => {
    try {
      const status = await vrmApi.voice.getStatus();
      setVoiceStatus(status);
    } catch {
      setVoiceStatus(null);
    }
  }, []);

  useEffect(() => {
    loadVoiceStatus();
  }, [loadVoiceStatus]);

  const handleToggleVoiceInput = useCallback(async () => {
    const newEnabled = !voiceInputConfig.enabled;
    setVoiceInputConfig({ enabled: newEnabled });
    try {
      if (newEnabled) {
        await vrmApi.voice.startGlobalVoiceInput();
      } else {
        await vrmApi.voice.stopGlobalVoiceInput();
      }
      setVoiceStatus({ running: newEnabled });
    } catch (e) {
      console.error('[VoiceConfig] Failed to toggle voice input:', e);
      setVoiceInputConfig({ enabled: !newEnabled });
    }
  }, [voiceInputConfig.enabled, setVoiceInputConfig]);

  return (
    <ConfigPageSection title={t('voiceInput.title', { defaultValue: 'Voice Input' })}>
      <ConfigPageRow
        label={t('voiceInput.enabled', { defaultValue: 'Enable Global Voice Input' })}
        description={t('voiceInput.enabledDesc', { defaultValue: 'Long press left mouse button to trigger voice recording' })}
        align="center"
      >
        <button
          type="button"
          className={`ai00-x-voice-config__toggle ${voiceInputConfig.enabled ? 'is-active' : ''}`}
          onClick={handleToggleVoiceInput}
        >
          {voiceInputConfig.enabled ? <Mic size={16} /> : <MicOff size={16} />}
        </button>
      </ConfigPageRow>

      {voiceStatus && (
        <ConfigPageRow
          label={t('voiceInput.status', { defaultValue: 'Service Status' })}
          align="center"
        >
          <span className={`ai00-x-voice-config__status ${voiceStatus.running ? 'is-running' : 'is-stopped'}`}>
            {voiceStatus.running
              ? t('voiceInput.statusRunning', { defaultValue: 'Running' })
              : t('voiceInput.statusStopped', { defaultValue: 'Stopped' })}
          </span>
        </ConfigPageRow>
      )}

      <ConfigPageRow
        label={t('voiceInput.triggerDuration', { defaultValue: 'Trigger Duration' })}
        description={t('voiceInput.triggerDurationDesc', { defaultValue: 'How long to press before recording starts' })}
        align="center"
      >
        <div className="ai00-x-voice-config__slider-row">
          <input
            type="range"
            min={0.3}
            max={2.0}
            step={0.1}
            value={voiceInputConfig.trigger_duration_secs}
            onChange={(e) => setVoiceInputConfig({ trigger_duration_secs: parseFloat(e.target.value) })}
            className="ai00-x-voice-config__slider"
          />
          <span className="ai00-x-voice-config__slider-value">
            {voiceInputConfig.trigger_duration_secs.toFixed(1)}s
          </span>
        </div>
      </ConfigPageRow>

      <ConfigPageRow
        label={t('voiceInput.chargeDelay', { defaultValue: 'Charge Animation Delay' })}
        description={t('voiceInput.chargeDelayDesc', { defaultValue: 'Delay before showing charge animation' })}
        align="center"
      >
        <div className="ai00-x-voice-config__slider-row">
          <input
            type="range"
            min={0.1}
            max={1.0}
            step={0.1}
            value={voiceInputConfig.charge_show_delay_secs}
            onChange={(e) => setVoiceInputConfig({ charge_show_delay_secs: parseFloat(e.target.value) })}
            className="ai00-x-voice-config__slider"
          />
          <span className="ai00-x-voice-config__slider-value">
            {voiceInputConfig.charge_show_delay_secs.toFixed(1)}s
          </span>
        </div>
      </ConfigPageRow>
    </ConfigPageSection>
  );
}

const VoiceConfig: React.FC = () => {
  const { t } = useTranslation('settings/voice');

  return (
    <ConfigPageLayout>
      <ConfigPageHeader
        title={t('title', { defaultValue: 'Voice' })}
        subtitle={t('subtitle', { defaultValue: 'Audio device and voice input settings' })}
      />
      <ConfigPageContent>
        <VoiceEngineStatusSection />
        <VoiceDeviceSelectionSection />
        <VoiceInputSection />
      </ConfigPageContent>
    </ConfigPageLayout>
  );
};

export default VoiceConfig;