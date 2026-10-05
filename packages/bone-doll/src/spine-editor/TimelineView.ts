import { AnimationEditor, BoneChannel } from './AnimationEditor';

const CHANNELS: BoneChannel[] = ['rotate', 'translate', 'scale', 'shear'];

const LABEL_WIDTH = 120;
const RULER_HEIGHT = 24;
const BONE_TRACK_HEIGHT = 22;  // 每个骨骼一行的高度
const TRACK_GAP = 2;
const KEYFRAME_SIZE = 6;
const PLAYHEAD_HANDLE_SIZE = 8;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;

export interface KfSelection {
  boneName: string;
  channel: BoneChannel;
  keyframeIndex: number;
}

export interface TimelineEvent {
  type: 'select-keyframe' | 'multi-select-keyframe' | 'add-keyframe' | 'move-keyframe' | 'move-keyframe-end' | 'multi-move-keyframe' | 'multi-move-keyframe-end' | 'delete-keyframe' | 'multi-delete-keyframe' | 'seek';
  boneName?: string;
  channel?: BoneChannel;
  keyframeIndex?: number;
  selections?: KfSelection[];
  time?: number;
  oldTime?: number;
  value?: { value?: number; x?: number; y?: number };
  timeDelta?: number;
  // 多选拖拽结束时的移动信息
  moves?: { boneName: string; channel: BoneChannel; oldTime: number; newTime: number }[];
}

// Clipboard for copy/paste
interface ClipboardEntry {
  time: number;
  value?: number;
  x?: number;
  y?: number;
  curve?: string;
}

export class TimelineView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private container: HTMLElement;
  private editor: AnimationEditor;
  private onEvent: (event: TimelineEvent) => void;

  // 树形轨道布局缓存
  // 每个元素：{ type: 'bone'|'slot', name, boneName, depth }
  // bone 节点：name=boneName, boneName=boneName
  // slot 节点：name=slotName, boneName=所属骨骼名
  private trackLayout: Array<{ type: 'bone' | 'slot'; name: string; boneName: string; depth: number }> = [];
  // boneName -> slotNames 映射（从 SpineManager 获取）
  private boneToSlotsMap: Map<string, string[]> = new Map();

  // View state
  private scrollX = 0;
  private zoom = 1;
  private playheadTime = 0;
  private selectedBone: string | null = null;
  private selectedChannel: BoneChannel | null = null;
  private selectedKfIndex: number = -1;
  private multiSelections: KfSelection[] = [];

  // Drag state
  private dragging: 'keyframe' | 'multi-keyframe' | 'playhead' | 'pan' | 'box-select' | 'slot-keyframe' | null = null;
  private dragBone: string | null = null;
  private dragChannel: BoneChannel | null = null;
  private dragKfIndex: number = -1;
  private dragStartX = 0;
  private dragStartTime = 0;
  private dragOriginalTime = 0;  // 拖动开始时的原始时间（用于 Undo，不被 mousemove 更新）
  private lastMouseX = 0;
  private lastMouseY = 0;
  private multiDragStartTimes: Map<string, number> = new Map(); // key: "boneName|channel|index"

  // Box select
  private boxSelectStartX = 0;
  private boxSelectStartY = 0;

  // Clipboard
  private clipboard: ClipboardEntry[] = [];

  constructor(
    container: HTMLElement,
    editor: AnimationEditor,
    onEvent: (event: TimelineEvent) => void,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.setAttribute('tabindex', '0'); // Allow keyboard focus
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 上下文');
    this.ctx = ctx;

    this.container = container;
    this.editor = editor;
    this.onEvent = onEvent;

    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('dblclick', this.onDblClick);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('keydown', this.onKeyDown);

    // 延迟 resize，确保 canvas 已被布局
    requestAnimationFrame(() => this.resize());
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const containerRect = this.container.getBoundingClientRect();
    const totalHeight = this.getTotalHeight();
    const totalWidth = this.getTotalWidth();
    const dpr = window.devicePixelRatio || 1;
    // canvas 宽度 = max(容器可见宽度, 内容总宽度)，让容器水平滚动
    // canvas 高度 = max(容器可见高度, 内容总高度)，让容器垂直滚动
    const cssWidth = Math.max(containerRect.width, totalWidth);
    const cssHeight = Math.max(containerRect.height, totalHeight);
    this.canvas.width = cssWidth * dpr;
    this.canvas.height = cssHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.canvas.style.width = cssWidth + 'px';
    this.canvas.style.height = cssHeight + 'px';
    this.render();
  }

  setPlayhead(time: number): void {
    this.playheadTime = time;
    this.render();
  }

  // 缩放时间轴（factor > 1 放大，< 1 缩小），以播放头为中心
  zoomBy(factor: number): void {
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    // 以播放头为中心缩放
    const phX = this.timeToX(this.playheadTime);
    const timeAtPh = this.xToTime(phX);
    this.scrollX = timeAtPh * this.pixelsPerSecond() - (phX - LABEL_WIDTH);
    this.scrollX = Math.max(0, this.scrollX);
    this.resize();
    this.render();
  }

  // 重置缩放到 1
  zoomReset(): void {
    this.zoom = 1;
    this.scrollX = 0;
    this.resize();
    this.render();
  }

  setSelected(boneName: string | null, channel: BoneChannel | null, kfIndex: number): void {
    this.selectedBone = boneName;
    this.selectedChannel = channel;
    this.selectedKfIndex = kfIndex;
    this.multiSelections = [];
    this.render();
  }

  setMultiSelections(selections: KfSelection[]): void {
    this.multiSelections = selections;
    if (selections.length === 1) {
      this.selectedBone = selections[0].boneName;
      this.selectedChannel = selections[0].channel;
      this.selectedKfIndex = selections[0].keyframeIndex;
    } else {
      this.selectedBone = null;
      this.selectedChannel = null;
      this.selectedKfIndex = -1;
    }
    this.render();
  }

  getMultiSelections(): KfSelection[] {
    return this.multiSelections;
  }

  // ── Coordinate helpers ──

  private timeToX(time: number): number {
    return LABEL_WIDTH + time * this.pixelsPerSecond() - this.scrollX;
  }

  private xToTime(x: number): number {
    return Math.max(0, (x - LABEL_WIDTH + this.scrollX) / this.pixelsPerSecond());
  }

  private pixelsPerSecond(): number {
    return 80 * this.zoom;
  }

  private getBoneY(boneIndex: number): number {
    return RULER_HEIGHT + boneIndex * (BONE_TRACK_HEIGHT + TRACK_GAP);
  }

  // 设置 boneName -> slotNames 映射（从 SpineManager 获取，用于树形布局）
  setBoneToSlotsMap(map: Map<string, string[]>): void {
    this.boneToSlotsMap = new Map(map);
    this.buildTrackLayout();
  }

  // 构建树形轨道布局
  // 骨骼按父子关系深度优先排列，每个骨骼下方紧跟其关联的 slot（缩进一级）
  private buildTrackLayout(): void {
    this.trackLayout = [];
    const boneNames = this.editor.getBoneNames();
    if (boneNames.length === 0) return;

    // 需要骨骼的 parent 信息，从 editor 获取（但 editor 没有，需要外部传入）
    // 临时方案：用扁平顺序，但 slot 紧跟骨骼
    // TODO: 后续需要从 SpineManager 传入 boneTree

    // 简化方案：骨骼按原顺序，每个骨骼后跟其 slot
    for (const boneName of boneNames) {
      this.trackLayout.push({ type: 'bone', name: boneName, boneName, depth: 0 });
      const slots = this.boneToSlotsMap.get(boneName) || [];
      for (const slotName of slots) {
        this.trackLayout.push({ type: 'slot', name: slotName, boneName, depth: 1 });
      }
    }
  }

  // 获取轨道在 trackLayout 中的索引
  private getTrackIndex(type: 'bone' | 'slot', name: string): number {
    return this.trackLayout.findIndex(t => t.type === type && t.name === name);
  }

  // 根据轨道索引获取 Y 坐标
  private getTrackY(trackIndex: number): number {
    return RULER_HEIGHT + trackIndex * (BONE_TRACK_HEIGHT + TRACK_GAP);
  }

  // 根据 Y 坐标查找轨道
  private getTrackAtY(y: number): { trackIndex: number; track: { type: 'bone' | 'slot'; name: string; boneName: string; depth: number } } | null {
    for (let i = 0; i < this.trackLayout.length; i++) {
      const trackY = this.getTrackY(i);
      if (y >= trackY && y < trackY + BONE_TRACK_HEIGHT) {
        return { trackIndex: i, track: this.trackLayout[i] };
      }
    }
    return null;
  }

  // slot attachment 轨道的 Y 坐标（兼容旧代码，通过 trackLayout 查找）
  private getSlotTrackY(slotIndex: number): number {
    // slotIndex 是在 getSlotTrackNames() 返回列表中的索引
    const slotNames = this.getSlotTrackNames();
    const slotName = slotNames[slotIndex];
    if (!slotName) return 0;
    const trackIndex = this.getTrackIndex('slot', slotName);
    return trackIndex >= 0 ? this.getTrackY(trackIndex) : 0;
  }

  // 获取所有可编辑的 slot 列表（从 trackLayout 中提取）
  private getSlotTrackNames(): string[] {
    return this.trackLayout.filter(t => t.type === 'slot').map(t => t.name);
  }

  private getTotalHeight(): number {
    return RULER_HEIGHT + this.trackLayout.length * (BONE_TRACK_HEIGHT + TRACK_GAP);
  }

  private getTotalWidth(): number {
    const anim = this.editor.getAnimation();
    const duration = anim ? anim.duration : 1;
    return LABEL_WIDTH + duration * this.pixelsPerSecond() + 100;
  }

  private getBoneAtY(y: number): { boneIndex: number; boneName: string } | null {
    const hit = this.getTrackAtY(y);
    if (hit && hit.track.type === 'bone') {
      // boneIndex 是在 editor.getBoneNames() 中的索引
      const boneNames = this.editor.getBoneNames();
      const idx = boneNames.indexOf(hit.track.name);
      if (idx >= 0) return { boneIndex: idx, boneName: hit.track.name };
    }
    return null;
  }

  // 根据 Y 坐标查找 slot 轨道
  private getSlotAtY(y: number): { slotIndex: number; slotName: string } | null {
    const hit = this.getTrackAtY(y);
    if (hit && hit.track.type === 'slot') {
      const slotNames = this.getSlotTrackNames();
      const idx = slotNames.indexOf(hit.track.name);
      if (idx >= 0) return { slotIndex: idx, slotName: hit.track.name };
    }
    return null;
  }

  // 查找 slot 在指定 x 位置的关键帧
  private getSlotKeyframeAt(slotName: string, x: number, y: number): { time: number; index: number } | null {
    const anim = this.editor.getAnimation();
    const track = anim?.slotTracks.get(slotName);
    if (!track) return null;

    const slotNames = this.getSlotTrackNames();
    const slotIndex = slotNames.indexOf(slotName);
    if (slotIndex < 0) return null;
    const centerY = this.getSlotTrackY(slotIndex) + BONE_TRACK_HEIGHT / 2;

    for (let i = 0; i < track.keyframes.length; i++) {
      const kfX = this.timeToX(track.keyframes[i].time);
      const dist = Math.sqrt((x - kfX) ** 2 + (y - centerY) ** 2);
      if (dist <= KEYFRAME_SIZE + 4) {
        return { time: track.keyframes[i].time, index: i };
      }
    }
    return null;
  }

  // 查找骨骼在指定 x 位置的关键帧时间点（合并所有 channel）
  // 返回该时间点对应的所有 channel 关键帧索引
  private getKeyframeAt(boneName: string, x: number, y: number): { time: number; channels: { channel: BoneChannel; index: number }[] } | null {
    const track = this.editor.getAnimation()?.boneTracks.get(boneName);
    if (!track) return null;

    const boneIndex = this.editor.getBoneNames().indexOf(boneName);
    const centerY = this.getBoneY(boneIndex) + BONE_TRACK_HEIGHT / 2;

    // 合并所有 channel 的关键帧时间
    const allTimes = new Set<number>();
    for (const ch of CHANNELS) {
      for (const kf of track[ch]) {
        allTimes.add(kf.time);
      }
    }
    const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);

    // 查找点击位置附近的关键帧
    for (const time of sortedTimes) {
      const kfX = this.timeToX(time);
      const dist = Math.sqrt((x - kfX) ** 2 + (y - centerY) ** 2);
      if (dist <= KEYFRAME_SIZE + 4) {
        // 收集该时间点所有 channel 的关键帧索引
        const channels: { channel: BoneChannel; index: number }[] = [];
        for (const ch of CHANNELS) {
          const idx = track[ch].findIndex(k => k.time === time);
          if (idx >= 0) {
            channels.push({ channel: ch, index: idx });
          }
        }
        return { time, channels };
      }
    }
    return null;
  }

  private isKeyframeSelected(boneName: string, channel: BoneChannel, index: number): boolean {
    if (this.selectedBone === boneName && this.selectedChannel === channel && this.selectedKfIndex === index) return true;
    return this.multiSelections.some(s => s.boneName === boneName && s.channel === channel && s.keyframeIndex === index);
  }

  // ── Mouse events ──

  private onMouseDown = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Check playhead handle drag
    const phX = this.timeToX(this.playheadTime);
    if (y < RULER_HEIGHT && Math.abs(x - phX) <= PLAYHEAD_HANDLE_SIZE + 4) {
      this.dragging = 'playhead';
      this.dragStartX = x;
      this.dragStartTime = this.playheadTime;
      this.canvas.style.cursor = 'ew-resize';
      return;
    }

    // Click on ruler → seek
    if (y < RULER_HEIGHT && x >= LABEL_WIDTH) {
      const time = this.xToTime(x);
      this.onEvent({ type: 'seek', time });
      this.canvas.style.cursor = 'ew-resize';
      this.dragging = 'playhead';
      this.dragStartX = x;
      this.dragStartTime = time;
      return;
    }

    if (x < LABEL_WIDTH) return; // Ignore label area

    const hit = this.getBoneAtY(y);
    if (hit) {
      const kfHit = this.getKeyframeAt(hit.boneName, x, y);
      if (kfHit) {
        // 点击关键帧：选中该骨骼在该时间的所有 channel 关键帧
        if (e.shiftKey) {
          // 多选：添加所有 channel 关键帧到多选
          for (const ch of kfHit.channels) {
            const sel: KfSelection = { boneName: hit.boneName, channel: ch.channel, keyframeIndex: ch.index };
            const existingIdx = this.multiSelections.findIndex(
              s => s.boneName === sel.boneName && s.channel === sel.channel && s.keyframeIndex === sel.keyframeIndex
            );
            if (existingIdx >= 0) {
              this.multiSelections.splice(existingIdx, 1);
            } else {
              this.multiSelections.push(sel);
            }
          }
          this.onEvent({ type: 'multi-select-keyframe', selections: [...this.multiSelections] });
          this.render();
          return;
        }

        // 单选：选中第一个 channel 作为主选中（用于属性面板显示）
        const firstCh = kfHit.channels[0];
        this.selectedBone = hit.boneName;
        this.selectedChannel = firstCh.channel;
        this.selectedKfIndex = firstCh.index;
        this.multiSelections = [];

        // 只有按住 Ctrl 才能拖拽关键帧（避免误拖）
        if (e.ctrlKey) {
          this.dragging = 'keyframe';
          this.dragBone = hit.boneName;
          this.dragChannel = firstCh.channel;
          this.dragKfIndex = firstCh.index;
          this.dragStartX = x;
          this.dragStartTime = kfHit.time;
        }

        this.onEvent({
          type: 'select-keyframe',
          boneName: hit.boneName,
          channel: firstCh.channel,
          keyframeIndex: firstCh.index,
        });
        this.render();
        return;
      }

      // 点击空白处：选中骨骼 + 开始平移（水平拖动 scrollX）
      // 双击空白处才会添加关键帧（见 onDblClick）
      this.selectedBone = hit.boneName;
      this.selectedChannel = null;
      this.selectedKfIndex = -1;
      this.multiSelections = [];
      this.onEvent({ type: 'select-keyframe', boneName: hit.boneName, channel: undefined, keyframeIndex: -1 });
      // 开始水平平移
      this.dragging = 'pan';
      this.dragStartX = e.clientX;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.render();
      return;
    }

    // ── Slot 轨道点击处理 ──
    const slotHit = this.getSlotAtY(y);
    if (slotHit) {
      const kfHit = this.getSlotKeyframeAt(slotHit.slotName, x, y);
      if (kfHit) {
        // 点击 slot 关键帧：选中
        this.selectedBone = slotHit.slotName;
        this.selectedChannel = 'slot' as any;
        this.selectedKfIndex = kfHit.index;
        this.multiSelections = [];

        // Ctrl 拖动关键帧（只改变时间）
        if (e.ctrlKey) {
          this.dragging = 'slot-keyframe';
          this.dragBone = slotHit.slotName;
          this.dragKfIndex = kfHit.index;
          this.dragStartX = x;
          this.dragStartTime = kfHit.time;
          this.dragOriginalTime = kfHit.time;
        }

        this.onEvent({
          type: 'select-keyframe',
          boneName: slotHit.slotName,
          channel: 'slot' as any,
          keyframeIndex: kfHit.index,
        });
        this.render();
        return;
      }

      // 点击 slot 轨道空白处：选中 slot（不添加关键帧，双击才添加）
      this.selectedBone = slotHit.slotName;
      this.selectedChannel = 'slot' as any;
      this.selectedKfIndex = -1;
      this.multiSelections = [];
      this.onEvent({ type: 'select-keyframe', boneName: slotHit.slotName, channel: 'slot' as any, keyframeIndex: -1 });
      this.render();
      return;
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.dragging === 'playhead') {
      const time = this.xToTime(x);
      this.onEvent({ type: 'seek', time });
      return;
    }

    if (this.dragging === 'keyframe' && this.dragBone) {
      const newTime = Math.max(0, this.xToTime(x));
      // 移动该骨骼在 dragStartTime 的所有 channel 关键帧到 newTime
      const track = this.editor.getAnimation()?.boneTracks.get(this.dragBone);
      if (track) {
        for (const ch of CHANNELS) {
          const idx = track[ch].findIndex(k => Math.abs(k.time - this.dragStartTime) < 0.001);
          if (idx >= 0) {
            this.editor.moveKeyframe(this.dragBone, ch, idx, newTime);
          }
        }
      }
      this.dragStartTime = newTime;  // 更新以便连续拖拽
      this.onEvent({ type: 'move-keyframe', boneName: this.dragBone ?? undefined, channel: this.dragChannel ?? undefined, time: newTime });
      this.render();
      return;
    }

    if (this.dragging === 'slot-keyframe' && this.dragBone) {
      // 拖动 slot 关键帧：只改变时间，不改变 attachment 名
      const newTime = Math.max(0, this.xToTime(x));
      this.editor.moveSlotKeyframe(this.dragBone, this.dragKfIndex, newTime);
      this.dragStartTime = newTime;
      this.onEvent({ type: 'move-keyframe', boneName: this.dragBone, channel: 'slot' as any, time: newTime });
      this.render();
      return;
    }

    if (this.dragging === 'multi-keyframe') {
      const dx = x - this.dragStartX;
      const timeDelta = dx / this.pixelsPerSecond();
      for (const sel of this.multiSelections) {
        const startTime = this.multiDragStartTimes.get(`${sel.boneName}|${sel.channel}|${sel.keyframeIndex}`);
        if (startTime !== undefined) {
          const t = Math.max(0, startTime + timeDelta);
          this.editor.moveKeyframe(sel.boneName, sel.channel, sel.keyframeIndex, t);
        }
      }
      this.onEvent({ type: 'multi-move-keyframe', timeDelta });
      this.render();
      return;
    }

    if (this.dragging === 'pan') {
      // 只水平平移（垂直由容器原生滚动）
      const dx = e.clientX - this.lastMouseX;
      this.scrollX = Math.max(0, this.scrollX - dx);
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.render();
      return;
    }

    if (this.dragging === 'box-select') {
      this.render(); // Will draw box overlay
      return;
    }

    // Update cursor
    const phX = this.timeToX(this.playheadTime);
    if (y < RULER_HEIGHT && Math.abs(x - phX) <= PLAYHEAD_HANDLE_SIZE + 4) {
      this.canvas.style.cursor = 'ew-resize';
    } else if (y < RULER_HEIGHT && x >= LABEL_WIDTH) {
      this.canvas.style.cursor = 'pointer';
    } else if (x >= LABEL_WIDTH) {
      const hit = this.getBoneAtY(y);
      if (hit) {
        const kfHit = this.getKeyframeAt(hit.boneName, x, y);
        // 关键帧上：按 Ctrl 显示 grab（可拖动），否则 pointer（仅选中）
        this.canvas.style.cursor = kfHit ? (e.ctrlKey ? 'grab' : 'pointer') : 'default';
      } else {
        // 检查 slot 轨道
        const slotHit = this.getSlotAtY(y);
        if (slotHit) {
          const slotKfHit = this.getSlotKeyframeAt(slotHit.slotName, x, y);
          this.canvas.style.cursor = slotKfHit ? (e.ctrlKey ? 'grab' : 'pointer') : 'default';
        } else {
          this.canvas.style.cursor = 'default';
        }
      }
    } else {
      this.canvas.style.cursor = 'default';
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (this.dragging === 'playhead') {
      this.dragging = null;
      this.canvas.style.cursor = '';
      this.render();
      return;
    }

    if (this.dragging === 'keyframe') {
      // 拖拽结束时发送 move-keyframe-end 事件（含 oldTime/newTime），用于创建 Undo command
      if (this.dragBone && this.dragChannel) {
        const anim = this.editor.getAnimation();
        const track = anim?.boneTracks.get(this.dragBone);
        const newTime = track ? track[this.dragChannel][this.dragKfIndex]?.time ?? this.dragStartTime : this.dragStartTime;
        if (Math.abs(newTime - this.dragStartTime) > 0.001) {
          this.onEvent({
            type: 'move-keyframe-end',
            boneName: this.dragBone,
            channel: this.dragChannel,
            oldTime: this.dragStartTime,
            time: newTime,
          });
        }
      }
      this.dragging = null;
      this.dragBone = null;
      this.dragChannel = null;
      this.dragKfIndex = -1;
      this.render();
      return;
    }

    if (this.dragging === 'slot-keyframe') {
      // slot 关键帧拖动结束：发送 move-keyframe-end 事件（channel='slot'）
      if (this.dragBone) {
        const anim = this.editor.getAnimation();
        const track = anim?.slotTracks.get(this.dragBone);
        // moveSlotKeyframe 会重新排序，所以需要按时间查找当前 index
        const currentKf = track?.keyframes.find(k => Math.abs(k.time - this.dragStartTime) < 0.001);
        const newTime = currentKf ? currentKf.time : this.dragStartTime;
        if (Math.abs(newTime - this.dragOriginalTime) > 0.001) {
          this.onEvent({
            type: 'move-keyframe-end',
            boneName: this.dragBone,
            channel: 'slot' as any,
            oldTime: this.dragOriginalTime,
            time: newTime,
          });
        }
      }
      this.dragging = null;
      this.dragBone = null;
      this.dragKfIndex = -1;
      this.render();
      return;
    }

    if (this.dragging === 'multi-keyframe') {
      // 拖拽结束时发送 multi-move-keyframe-end 事件，用于创建 Undo MacroCommand
      const moves: { boneName: string; channel: BoneChannel; oldTime: number; newTime: number }[] = [];
      const anim = this.editor.getAnimation();
      if (anim) {
        for (const sel of this.multiSelections) {
          const track = anim.boneTracks.get(sel.boneName);
          if (!track) continue;
          const kf = track[sel.channel][sel.keyframeIndex];
          if (!kf) continue;
          const oldTime = this.multiDragStartTimes.get(`${sel.boneName}|${sel.channel}|${sel.keyframeIndex}`);
          if (oldTime !== undefined && Math.abs(kf.time - oldTime) > 0.001) {
            moves.push({ boneName: sel.boneName, channel: sel.channel, oldTime, newTime: kf.time });
          }
        }
      }
      if (moves.length > 0) {
        this.onEvent({ type: 'multi-move-keyframe-end', moves });
      }
      this.dragging = null;
      this.multiDragStartTimes.clear();
      this.render();
      return;
    }

    if (this.dragging === 'pan') {
      this.dragging = null;
      return;
    }

    if (this.dragging === 'box-select') {
      this.dragging = null;
      // Perform box select
      const minX = Math.min(this.boxSelectStartX, x);
      const maxX = Math.max(this.boxSelectStartX, x);
      const minY = Math.min(this.boxSelectStartY, y);
      const maxY = Math.max(this.boxSelectStartY, y);

      const selections: KfSelection[] = [];
      const anim = this.editor.getAnimation();
      if (anim) {
        for (const [boneName, track] of anim.boneTracks) {
          const boneIndex = this.editor.getBoneNames().indexOf(boneName);
          const centerY = this.getBoneY(boneIndex) + BONE_TRACK_HEIGHT / 2;
          if (centerY < minY || centerY > maxY) continue;
          // 合并所有 channel 的关键帧时间
          for (const ch of CHANNELS) {
            for (let ki = 0; ki < track[ch].length; ki++) {
              const kfX = this.timeToX(track[ch][ki].time);
              if (kfX >= minX && kfX <= maxX) {
                selections.push({ boneName, channel: ch, keyframeIndex: ki });
              }
            }
          }
        }
      }

      if (selections.length > 0) {
        this.multiSelections = selections;
        this.onEvent({ type: 'multi-select-keyframe', selections });
      }
      this.render();
      return;
    }
  };

  // 双击空白处添加关键帧（在该时间为所有 channel 添加关键帧）
  private onDblClick = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (x < LABEL_WIDTH || y < RULER_HEIGHT) return;

    const hit = this.getBoneAtY(y);
    if (hit) {
      // 如果双击到关键帧，不添加（避免重复）
      const kfHit = this.getKeyframeAt(hit.boneName, x, y);
      if (kfHit) return;

      const time = this.xToTime(x);
      this.onEvent({
        type: 'add-keyframe',
        boneName: hit.boneName,
        time,
      });
      return;
    }

    // 双击 slot 轨道：添加 slot 关键帧（attachment=null，即隐藏）
    const slotHit = this.getSlotAtY(y);
    if (slotHit) {
      // 如果双击到关键帧，不添加
      const slotKfHit = this.getSlotKeyframeAt(slotHit.slotName, x, y);
      if (slotKfHit) return;

      const time = this.xToTime(x);
      this.onEvent({
        type: 'add-keyframe',
        boneName: slotHit.slotName,
        channel: 'slot' as any,
        time,
      });
    }
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const hit = this.getBoneAtY(y);
    if (hit) {
      const kfHit = this.getKeyframeAt(hit.boneName, x, y);
      if (kfHit) {
        // 右键删除：将该时间点所有 channel 的关键帧作为多选删除
        const selections: KfSelection[] = kfHit.channels.map(ch => ({
          boneName: hit.boneName,
          channel: ch.channel,
          keyframeIndex: ch.index,
        }));
        this.onEvent({ type: 'multi-delete-keyframe', selections });
        return;
      }
    }

    // slot 轨道右键删除
    const slotHit = this.getSlotAtY(y);
    if (slotHit) {
      const slotKfHit = this.getSlotKeyframeAt(slotHit.slotName, x, y);
      if (slotKfHit) {
        this.onEvent({
          type: 'delete-keyframe',
          boneName: slotHit.slotName,
          channel: 'slot' as any,
          keyframeIndex: slotKfHit.index,
        });
      }
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.multiSelections.length > 0) {
        this.onEvent({ type: 'multi-delete-keyframe', selections: [...this.multiSelections] });
      } else if (this.selectedBone && this.selectedChannel && this.selectedKfIndex >= 0) {
        this.onEvent({
          type: 'delete-keyframe',
          boneName: this.selectedBone,
          channel: this.selectedChannel,
          keyframeIndex: this.selectedKfIndex,
        });
      }
      return;
    }

    if (e.ctrlKey && e.key === 'c') {
      // Copy selected keyframes
      this.copySelectedKeyframes();
      return;
    }

    if (e.ctrlKey && e.key === 'v') {
      // Paste keyframes at playhead
      this.pasteKeyframesAtPlayhead();
      return;
    }
  };

  private copySelectedKeyframes(): void {
    this.clipboard = [];
    const anim = this.editor.getAnimation();
    if (!anim) return;

    const selections = this.multiSelections.length > 0
      ? this.multiSelections
      : (this.selectedBone && this.selectedChannel && this.selectedKfIndex >= 0
        ? [{ boneName: this.selectedBone, channel: this.selectedChannel, keyframeIndex: this.selectedKfIndex }]
        : []);

    for (const sel of selections) {
      const track = anim.boneTracks.get(sel.boneName);
      if (!track) continue;
      const kf = track[sel.channel][sel.keyframeIndex];
      if (kf) {
        this.clipboard.push({
          time: kf.time,
          value: kf.value,
          x: kf.x,
          y: kf.y,
          curve: kf.curve,
        });
      }
    }
  }

  private pasteKeyframesAtPlayhead(): void {
    if (this.clipboard.length === 0) return;
    const baseTime = this.playheadTime;

    // Find the earliest time in clipboard to offset
    let minTime = Infinity;
    for (const entry of this.clipboard) {
      if (entry.time < minTime) minTime = entry.time;
    }

    if (this.multiSelections.length > 0) {
      // Paste relative to each selected bone/channel
      for (let i = 0; i < this.multiSelections.length; i++) {
        const sel = this.multiSelections[i];
        const entry = this.clipboard[i % this.clipboard.length];
        const newTime = baseTime + (entry.time - minTime);
        this.onEvent({
          type: 'add-keyframe',
          boneName: sel.boneName,
          channel: sel.channel,
          time: newTime,
          value: { value: entry.value, x: entry.x, y: entry.y },
        });
      }
    } else if (this.selectedBone && this.selectedChannel) {
      for (const entry of this.clipboard) {
        const newTime = baseTime + (entry.time - minTime);
        this.onEvent({
          type: 'add-keyframe',
          boneName: this.selectedBone,
          channel: this.selectedChannel,
          time: newTime,
          value: { value: entry.value, x: entry.x, y: entry.y },
        });
      }
    }
  }

  private onWheel = (e: WheelEvent): void => {
    // Ctrl+滚轮：模拟拖动时间轴指针（playhead 前后移动）
    // 缩放已由顶部工具栏的普通滚轮处理，这里不重复
    if (e.ctrlKey) {
      e.preventDefault();
      // deltaY > 0 向后移动（时间增大），deltaY < 0 向前移动
      const anim = this.editor.getAnimation();
      const duration = anim ? anim.duration : 1;
      // 每格滚动移动 0.1 秒（按 zoom 调整步长，zoom 越大步长越小）
      const step = 0.1 / Math.max(0.5, this.zoom);
      const newTime = Math.max(0, Math.min(duration, this.playheadTime + (e.deltaY > 0 ? step : -step)));
      this.onEvent({ type: 'seek', time: newTime });
      return;
    }
    // Shift+滚轮：水平滚动画布
    if (e.shiftKey) {
      e.preventDefault();
      this.scrollX = Math.max(0, this.scrollX + e.deltaY);
      this.render();
      return;
    }
    // 普通滚轮：垂直滚动，交给容器原生处理（不 preventDefault）
  };

  // ── Render ──

  render(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, w, h);

    // Label column background
    ctx.fillStyle = '#252536';
    ctx.fillRect(0, 0, LABEL_WIDTH, h);

    const anim = this.editor.getAnimation();
    if (!anim) return;

    const pps = this.pixelsPerSecond();

    // ── Time ruler ──
    ctx.fillStyle = '#2a2a3e';
    ctx.fillRect(LABEL_WIDTH, 0, w - LABEL_WIDTH, RULER_HEIGHT);

    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#888';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';

    const tickInterval = this.calcTickInterval(pps);
    for (let t = 0; t <= anim.duration + tickInterval; t += tickInterval) {
      const x = this.timeToX(t);
      if (x < LABEL_WIDTH || x > w) continue;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 6);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(t.toFixed(tickInterval < 0.2 ? 2 : 1) + 's', x, RULER_HEIGHT - 8);
    }

    // ── 树形轨道渲染（骨骼 + slot 混合，按 trackLayout 顺序）──
    for (let ti = 0; ti < this.trackLayout.length; ti++) {
      const trackInfo = this.trackLayout[ti];
      const trackY = this.getTrackY(ti);
      if (trackY + BONE_TRACK_HEIGHT < 0 || trackY > h) continue;

      const indent = trackInfo.depth * 12; // 每级缩进 12px

      if (trackInfo.type === 'bone') {
        const boneName = trackInfo.name;
        const track = anim.boneTracks.get(boneName);
        if (!track) continue;

        // Track background
        ctx.fillStyle = ti % 2 === 0 ? '#1a1a2e' : '#1e1e32';
        ctx.fillRect(LABEL_WIDTH, trackY, w - LABEL_WIDTH, BONE_TRACK_HEIGHT);

        // Bone label（带缩进）
        ctx.fillStyle = '#aaa';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(boneName, 4 + indent, trackY + 14);

        // Center line
        const centerY = trackY + BONE_TRACK_HEIGHT / 2;
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(LABEL_WIDTH, centerY);
        ctx.lineTo(w, centerY);
        ctx.stroke();

        // 合并所有 channel 的关键帧时间点
        const allTimes = new Set<number>();
        for (const ch of CHANNELS) {
          for (const kf of track[ch]) {
            allTimes.add(kf.time);
          }
        }
        const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);

        // 绘制合并的关键帧（菱形）
        for (const time of sortedTimes) {
          const kfX = this.timeToX(time);
          if (kfX < LABEL_WIDTH - KEYFRAME_SIZE || kfX > w + KEYFRAME_SIZE) continue;

          // 检查该时间点是否被选中（任意 channel 选中即选中）
          let isSelected = false;
          for (const ch of CHANNELS) {
            const ki = track[ch].findIndex(k => k.time === time);
            if (ki >= 0 && this.isKeyframeSelected(boneName, ch, ki)) {
              isSelected = true;
              break;
            }
          }

          // 绘制关键帧（菱形）
          ctx.fillStyle = isSelected ? '#fff' : '#4ecdc4';
          ctx.strokeStyle = isSelected ? '#4ecdc4' : '#000';
          ctx.lineWidth = isSelected ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(kfX, centerY - KEYFRAME_SIZE);
          ctx.lineTo(kfX + KEYFRAME_SIZE, centerY);
          ctx.lineTo(kfX, centerY + KEYFRAME_SIZE);
          ctx.lineTo(kfX - KEYFRAME_SIZE, centerY);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      } else {
        // slot 轨道
        const slotName = trackInfo.name;
        const slotTrack = anim.slotTracks.get(slotName);

        // 轨道背景（slot 用稍微不同的颜色）
        ctx.fillStyle = ti % 2 === 0 ? '#1a2a1a' : '#1e2e1e';
        ctx.fillRect(LABEL_WIDTH, trackY, w - LABEL_WIDTH, BONE_TRACK_HEIGHT);

        // 标签（slot 名，带缩进，用橙色区分）
        ctx.fillStyle = '#ffa500';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`↳ ${slotName}`, 4 + indent, trackY + 14);

        // 中线
        const centerY = trackY + BONE_TRACK_HEIGHT / 2;
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(LABEL_WIDTH, centerY);
        ctx.lineTo(w, centerY);
        ctx.stroke();

        // 绘制 attachment 切换关键帧（彩色方块 + attachment 名）
        if (slotTrack) {
          for (const kf of slotTrack.keyframes) {
            const kfX = this.timeToX(kf.time);
            if (kfX < LABEL_WIDTH - KEYFRAME_SIZE || kfX > w + KEYFRAME_SIZE) continue;

            const hasAttachment = !!kf.attachmentName;
            // 有 attachment = 橙色方块，无 attachment（null）= 灰色方块
            ctx.fillStyle = hasAttachment ? '#ffa500' : '#555';
            ctx.strokeStyle = hasAttachment ? '#fff' : '#333';
            ctx.lineWidth = 1;
            ctx.fillRect(kfX - KEYFRAME_SIZE, centerY - KEYFRAME_SIZE, KEYFRAME_SIZE * 2, KEYFRAME_SIZE * 2);
            ctx.strokeRect(kfX - KEYFRAME_SIZE, centerY - KEYFRAME_SIZE, KEYFRAME_SIZE * 2, KEYFRAME_SIZE * 2);

            // 显示 attachment 名（如 "Hammer" 或 "null"）
            const label = hasAttachment ? kf.attachmentName!.replace(/^C01\//, '') : 'null';
            ctx.fillStyle = '#fff';
            ctx.font = '9px monospace';
            ctx.fillText(label, kfX + KEYFRAME_SIZE + 2, centerY + 3);
          }
        }
      }

      // 轨道分隔线
      const sepY = trackY + BONE_TRACK_HEIGHT + TRACK_GAP - 1;
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, sepY);
      ctx.lineTo(w, sepY);
      ctx.stroke();
    }

    // ── Box select overlay ──
    if (this.dragging === 'box-select') {
      const rect = this.canvas.getBoundingClientRect();
      const x = this.lastMouseX - rect.left;
      const y = this.lastMouseY - rect.top;
      ctx.fillStyle = 'rgba(88, 166, 255, 0.15)';
      ctx.strokeStyle = 'rgba(88, 166, 255, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.rect(this.boxSelectStartX, this.boxSelectStartY, x - this.boxSelectStartX, y - this.boxSelectStartY);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ── Playhead ──
    const phX = this.timeToX(this.playheadTime);
    if (phX >= LABEL_WIDTH - 10 && phX <= w + 10) {
      ctx.strokeStyle = '#ff4757';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(phX, RULER_HEIGHT);
      ctx.lineTo(phX, h);
      ctx.stroke();

      // Playhead triangle handle
      ctx.fillStyle = '#ff4757';
      ctx.beginPath();
      ctx.moveTo(phX, RULER_HEIGHT);
      ctx.lineTo(phX - PLAYHEAD_HANDLE_SIZE, 0);
      ctx.lineTo(phX + PLAYHEAD_HANDLE_SIZE, 0);
      ctx.closePath();
      ctx.fill();

      // Playhead triangle glow
      ctx.fillStyle = 'rgba(255, 71, 87, 0.3)';
      ctx.beginPath();
      ctx.moveTo(phX, RULER_HEIGHT);
      ctx.lineTo(phX - PLAYHEAD_HANDLE_SIZE - 2, 0);
      ctx.lineTo(phX + PLAYHEAD_HANDLE_SIZE + 2, 0);
      ctx.closePath();
      ctx.fill();
    }

    // ── Label column border ──
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LABEL_WIDTH, 0);
    ctx.lineTo(LABEL_WIDTH, h);
    ctx.stroke();
  }

  private calcTickInterval(pps: number): number {
    const target = 100 / pps;
    const intervals = [0.05, 0.1, 0.2, 0.5, 1, 2, 5];
    for (const iv of intervals) {
      if (iv >= target) return iv;
    }
    return 5;
  }

  destroy(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('dblclick', this.onDblClick);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
    // 从 DOM 中移除旧 canvas，避免堆积
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}