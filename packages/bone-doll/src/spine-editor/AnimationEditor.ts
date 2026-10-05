// ── Keyframe data model ──
export interface Keyframe {
  time: number;
  value?: number;       // rotate (single value)
  x?: number;           // translate.x / scale.x
  y?: number;           // translate.y / scale.y
  curve?: string;       // "stepped" or undefined (linear)
  // 贝塞尔曲线控制点（Spine curve 数组 [cx1, cy1, cx2, cy2] 的归一化坐标）
  // in: 当前关键帧的入曲线控制点（来自前一关键帧的 curve）
  // out: 当前关键帧的出曲线控制点（影响到下一关键帧的插值）
  bezier?: { out: [number, number] };
}

export type BoneChannel = 'rotate' | 'translate' | 'scale' | 'shear';

export interface BoneTrack {
  boneName: string;
  rotate: Keyframe[];
  translate: Keyframe[];
  scale: Keyframe[];
  shear: Keyframe[];
}

export interface EditableAnimation {
  name: string;
  duration: number;
  boneTracks: Map<string, BoneTrack>;
  slotTracks: Map<string, { slotName: string; keyframes: { time: number; attachmentName?: string }[] }>;
  // 所有可编辑的 Extra slot 名（排除核心身体部位 slot）
  // 即使当前动作没有这些 slot 的关键帧，时间轴也会显示这些 slot 轨道
  editableSlotNames: string[];
}

// ── Channel metadata ──
const CHANNEL_KEYS: BoneChannel[] = ['rotate', 'translate', 'scale', 'shear'];

export const CHANNEL_LABELS: Record<BoneChannel, string> = {
  rotate: '旋转',
  translate: '位置',
  scale: '缩放',
  shear: '剪切',
};

export const CHANNEL_COLORS: Record<BoneChannel, string> = {
  rotate: '#ff6b6b',
  translate: '#4ecdc4',
  scale: '#ffe66d',
  shear: '#a29bfe',
};

export function getChannelValueType(channel: BoneChannel): 'scalar' | 'vec2' {
  return channel === 'rotate' ? 'scalar' : 'vec2';
}

// ── AnimationEditor ──
export class AnimationEditor {
  private animation: EditableAnimation | null = null;
  private boneNames: string[] = [];
  // 保存 loadAnimation 的参数，供 fromJSON 复用
  private lastBoneToSlots?: Map<string, string[]>;
  private lastSlotSetupAttachment?: Map<string, string | undefined>;
  private lastEditableSlotNames?: string[];

  loadAnimation(name: string, spineJsonAnim: any, allBoneNames: string[], _boneToSlots?: Map<string, string[]>, _slotSetupAttachment?: Map<string, string | undefined>, editableSlotNames?: string[]): EditableAnimation {
    this.boneNames = allBoneNames;
    this.lastBoneToSlots = _boneToSlots;
    this.lastSlotSetupAttachment = _slotSetupAttachment;
    this.lastEditableSlotNames = editableSlotNames;

    const boneTracks = new Map<string, BoneTrack>();
    const slotTracks = new Map<string, { slotName: string; keyframes: { time: number; attachmentName?: string }[] }>();

    const bonesData = spineJsonAnim.bones || {};
    for (const boneName of allBoneNames) {
      const boneData = bonesData[boneName] || {};
      const track: BoneTrack = {
        boneName,
        rotate: this.normalizeKeyframes(boneData.rotate || [], 'scalar'),
        translate: this.normalizeKeyframes(boneData.translate || [], 'vec2'),
        scale: this.normalizeKeyframes(boneData.scale || [], 'vec2'),
        shear: this.normalizeKeyframes(boneData.shear || [], 'vec2'),
      };
      boneTracks.set(boneName, track);
    }

    const slotsData = spineJsonAnim.slots || {};
    for (const [slotName, slotData] of Object.entries(slotsData as Record<string, any>)) {
      const attachments = (slotData.attachment || []).map((kf: any) => ({
        time: kf.time ?? 0,
        attachmentName: kf.name ?? undefined, // undefined = clear attachment
      }));
      slotTracks.set(slotName, { slotName, keyframes: attachments });
    }

    // Calculate duration from max keyframe time
    let maxTime = 0;
    for (const track of boneTracks.values()) {
      for (const ch of CHANNEL_KEYS) {
        for (const kf of track[ch]) {
          if (kf.time > maxTime) maxTime = kf.time;
        }
      }
    }
    const duration = maxTime > 0 ? maxTime : 1;

    this.animation = {
      name,
      duration,
      boneTracks,
      slotTracks,
      editableSlotNames: editableSlotNames ?? [],
    };

    return this.animation;
  }

  getAnimation(): EditableAnimation | null {
    return this.animation;
  }

  getBoneNames(): string[] {
    return this.boneNames;
  }

  getActiveBoneNames(): string[] {
    if (!this.animation) return [];
    const active: string[] = [];
    for (const [name, track] of this.animation.boneTracks) {
      const hasKeys = CHANNEL_KEYS.some(ch => track[ch].length > 0);
      if (hasKeys) active.push(name);
    }
    return active;
  }

  private normalizeKeyframes(raw: any[], type: 'scalar' | 'vec2'): Keyframe[] {
    if (!raw || raw.length === 0) return [];
    return raw.map((kf: any) => {
      const result: Keyframe = { time: kf.time ?? 0 };
      if (type === 'scalar') {
        // spine 4.3 runtime rotate 读 value 字段（readTimeline1 只读 keyMap.value）；angle 兼容历史数据
        const v = kf.value ?? kf.angle;
        if (v !== undefined) result.value = v;
      }
      if (type === 'vec2') {
        if (kf.x !== undefined) result.x = kf.x;
        if (kf.y !== undefined) result.y = kf.y;
      }
      if (kf.curve === 'stepped') {
        result.curve = 'stepped';
      } else if (Array.isArray(kf.curve) && kf.curve.length === 4) {
        // Spine bezier curve: [cx1, cy1, cx2, cy2] 归一化坐标
        // cx1, cy1 是当前关键帧的出控制点
        result.bezier = { out: [kf.curve[0], kf.curve[1]] };
      }
      return result;
    });
  }

  // ── Keyframe CRUD ──

  addKeyframe(boneName: string, channel: BoneChannel, time: number, value: { value?: number; x?: number; y?: number }): number {
    if (!this.animation) return -1;
    const track = this.animation.boneTracks.get(boneName);
    if (!track) return -1;

    const kf: Keyframe = { time };
    if (value.value !== undefined) kf.value = value.value;
    if (value.x !== undefined) kf.x = value.x;
    if (value.y !== undefined) kf.y = value.y;

    const keyframes = track[channel];
    // Insert sorted by time
    let insertIdx = keyframes.findIndex(k => k.time > time);
    if (insertIdx === -1) insertIdx = keyframes.length;
    keyframes.splice(insertIdx, 0, kf);

    // Update duration if needed
    if (time > this.animation.duration) {
      this.animation.duration = time;
    }

    return insertIdx;
  }

  removeKeyframe(boneName: string, channel: BoneChannel, index: number): boolean {
    if (!this.animation) return false;
    const track = this.animation.boneTracks.get(boneName);
    if (!track || index < 0 || index >= track[channel].length) return false;
    track[channel].splice(index, 1);
    return true;
  }

  moveKeyframe(boneName: string, channel: BoneChannel, index: number, newTime: number): boolean {
    if (!this.animation) return false;
    const track = this.animation.boneTracks.get(boneName);
    if (!track || index < 0 || index >= track[channel].length) return false;

    const kf = track[channel][index];
    kf.time = Math.max(0, newTime);

    // Re-sort
    track[channel].splice(index, 1);
    let insertIdx = track[channel].findIndex(k => k.time > newTime);
    if (insertIdx === -1) insertIdx = track[channel].length;
    track[channel].splice(insertIdx, 0, kf);

    if (newTime > this.animation.duration) {
      this.animation.duration = newTime;
    }
    return true;
  }

  updateKeyframeValue(boneName: string, channel: BoneChannel, index: number, value: { value?: number; x?: number; y?: number }): boolean {
    if (!this.animation) return false;
    const track = this.animation.boneTracks.get(boneName);
    if (!track || index < 0 || index >= track[channel].length) return false;

    const kf = track[channel][index];
    if (value.value !== undefined) kf.value = value.value;
    if (value.x !== undefined) kf.x = value.x;
    if (value.y !== undefined) kf.y = value.y;
    return true;
  }

  setDuration(duration: number): void {
    if (!this.animation) return;
    this.animation.duration = Math.max(0.1, duration);
  }

  // ── Slot Keyframe CRUD ──

  addSlotKeyframe(slotName: string, time: number, attachmentName?: string): number {
    if (!this.animation) return -1;
    let track = this.animation.slotTracks.get(slotName);
    if (!track) {
      track = { slotName, keyframes: [] };
      this.animation.slotTracks.set(slotName, track);
    }
    const kf = { time, attachmentName };
    let insertIdx = track.keyframes.findIndex(k => k.time > time);
    if (insertIdx === -1) insertIdx = track.keyframes.length;
    track.keyframes.splice(insertIdx, 0, kf);
    if (time > this.animation.duration) {
      this.animation.duration = time;
    }
    return insertIdx;
  }

  removeSlotKeyframe(slotName: string, index: number): boolean {
    if (!this.animation) return false;
    const track = this.animation.slotTracks.get(slotName);
    if (!track || index < 0 || index >= track.keyframes.length) return false;
    track.keyframes.splice(index, 1);
    return true;
  }

  moveSlotKeyframe(slotName: string, index: number, newTime: number): boolean {
    if (!this.animation) return false;
    const track = this.animation.slotTracks.get(slotName);
    if (!track || index < 0 || index >= track.keyframes.length) return false;
    const kf = track.keyframes[index];
    track.keyframes.splice(index, 1);
    let insertIdx = track.keyframes.findIndex(k => k.time > newTime);
    if (insertIdx === -1) insertIdx = track.keyframes.length;
    track.keyframes.splice(insertIdx, 0, { ...kf, time: newTime });
    return true;
  }

  updateSlotKeyframe(slotName: string, index: number, attachmentName: string | undefined): boolean {
    if (!this.animation) return false;
    const track = this.animation.slotTracks.get(slotName);
    if (!track || index < 0 || index >= track.keyframes.length) return false;
    track.keyframes[index].attachmentName = attachmentName;
    return true;
  }

  // ── Export ──

  toSpineJSON(): any {
    if (!this.animation) return null;

    const bones: Record<string, any> = {};
    for (const [boneName, track] of this.animation.boneTracks) {
      const boneData: Record<string, any> = {};
      let hasData = false;

      for (const ch of CHANNEL_KEYS) {
        const kfs = track[ch];
        if (kfs.length === 0) continue;
        hasData = true;
        boneData[ch] = kfs.map(kf => {
          const obj: any = { time: kf.time };
          if (getChannelValueType(ch) === 'scalar') {
            // spine 4.3 runtime rotate 读 value 字段
            if (kf.value !== undefined) obj.value = kf.value;
          } else {
            if (kf.x !== undefined) obj.x = kf.x;
            if (kf.y !== undefined) obj.y = kf.y;
          }
          if (kf.curve === 'stepped') {
            obj.curve = 'stepped';
          } else if (kf.bezier?.out) {
            // Spine curve: [cx1, cy1, cx2, cy2]
            // 当前关键帧的 out 控制点是 cx1, cy1
            // 下一关键帧的 in 控制点是 cx2, cy2（默认线性 1, 0）
            obj.curve = [kf.bezier.out[0], kf.bezier.out[1], 1, 0];
          }
          return obj;
        });
      }

      if (hasData) {
        bones[boneName] = boneData;
      }
    }

    // 直接导出 slotTracks 为 slot attachment timeline
    // 所有 slot 显隐通过 attachment 切换关键帧控制（无 visibility 概念）
    const slots: Record<string, any> = {};
    for (const [slotName, data] of this.animation.slotTracks) {
      if (data.keyframes.length === 0) continue;
      slots[slotName] = {
        attachment: data.keyframes.map(kf => {
          const obj: any = { time: kf.time };
          // Only include "name" if attachmentName is defined (non-empty string)
          // undefined means "clear attachment" (same as original Spine format)
          if (kf.attachmentName) {
            obj.name = kf.attachmentName;
          }
          return obj;
        }),
      };
    }

    return {
      ...(Object.keys(bones).length > 0 ? { bones } : {}),
      ...(Object.keys(slots).length > 0 ? { slots } : {}),
    };
  }

  /**
   * 从 Spine 格式的动画数据恢复到编辑器（用于从后端加载动作文件）
   * 复用上次 loadAnimation 的 boneNames 和 slot 参数
   */
  fromJSON(name: string, spineJsonAnim: any): EditableAnimation | null {
    if (this.boneNames.length === 0) {
      console.warn('[AnimationEditor] fromJSON: no boneNames available, call loadAnimation first');
      return null;
    }
    return this.loadAnimation(
      name,
      spineJsonAnim,
      this.boneNames,
      this.lastBoneToSlots,
      this.lastSlotSetupAttachment,
      this.lastEditableSlotNames,
    );
  }
}