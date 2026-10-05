import type { Skeleton as SpineSkeleton } from '@esotericsoftware/spine-core';
import { AnimationEditor, BoneChannel, Keyframe } from './AnimationEditor';

// 最小骨架视图接口（替代 pet-custom-system 的 SpineManager：宿主 demo 持有 Skeleton 即可）
export interface SkeletonProvider {
  getSkeleton(): SpineSkeleton;
}

type GizmoMode = 'rotate' | 'translate' | 'scale' | 'shear';

// 判断 attachment 类型（用 duck typing，避免 instanceof 在 ESM 内部类名不匹配的问题）
function isRegionAttachment(att: any): boolean {
  return att && typeof att.getOffsets === 'function' && !att.triangles;
}
function isMeshAttachment(att: any): boolean {
  return att && Array.isArray(att.triangles) && typeof att.worldVerticesLength === 'number';
}

// Spine 4.3: bone 的世界坐标在 appliedPose 上（worldX/worldY）
// worldX/worldY 已包含 skeleton.x/y 和 scale，就是 canvas 坐标
function getBoneWorld(bone: any): { x: number; y: number } {
  const pose = bone.appliedPose || bone.pose || bone;
  return { x: pose.worldX || 0, y: pose.worldY || 0 };
}

// bone 的 worldX/worldY 就是 canvas 坐标（已包含 skeleton 位移和缩放）
function boneToCanvas(bone: any): { x: number; y: number } {
  return getBoneWorld(bone);
}

// 检查点是否在四边形内（4个顶点，8个值：br, bl, ul, ur）
function pointInQuad(px: number, py: number, v: Float32Array | number[]): boolean {
  // 用两个三角形覆盖四边形：br-bl-ul 和 br-ul-ur
  return pointInTriangle(px, py, v[0], v[1], v[2], v[3], v[4], v[5])
    || pointInTriangle(px, py, v[0], v[1], v[4], v[5], v[6], v[7]);
}

// 检查点是否在三角形内（重心坐标法）
function pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
  const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
  return !(hasNeg && hasPos);
}

// Gizmo 拖拽结束时的信息，用于创建 Undo command
export interface GizmoDragEndInfo {
  boneName: string;
  channel: BoneChannel;
  time: number;
  createdNew: boolean;       // 是否是新建的关键帧
  oldValue: { value?: number; x?: number; y?: number };
  newValue: { value?: number; x?: number; y?: number };
  keyframeData: Keyframe;    // 最终关键帧数据
}

const GIZMO_RING_RADIUS = 30;
const GIZMO_ARROW_LENGTH = 25;
const GIZMO_ARROW_HEAD = 6;
const GIZMO_HIT_SIZE = 10;
const GIZMO_HANDLE_RADIUS = 6;  // 定位点手柄半径
const GIZMO_HANDLE_HIT = 12;    // 定位点点击命中范围

export class BoneGizmo {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private spineManager: SkeletonProvider;
  private editor: AnimationEditor;
  private onUpdate: () => void;
  private onDragEnd?: (info: GizmoDragEndInfo) => void;

  private mode: GizmoMode = 'rotate'; // 保留兼容，但渲染不再依赖
  private dragMode: GizmoMode | null = null; // 拖拽时由 mousedown 决定的实际模式
  private selectedBone: string | null = null;
  private currentTime = 0;

  // Drag state
  private dragging = false;
  private dragStartValX = 0;  // 关键帧起始值 X（rotate/translate.x/scale.x）
  private dragStartValY = 0;  // 关键帧起始值 Y（translate.y/scale.y）
  private dragStartX = 0;     // 鼠标起始像素 X
  private dragStartY = 0;     // 鼠标起始像素 Y
  private dragStartAngle = 0;
  private dragUsingHandle = false;  // 是否使用末端定位点手柄拖拽
  private dragStartHandleDist = 0;  // 拖拽起始时鼠标到骨骼根部的距离
  private dragChannel: BoneChannel | null = null;
  // 拖拽起始时是否新建了关键帧
  private dragCreatedKf = false;
  // 拖拽起始时的关键帧原始值快照
  private dragStartKf: { value?: number; x?: number; y?: number } = {};

  constructor(
    canvas: HTMLCanvasElement,
    spineManager: SkeletonProvider,
    editor: AnimationEditor,
    onUpdate: () => void,
    onDragEnd?: (info: GizmoDragEndInfo) => void,
  ) {
    this.canvas = canvas;
    this.spineManager = spineManager;
    this.editor = editor;
    this.onUpdate = onUpdate;
    this.onDragEnd = onDragEnd;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 上下文');
    this.ctx = ctx;

    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
  }

  getMode(): GizmoMode {
    return this.mode;
  }

  setSelectedBone(name: string | null): void {
    this.selectedBone = name;
  }

  setCurrentTime(time: number): void {
    this.currentTime = time;
  }

  // 是否正在拖拽 gizmo 手柄（供外部监听器判断是否应跳过 bone picking）
  isDragging(): boolean {
    return this.dragging;
  }

  // 将鼠标事件的 CSS 坐标转换为 canvas 内部坐标（与 skeleton 世界坐标一致）
  // canvas 可能被 CSS 缩放显示，内部坐标和 CSS 坐标不一致时需要转换
  private toCanvasCoords(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  render(): void {
    const skeleton = this.spineManager.getSkeleton();
    if (!skeleton) return;

    const ctx = this.ctx;
    ctx.save();

    // 不再绘制骨骼节点（用户要求移除）
    // 改为：选中骨骼时，高亮该骨骼关联的所有 slot 的 attachment 轮廓

    if (this.selectedBone) {
      this.drawSlotOutlines(ctx, skeleton, this.selectedBone);
      // 同时绘制所有手柄（旋转环 + 平移箭头 + 缩放手柄），无需切换模式
      const bone = skeleton.findBone(this.selectedBone);
      if (bone) {
        const c = boneToCanvas(bone);
        const worldX = c.x;
        const worldY = c.y;
        // 计算骨骼末端世界坐标（用于缩放手柄）
        const pose = bone.appliedPose || bone.pose || bone;
        const boneLength = bone.data?.length || 0;
        const endX = worldX + (pose.a || 1) * boneLength;
        const endY = worldY + (pose.c || 0) * boneLength;
        // 1. 平移箭头（X 红 / Y 绿）
        this.drawTranslateGizmo(ctx, worldX, worldY);
        // 2. 旋转环（红色虚线）
        this.drawRotateGizmo(ctx, worldX, worldY);
        // 3. 缩放手柄（骨骼末端黄色圆圈 + 连接线）
        this.drawScaleGizmo(ctx, worldX, worldY, endX, endY);
        // 显示骨骼名称
        ctx.fillStyle = '#fff';
        ctx.font = '11px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(this.selectedBone, worldX + 14, worldY - 10);
      }
    }

    ctx.restore();
  }

  // 绘制选中骨骼及其子骨骼关联的所有 slot 的 attachment 轮廓（高亮）
  private drawSlotOutlines(ctx: CanvasRenderingContext2D, skeleton: any, boneName: string): void {
    const bone = skeleton.findBone(boneName);
    if (!bone) return;

    // 递归收集选中骨骼及其所有后代骨骼
    const boneSet = new Set<any>();
    const collectBones = (b: any): void => {
      boneSet.add(b);
      if (b.children) {
        for (const child of b.children) collectBones(child);
      }
    };
    collectBones(bone);

    // 遍历所有 slot，找到 bone 在 boneSet 中的 slot
    const slots = skeleton.slots;
    if (!slots) return;

    for (const slot of slots as any[]) {
      if (!boneSet.has(slot.bone)) continue;
      const pose = slot.appliedPose || slot.pose;
      const attachment = pose?.attachment;
      if (!attachment) continue;
      // 跳过透明的 slot（不可见）
      const color = pose.color;
      if (color && typeof color.a === 'number' && color.a <= 0) continue;

      if (isRegionAttachment(attachment)) {
        this.drawRegionOutline(ctx, slot, attachment);
      } else if (isMeshAttachment(attachment)) {
        this.drawMeshOutline(ctx, skeleton, slot, attachment);
      }
    }
  }

  // 绘制 RegionAttachment 的四边形轮廓
  private drawRegionOutline(ctx: CanvasRenderingContext2D, slot: any, attachment: any): void {
    const worldVertices = new Float32Array(8);
    try {
      const pose = slot.appliedPose || slot.pose;
      attachment.computeWorldVertices(slot, attachment.getOffsets(pose), worldVertices, 0, 2);
    } catch (e) {
      return;
    }
    // 顶点顺序：br, bl, ul, ur
    ctx.strokeStyle = '#ff4757';
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(worldVertices[0], worldVertices[1]);
    ctx.lineTo(worldVertices[2], worldVertices[3]);
    ctx.lineTo(worldVertices[4], worldVertices[5]);
    ctx.lineTo(worldVertices[6], worldVertices[7]);
    ctx.closePath();
    ctx.stroke();
  }

  // 绘制 MeshAttachment 的网格轮廓
  private drawMeshOutline(ctx: CanvasRenderingContext2D, skeleton: any, slot: any, attachment: any): void {
    const worldVertices = new Float32Array(attachment.worldVerticesLength);
    try {
      attachment.computeWorldVertices(skeleton, slot, 0, attachment.worldVerticesLength, worldVertices, 0, 2);
    } catch (e) {
      return;
    }
    // 画三角形边框
    const triangles = attachment.triangles;
    ctx.strokeStyle = '#ff4757';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    // 用 Path2D 去重绘制边
    const drawnEdges = new Set<string>();
    ctx.beginPath();
    for (let i = 0; i < triangles.length; i += 3) {
      const t0 = triangles[i], t1 = triangles[i + 1], t2 = triangles[i + 2];
      const edges = [[t0, t1], [t1, t2], [t2, t0]];
      for (const [a, b] of edges) {
        const key = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (drawnEdges.has(key)) continue;
        drawnEdges.add(key);
        const ax = worldVertices[a * 2], ay = worldVertices[a * 2 + 1];
        const bx = worldVertices[b * 2], by = worldVertices[b * 2 + 1];
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
    }
    ctx.stroke();
  }

  private drawRotateGizmo(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    // Rotation ring (dashed)
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, GIZMO_RING_RADIUS, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawTranslateGizmo(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    // X arrow (red)
    this.drawArrow(ctx, cx, cy, cx + GIZMO_ARROW_LENGTH, cy, '#ff6b6b');
    // Y arrow (green)
    this.drawArrow(ctx, cx, cy, cx, cy - GIZMO_ARROW_LENGTH, '#4ecdc4');
  }

  private drawScaleGizmo(ctx: CanvasRenderingContext2D, cx: number, cy: number, endX: number, endY: number): void {
    // 骨骼线（根部到末端）
    ctx.strokeStyle = '#ffe66d';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.setLineDash([]);
    // 根部方框
    const s = 6;
    ctx.strokeStyle = '#ffe66d';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - s, cy - s, s * 2, s * 2);
    // 末端定位点手柄（可拖拽缩放）
    ctx.fillStyle = '#ffe66d';
    ctx.beginPath();
    ctx.arc(endX, endY, GIZMO_HANDLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawArrow(ctx: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number, color: string): void {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2;

    // Shaft
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    // Head
    const angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - GIZMO_ARROW_HEAD * Math.cos(angle - Math.PI / 6),
      toY - GIZMO_ARROW_HEAD * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      toX - GIZMO_ARROW_HEAD * Math.cos(angle + Math.PI / 6),
      toY - GIZMO_ARROW_HEAD * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  // ── Mouse events ──

  // 检测点击命中哪个手柄，返回模式或 null
  // 优先级：缩放手柄(末端) > 旋转环 > 平移箭头(X/Y) > 中心区域(平移)
  private hitTestHandle(x: number, y: number, worldX: number, worldY: number, endX: number, endY: number): GizmoMode | null {
    // 1. 缩放手柄（骨骼末端定位点）
    const handleDist = Math.sqrt((x - endX) ** 2 + (y - endY) ** 2);
    if (handleDist <= GIZMO_HANDLE_HIT) return 'scale';
    // 2. 旋转环（距中心 ≈ GIZMO_RING_RADIUS）
    const centerDist = Math.sqrt((x - worldX) ** 2 + (y - worldY) ** 2);
    if (Math.abs(centerDist - GIZMO_RING_RADIUS) <= GIZMO_HIT_SIZE) return 'rotate';
    // 3. 平移箭头头部（X 箭头末端 (worldX+LEN, worldY)，Y 箭头末端 (worldX, worldY-LEN)）
    const xArrowDist = Math.sqrt((x - (worldX + GIZMO_ARROW_LENGTH)) ** 2 + (y - worldY) ** 2);
    if (xArrowDist <= GIZMO_ARROW_HEAD + 4) return 'translate';
    const yArrowDist = Math.sqrt((x - worldX) ** 2 + (y - (worldY - GIZMO_ARROW_LENGTH)) ** 2);
    if (yArrowDist <= GIZMO_ARROW_HEAD + 4) return 'translate';
    // 4. 中心区域（环内）-> 平移
    if (centerDist < GIZMO_RING_RADIUS) return 'translate';
    return null;
  }

  // 检测鼠标悬停在哪个手柄上，返回对应光标
  hitTestHover(cssX: number, cssY: number): string | null {
    if (!this.selectedBone) return null;
    const skeleton = this.spineManager.getSkeleton();
    if (!skeleton) return null;
    const bone = skeleton.findBone(this.selectedBone);
    if (!bone) return null;
    const c = boneToCanvas(bone);
    const pose = bone.appliedPose || bone.pose || bone;
    const boneLength = bone.data?.length || 0;
    const endX = c.x + (pose.a || 1) * boneLength;
    const endY = c.y + (pose.c || 0) * boneLength;
    // 转换为 canvas 内部坐标
    const { x, y } = this.toCanvasCoords(cssX, cssY);
    const mode = this.hitTestHandle(x, y, c.x, c.y, endX, endY);
    if (!mode) return null;
    switch (mode) {
      case 'rotate': return 'crosshair';
      case 'translate': return 'move';
      case 'scale': return 'nwse-resize';
      case 'shear': return 'nesw-resize';
    }
    return null;
  }

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.selectedBone) return;

    const skeleton = this.spineManager.getSkeleton();
    if (!skeleton) return;

    const bone = skeleton.findBone(this.selectedBone);
    if (!bone) return;

    // 转换为 canvas 内部坐标（与骨骼世界坐标一致）
    const { x, y } = this.toCanvasCoords(e.clientX, e.clientY);

    const c = boneToCanvas(bone);
    const worldX = c.x;
    const worldY = c.y;

    // 计算骨骼末端世界坐标（用于 scale 手柄）
    const pose = bone.appliedPose || bone.pose || bone;
    const boneLength = bone.data?.length || 0;
    const endX = worldX + (pose.a || 1) * boneLength;
    const endY = worldY + (pose.c || 0) * boneLength;

    // 检测点击哪个手柄
    const hitMode = this.hitTestHandle(x, y, worldX, worldY, endX, endY);
    if (!hitMode) return;

    this.dragMode = hitMode;
    this.dragging = true;
    this.dragStartX = e.clientX;
    this.dragStartY = e.clientY;
    // scale 模式使用末端定位点手柄
    this.dragUsingHandle = (hitMode === 'scale');

    // Determine which channel
    this.dragChannel = hitMode === 'rotate' ? 'rotate' : (hitMode === 'translate' ? 'translate' : (hitMode === 'scale' ? 'scale' : 'shear'));

    // Get current value
    const anim = this.editor.getAnimation();
    if (!anim) return;

    const track = anim.boneTracks.get(this.selectedBone);
    if (!track) return;

    const kfs = track[this.dragChannel];
    // Find or create keyframe at current time
    let kfIdx = kfs.findIndex(k => Math.abs(k.time - this.currentTime) < 0.01);
    this.dragCreatedKf = false;
    if (kfIdx < 0) {
      kfIdx = this.editor.addKeyframe(this.selectedBone, this.dragChannel, this.currentTime, {});
      this.dragCreatedKf = true;
    }

    const kf = kfs[kfIdx];
    if (!kf) return;

    // 记录拖拽起始时的关键帧值快照（用于 Undo）
    this.dragStartKf = { value: kf.value, x: kf.x, y: kf.y };

    if (hitMode === 'rotate') {
      this.dragStartValX = kf.value ?? 0;
      this.dragStartAngle = Math.atan2(y - worldY, x - worldX);
    } else if (hitMode === 'translate') {
      this.dragStartValX = kf.x ?? 0;
      this.dragStartValY = kf.y ?? 0;
    } else if (hitMode === 'scale') {
      this.dragStartValX = kf.x ?? 1;
      this.dragStartValY = kf.y ?? 1;
      // 定位点模式：记录起始时鼠标到骨骼根部的距离
      if (this.dragUsingHandle) {
        this.dragStartHandleDist = Math.sqrt((x - worldX) ** 2 + (y - worldY) ** 2);
      }
    } else {
      // shear: vec2，类似 translate
      this.dragStartValX = kf.x ?? 0;
      this.dragStartValY = kf.y ?? 0;
      if (this.dragUsingHandle) {
        this.dragStartHandleDist = Math.sqrt((x - worldX) ** 2 + (y - worldY) ** 2);
      }
    }

    e.stopPropagation();
  };

  private onMouseMove = (e: MouseEvent): void => {
    // 非拖拽时：更新 hover 光标
    if (!this.dragging) {
      const cursor = this.hitTestHover(e.clientX, e.clientY);
      this.canvas.style.cursor = cursor || 'default';
      return;
    }
    if (!this.selectedBone || !this.dragChannel) return;

    const skeleton = this.spineManager.getSkeleton();
    if (!skeleton) return;

    const bone = skeleton.findBone(this.selectedBone);
    if (!bone) return;

    const rect = this.canvas.getBoundingClientRect();
    // CSS 像素 → canvas 内部像素的缩放比
    const cssScaleX = this.canvas.width / rect.width;
    const cssScaleY = this.canvas.height / rect.height;
    const c = boneToCanvas(bone);
    const worldX = c.x;
    const worldY = c.y;
    // 鼠标在 canvas 内部坐标系的当前位置
    const mx = (e.clientX - rect.left) * cssScaleX;
    const my = (e.clientY - rect.top) * cssScaleY;

    if (this.dragMode === 'rotate') {
      // canvas Y 向下，atan2 顺时针为正；Spine rotate 逆时针为正，所以取负
      const angle = Math.atan2(my - worldY, mx - worldX);
      const deltaAngle = -(angle - this.dragStartAngle) * (180 / Math.PI);
      const newValue = this.dragStartValX + deltaAngle;
      this.updateKeyframeValue(newValue, undefined, undefined);
    } else if (this.dragMode === 'translate') {
      // translate 是相对于父骨骼的局部坐标，用父骨骼世界矩阵的逆转换
      // Spine BonePose 源码：worldX = x*sx + skeleton.x，a/b/c/d 已包含 skeleton scale
      // 所以 canvas 像素位移 = skeleton 世界位移（worldX 直接是 canvas 坐标）
      // 父骨骼局部位移 = inverse(parentWorldMatrix) * 世界位移
      // 注意：拖拽起始记录的是 e.clientX（CSS 像素），delta 需转换为 canvas 内部像素
      const dxW = (e.clientX - this.dragStartX) * cssScaleX;
      const dyW = (e.clientY - this.dragStartY) * cssScaleY;
      const parent = (bone as any).parent;
      const pa = parent ? (parent.appliedPose || parent.pose || parent) : null;
      let dxL: number, dyL: number;
      if (pa) {
        const det = pa.a * pa.d - pa.b * pa.c;
        if (Math.abs(det) > 1e-6) {
          dxL = (pa.d * dxW - pa.c * dyW) / det;
          dyL = (-pa.b * dxW + pa.a * dyW) / det;
        } else {
          dxL = dxW;
          dyL = dyW;
        }
      } else {
        // root 骨骼：worldX = x*sx + skeleton.x，所以 dx = dWorldX / sx
        const sx = Math.abs(skeleton.scaleX) || 1;
        const sy = Math.abs(skeleton.scaleY) || 1;
        dxL = dxW / sx;
        dyL = dyW / sy;
      }
      this.updateKeyframeValue(undefined, this.dragStartValX + dxL, this.dragStartValY + dyL);
    } else if (this.dragMode === 'scale' || this.dragMode === 'shear') {
      if (this.dragUsingHandle) {
        // 定位点模式：拖动骨骼末端手柄，根据鼠标到骨骼根部的距离比计算缩放
        const curDist = Math.sqrt((mx - worldX) ** 2 + (my - worldY) ** 2);
        if (this.dragStartHandleDist > 1e-3) {
          const ratio = curDist / this.dragStartHandleDist;
          if (this.dragMode === 'scale') {
            // 统一缩放（X/Y 同比例）
            const newX = Math.max(0.01, this.dragStartValX * ratio);
            const newY = Math.max(0.01, this.dragStartValY * ratio);
            this.updateKeyframeValue(undefined, newX, newY);
          } else {
            // shear 定位点模式：根据手柄在骨骼局部坐标的偏移计算剪切
            const pose = bone.appliedPose || bone.pose || bone;
            const dxW = (e.clientX - this.dragStartX) * cssScaleX;
            const dyW = (e.clientY - this.dragStartY) * cssScaleY;
            const det = pose.a * pose.d - pose.b * pose.c;
            let dxL: number, dyL: number;
            if (Math.abs(det) > 1e-6) {
              dxL = (pose.d * dxW - pose.c * dyW) / det;
              dyL = (-pose.b * dxW + pose.a * dyW) / det;
            } else {
              dxL = dxW;
              dyL = dyW;
            }
            // 剪切值单位是度，降低灵敏度
            this.updateKeyframeValue(undefined, this.dragStartValX + dxL * 0.2, this.dragStartValY + dyL * 0.2);
          }
        }
      } else {
        // 非定位点模式：中心区域拖拽，降低灵敏度精细调整
        const pose = bone.appliedPose || bone.pose || bone;
        const dxPix = (e.clientX - this.dragStartX) * cssScaleX;
        const dyPix = (e.clientY - this.dragStartY) * cssScaleY;
        const det = pose.a * pose.d - pose.b * pose.c;
        let dxL: number, dyL: number;
        if (Math.abs(det) > 1e-6) {
          dxL = (pose.d * dxPix - pose.c * dyPix) / det;
          dyL = (-pose.b * dxPix + pose.a * dyPix) / det;
        } else {
          dxL = dxPix;
          dyL = dyPix;
        }
        if (this.dragMode === 'scale') {
          // 精细缩放：0.005 灵敏度
          const newX = Math.max(0.01, this.dragStartValX + dxL * 0.005);
          const newY = Math.max(0.01, this.dragStartValY + dyL * 0.005);
          this.updateKeyframeValue(undefined, newX, newY);
        } else {
          // 精细剪切：0.2 灵敏度
          this.updateKeyframeValue(undefined, this.dragStartValX + dxL * 0.2, this.dragStartValY + dyL * 0.2);
        }
      }
    }

    this.onUpdate();
  };

  private onMouseUp = (): void => {
    if (!this.dragging || !this.selectedBone || !this.dragChannel) {
      this.dragging = false;
      return;
    }

    // 拖拽结束，发送信息用于创建 Undo command
    if (this.onDragEnd) {
      const anim = this.editor.getAnimation();
      if (anim) {
        const track = anim.boneTracks.get(this.selectedBone);
        if (track) {
          const kfs = track[this.dragChannel];
          const kfIdx = kfs.findIndex(k => Math.abs(k.time - this.currentTime) < 0.01);
          if (kfIdx >= 0) {
            const kf = kfs[kfIdx];
            this.onDragEnd({
              boneName: this.selectedBone,
              channel: this.dragChannel,
              time: this.currentTime,
              createdNew: this.dragCreatedKf,
              oldValue: { ...this.dragStartKf },
              newValue: { value: kf.value, x: kf.x, y: kf.y },
              keyframeData: { ...kf },
            });
          }
        }
      }
    }

    this.dragging = false;
    this.dragMode = null;
  };

  private updateKeyframeValue(value?: number, x?: number, y?: number): void {
    if (!this.selectedBone || !this.dragChannel) return;

    const anim = this.editor.getAnimation();
    if (!anim) return;

    const track = anim.boneTracks.get(this.selectedBone);
    if (!track) return;

    const kfs = track[this.dragChannel];
    const kfIdx = kfs.findIndex(k => Math.abs(k.time - this.currentTime) < 0.01);
    if (kfIdx < 0) return;

    this.editor.updateKeyframeValue(this.selectedBone, this.dragChannel, kfIdx, { value, x, y });
  }

  // ── Bone picking ──
  // 点击 attachment 区域来选中其所属骨骼
  tryPickBone(x: number, y: number): string | null {
    const skeleton = this.spineManager.getSkeleton();
    if (!skeleton) return null;

    const drawOrder = skeleton.drawOrder?.appliedPose || skeleton.slots;
    if (!drawOrder) return null;
    // 从后往前遍历（后绘制的在上层，优先选中）
    for (let i = drawOrder.length - 1; i >= 0; i--) {
      const slot = drawOrder[i] as any;
      if (!slot.bone) continue;
      const pose = slot.appliedPose || slot.pose;
      const attachment = pose?.attachment;
      if (!attachment) continue;
      // 跳过透明的 slot（不可见）
      const color = pose.color;
      if (color && typeof color.a === 'number' && color.a <= 0) continue;

      let boneName: string | null = null;
      if (isRegionAttachment(attachment)) {
        const worldVertices = new Float32Array(8);
        try {
          attachment.computeWorldVertices(slot, attachment.getOffsets(pose), worldVertices, 0, 2);
        } catch (e) { continue; }
        // 检查点是否在四边形内（br, bl, ul, ur）
        if (pointInQuad(x, y, worldVertices)) {
          boneName = this.findBoneNameByRef(skeleton, slot.bone);
        }
      } else if (isMeshAttachment(attachment)) {
        const worldVertices = new Float32Array(attachment.worldVerticesLength);
        try {
          attachment.computeWorldVertices(skeleton, slot, 0, attachment.worldVerticesLength, worldVertices, 0, 2);
        } catch (e) { continue; }
        const triangles = attachment.triangles;
        // 检查点是否在任一三角形内
        for (let t = 0; t < triangles.length; t += 3) {
          const i0 = triangles[t] * 2, i1 = triangles[t + 1] * 2, i2 = triangles[t + 2] * 2;
          if (pointInTriangle(x, y,
            worldVertices[i0], worldVertices[i0 + 1],
            worldVertices[i1], worldVertices[i1 + 1],
            worldVertices[i2], worldVertices[i2 + 1])) {
            boneName = this.findBoneNameByRef(skeleton, slot.bone);
            break;
          }
        }
      }
      if (boneName) return boneName;
    }

    // 如果没点中任何 attachment，回退到骨骼点距离判断（小范围）
    const bones = this.editor.getBoneNames();
    let closestBone: string | null = null;
    let closestDist = 15;
    for (const boneName of bones) {
      const bone = skeleton.findBone(boneName);
      if (!bone) continue;
      const c = boneToCanvas(bone);
      const dist = Math.sqrt((x - c.x) ** 2 + (y - c.y) ** 2);
      if (dist < closestDist) {
        closestDist = dist;
        closestBone = boneName;
      }
    }
    return closestBone;
  }

  // 通过骨骼对象引用查找骨骼名称
  private findBoneNameByRef(skeleton: any, boneRef: any): string | null {
    const bones = this.editor.getBoneNames();
    for (const name of bones) {
      if (skeleton.findBone(name) === boneRef) return name;
    }
    return null;
  }

  destroy(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
  }
}