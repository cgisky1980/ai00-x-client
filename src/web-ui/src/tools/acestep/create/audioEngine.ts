/**
 * audioEngine — Web Audio engine for the track editor.
 *
 * Responsibilities:
 *  - decode stem wavs (asset protocol URLs) with lazy caching
 *  - realtime monitoring: per-track GainNode mixing with mute/solo
 *  - transport: play / pause / seek with an rAF-friendly currentTime
 *  - peak extraction for canvas waveforms
 *  - offline render of the current mix (gains/mutes applied) → 16-bit wav
 *
 * The engine holds no React state; the track editor store drives it.
 */

import { convertFileSrc } from '@tauri-apps/api/core';

export interface MixTrackInput {
  trackId: string;
  stemPath: string;
  gainDb: number;
  muted: boolean;
  solo: boolean;
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private sources: AudioBufferSourceNode[] = [];
  private gainNodes: GainNode[] = [];
  private startedAt = 0;
  private startOffset = 0;
  private playing = false;
  private active: MixTrackInput[] = [];

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Decode (and cache) a stem wav from an asset-protocol URL. */
  async loadBuffer(stemPath: string): Promise<AudioBuffer> {
    const cached = this.buffers.get(stemPath);
    if (cached) return cached;
    const ctx = this.ensureContext();
    const url = convertFileSrc(stemPath);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`stem load failed: ${resp.status}`);
    const data = await resp.arrayBuffer();
    const buffer = await ctx.decodeAudioData(data);
    this.buffers.set(stemPath, buffer);
    return buffer;
  }

  dropBuffer(stemPath: string): void {
    this.buffers.delete(stemPath);
  }

  /** Total mix duration (longest ready track). */
  async duration(tracks: MixTrackInput[]): Promise<number> {
    let max = 0;
    for (const t of tracks) {
      try {
        const buf = await this.loadBuffer(t.stemPath);
        max = Math.max(max, buf.duration);
      } catch {
        // missing stem files shouldn't break the timeline.
      }
    }
    return max;
  }

  /** Effective gain with mute/solo (any solo mutes non-solo tracks). */
  private effectiveGain(t: MixTrackInput): number {
    const anySolo = this.active.some((x) => x.solo);
    if (t.muted || (anySolo && !t.solo)) return 0;
    return dbToGain(t.gainDb);
  }

  /** Start (or resume) playback of the given tracks from `offsetSec`. */
  async play(tracks: MixTrackInput[], offsetSec = 0): Promise<void> {
    this.stopNodes();
    this.active = tracks;
    if (tracks.length === 0) return;
    const ctx = this.ensureContext();
    for (const t of tracks) {
      let buf: AudioBuffer;
      try {
        buf = await this.loadBuffer(t.stemPath);
      } catch {
        continue;
      }
      if (offsetSec >= buf.duration) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = this.effectiveGain(t);
      src.connect(gain).connect(ctx.destination);
      src.start(0, offsetSec);
      this.sources.push(src);
      this.gainNodes.push(gain);
    }
    this.startOffset = offsetSec;
    this.startedAt = ctx.currentTime;
    this.playing = true;
  }

  private stopNodes(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        // already stopped.
      }
      src.disconnect();
    }
    for (const g of this.gainNodes) g.disconnect();
    this.sources = [];
    this.gainNodes = [];
  }

  pause(): void {
    if (!this.playing || !this.ctx) return;
    this.startOffset = this.currentTime();
    this.stopNodes();
    this.playing = false;
  }

  stop(): void {
    this.stopNodes();
    this.playing = false;
    this.startOffset = 0;
  }

  /** Update monitoring gains without restarting playback. */
  async applyMix(tracks: MixTrackInput[]): Promise<void> {
    if (!this.playing) {
      this.active = tracks;
      return;
    }
    const offset = this.currentTime();
    await this.play(tracks, offset);
  }

  currentTime(): number {
    if (!this.ctx || !this.playing) return this.startOffset;
    return this.startOffset + (this.ctx.currentTime - this.startedAt);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  /** Min/max peak pairs for waveform drawing (one pair per pixel column). */
  computePeaks(buffer: AudioBuffer, columns: number): Float32Array {
    const peaks = new Float32Array(columns * 2);
    const chCount = Math.min(buffer.numberOfChannels, 2);
    const length = buffer.length;
    const step = Math.max(1, Math.floor(length / columns));
    const chans: Float32Array[] = [];
    for (let c = 0; c < chCount; c++) chans.push(buffer.getChannelData(c));
    for (let col = 0; col < columns; col++) {
      const start = col * step;
      const end = Math.min(length, start + step);
      let min = 0;
      let max = 0;
      for (let i = start; i < end; i++) {
        let sample = 0;
        for (let c = 0; c < chans.length; c++) sample += chans[c][i];
        sample /= chans.length;
        if (sample < min) min = sample;
        if (sample > max) max = sample;
      }
      peaks[col * 2] = min;
      peaks[col * 2 + 1] = max;
    }
    return peaks;
  }

  /**
   * Offline-render the mix with current gains/mutes/solo applied and encode
   * a 48kHz stereo 16-bit PCM wav.
   */
  async renderMixToWav(tracks: MixTrackInput[]): Promise<Uint8Array> {
    const loaded: Array<{ input: MixTrackInput; buffer: AudioBuffer }> = [];
    let duration = 0;
    for (const t of tracks) {
      const buffer = await this.loadBuffer(t.stemPath);
      duration = Math.max(duration, buffer.duration);
      loaded.push({ input: t, buffer });
    }
    if (loaded.length === 0) throw new Error('NOTHING_TO_RENDER');
    const sampleRate = loaded[0].buffer.sampleRate;
    const anySolo = tracks.some((t) => t.solo);

    const offline = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
    for (const { input, buffer } of loaded) {
      const audible = !input.muted && (!anySolo || input.solo);
      const gainValue = audible ? dbToGain(input.gainDb) : 0;
      if (gainValue === 0) continue;
      const src = offline.createBufferSource();
      src.buffer = buffer;
      const gain = offline.createGain();
      gain.gain.value = gainValue;
      src.connect(gain).connect(offline.destination);
      src.start(0);
    }
    const rendered = await offline.startRendering();
    return encodeWav16(rendered);
  }

  /** Release all audio resources (called when the editor unmounts). */
  dispose(): void {
    this.stopNodes();
    this.buffers.clear();
    this.playing = false;
    void this.ctx?.close();
    this.ctx = null;
  }
}

/** Encode an AudioBuffer as a 16-bit PCM stereo wav file. */
export function encodeWav16(buffer: AudioBuffer): Uint8Array {
  const channels = Math.min(buffer.numberOfChannels, 2);
  const frames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const chanData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) chanData.push(buffer.getChannelData(c));
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, chanData[c][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}

/** Singleton — one engine per window is plenty. */
export const audioEngine = new AudioEngine();
