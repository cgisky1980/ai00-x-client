import type { AnimationEditor, BoneChannel, Keyframe } from './AnimationEditor';

export interface Command {
  type: string;
  description: string;
  undo(): void;
  redo(): void;
}

export class UndoManager {
  private stack: Command[] = [];
  private pointer: number = -1;
  private maxSize: number = 100;

  get canUndo(): boolean { return this.pointer >= 0; }
  get canRedo(): boolean { return this.pointer < this.stack.length - 1; }

  execute(cmd: Command): void {
    // Discard any redo stack beyond pointer
    this.stack = this.stack.slice(0, this.pointer + 1);
    this.stack.push(cmd);
    if (this.stack.length > this.maxSize) {
      this.stack.shift();
    }
    this.pointer = this.stack.length - 1;
  }

  undo(): boolean {
    if (!this.canUndo) return false;
    this.stack[this.pointer].undo();
    this.pointer--;
    return true;
  }

  redo(): boolean {
    if (!this.canRedo) return false;
    this.pointer++;
    this.stack[this.pointer].redo();
    return true;
  }

  clear(): void {
    this.stack = [];
    this.pointer = -1;
  }
}

// ── Command Implementations ──

export class AddKeyframeCommand implements Command {
  type = 'add-keyframe';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private boneName: string,
    private channel: BoneChannel,
    private time: number,
    private value: { value?: number; x?: number; y?: number },
  ) {
    this.description = `Add KF ${boneName}.${channel}@${time.toFixed(2)}`;
  }

  undo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;
    const kfs = track[this.channel];
    // Find and remove the keyframe at this time
    const idx = kfs.findIndex(k => Math.abs(k.time - this.time) < 0.001);
    if (idx >= 0) kfs.splice(idx, 1);
  }

  redo(): void {
    this.editor.addKeyframe(this.boneName, this.channel, this.time, this.value);
  }
}

export class RemoveKeyframeCommand implements Command {
  type = 'remove-keyframe';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private boneName: string,
    private channel: BoneChannel,
    private keyframe: Keyframe,
    private index: number,
  ) {
    this.description = `Remove KF ${boneName}.${channel}@${keyframe.time.toFixed(2)}`;
  }

  undo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;
    const kfs = track[this.channel];
    // Insert at the original index
    let insertIdx = Math.min(this.index, kfs.length);
    kfs.splice(insertIdx, 0, { ...this.keyframe });
  }

  redo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;
    const kfs = track[this.channel];
    const idx = kfs.findIndex(k => Math.abs(k.time - this.keyframe.time) < 0.001);
    if (idx >= 0) kfs.splice(idx, 1);
  }
}

export class MoveKeyframeCommand implements Command {
  type = 'move-keyframe';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private boneName: string,
    private channel: BoneChannel,
    private oldTime: number,
    private newTime: number,
    private keyframeData: Keyframe,
  ) {
    this.description = `Move KF ${boneName}.${channel} ${oldTime.toFixed(2)}→${newTime.toFixed(2)}`;
  }

  undo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;
    const kfs = track[this.channel];
    const idx = kfs.findIndex(k => Math.abs(k.time - this.newTime) < 0.001);
    if (idx >= 0) {
      kfs.splice(idx, 1);
      let insertIdx = kfs.findIndex(k => k.time > this.oldTime);
      if (insertIdx === -1) insertIdx = kfs.length;
      const restored = { ...this.keyframeData, time: this.oldTime };
      kfs.splice(insertIdx, 0, restored);
    }
  }

  redo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;
    const kfs = track[this.channel];
    const idx = kfs.findIndex(k => Math.abs(k.time - this.oldTime) < 0.001);
    if (idx >= 0) {
      kfs.splice(idx, 1);
      let insertIdx = kfs.findIndex(k => k.time > this.newTime);
      if (insertIdx === -1) insertIdx = kfs.length;
      const moved = { ...this.keyframeData, time: this.newTime };
      kfs.splice(insertIdx, 0, moved);
    }
  }
}

export class UpdateKeyframeValueCommand implements Command {
  type = 'update-keyframe-value';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private boneName: string,
    private channel: BoneChannel,
    private index: number,
    private oldValue: { value?: number; x?: number; y?: number },
    private newValue: { value?: number; x?: number; y?: number },
  ) {
    this.description = `Update KF ${boneName}.${channel}[${index}]`;
  }

  undo(): void {
    this.editor.updateKeyframeValue(this.boneName, this.channel, this.index, this.oldValue);
  }

  redo(): void {
    this.editor.updateKeyframeValue(this.boneName, this.channel, this.index, this.newValue);
  }
}

export class SetDurationCommand implements Command {
  type = 'set-duration';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private oldDuration: number,
    private newDuration: number,
  ) {
    this.description = `Duration ${oldDuration.toFixed(2)}→${newDuration.toFixed(2)}`;
  }

  undo(): void {
    this.editor.setDuration(this.oldDuration);
  }

  redo(): void {
    this.editor.setDuration(this.newDuration);
  }
}

// ── Macro Command（批量操作原子化）──

export class MacroCommand implements Command {
  type = 'macro';
  description: string;

  constructor(
    private commands: Command[],
    description?: string,
  ) {
    this.description = description ?? `Macro (${commands.length} ops)`;
  }

  undo(): void {
    // 逆序撤销
    for (let i = this.commands.length - 1; i >= 0; i--) {
      this.commands[i].undo();
    }
  }

  redo(): void {
    // 正序重做
    for (const cmd of this.commands) {
      cmd.redo();
    }
  }
}

// ── Bezier 曲线控制点更新 ──

export class UpdateBezierCommand implements Command {
  type = 'update-bezier';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private boneName: string,
    private channel: BoneChannel,
    private index: number,
    private oldBezier: { out: [number, number] } | undefined,
    private newBezier: { out: [number, number] } | undefined,
  ) {
    this.description = `Update Bezier ${boneName}.${channel}[${index}]`;
  }

  undo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;
    const kf = track[this.channel][this.index];
    if (kf) {
      if (this.oldBezier) {
        kf.bezier = { ...this.oldBezier };
      } else {
        delete kf.bezier;
      }
    }
  }

  redo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;
    const kf = track[this.channel][this.index];
    if (kf) {
      if (this.newBezier) {
        kf.bezier = { ...this.newBezier };
      } else {
        delete kf.bezier;
      }
    }
  }
}

// ── Slot 关键帧 Commands ──

export class AddSlotKeyframeCommand implements Command {
  type = 'add-slot-keyframe';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private slotName: string,
    private time: number,
    private attachmentName: string | undefined,
  ) {
    this.description = `Add Slot KF ${slotName}@${time.toFixed(2)}`;
  }

  undo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.slotTracks.get(this.slotName);
    if (!track) return;
    const idx = track.keyframes.findIndex(k => Math.abs(k.time - this.time) < 0.001);
    if (idx >= 0) track.keyframes.splice(idx, 1);
  }

  redo(): void {
    this.editor.addSlotKeyframe(this.slotName, this.time, this.attachmentName);
  }
}

export class RemoveSlotKeyframeCommand implements Command {
  type = 'remove-slot-keyframe';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private slotName: string,
    private keyframe: { time: number; attachmentName?: string },
    private index: number,
  ) {
    this.description = `Remove Slot KF ${slotName}@${keyframe.time.toFixed(2)}`;
  }

  undo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    let track = anim.slotTracks.get(this.slotName);
    if (!track) {
      track = { slotName: this.slotName, keyframes: [] };
      anim.slotTracks.set(this.slotName, track);
    }
    let insertIdx = Math.min(this.index, track.keyframes.length);
    track.keyframes.splice(insertIdx, 0, { ...this.keyframe });
  }

  redo(): void {
    this.editor.removeSlotKeyframe(this.slotName, this.index);
  }
}

export class MoveSlotKeyframeCommand implements Command {
  type = 'move-slot-keyframe';
  description: string;

  constructor(
    private editor: AnimationEditor,
    private slotName: string,
    private oldTime: number,
    private newTime: number,
    private keyframeData: { time: number; attachmentName?: string },
  ) {
    this.description = `Move Slot KF ${slotName} ${oldTime.toFixed(2)}→${newTime.toFixed(2)}`;
  }

  undo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.slotTracks.get(this.slotName);
    if (!track) return;
    const idx = track.keyframes.findIndex(k => Math.abs(k.time - this.newTime) < 0.001);
    if (idx >= 0) {
      track.keyframes.splice(idx, 1);
      let insertIdx = track.keyframes.findIndex(k => k.time > this.oldTime);
      if (insertIdx === -1) insertIdx = track.keyframes.length;
      track.keyframes.splice(insertIdx, 0, { ...this.keyframeData, time: this.oldTime });
    }
  }

  redo(): void {
    const anim = this.editor.getAnimation();
    if (!anim) return;
    const track = anim.slotTracks.get(this.slotName);
    if (!track) return;
    const idx = track.keyframes.findIndex(k => Math.abs(k.time - this.oldTime) < 0.001);
    if (idx >= 0) {
      track.keyframes.splice(idx, 1);
      let insertIdx = track.keyframes.findIndex(k => k.time > this.newTime);
      if (insertIdx === -1) insertIdx = track.keyframes.length;
      track.keyframes.splice(insertIdx, 0, { ...this.keyframeData, time: this.newTime });
    }
  }
}