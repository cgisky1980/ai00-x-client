import { AnimationEditor, BoneChannel, CHANNEL_COLORS, getChannelValueType, type Keyframe } from './AnimationEditor';

const MARGIN = { top: 10, right: 40, bottom: 20, left: 50 };
const HANDLE_SIZE = 5;
const POINT_SIZE = 6;

export interface GraphEvent {
  type: 'select-keyframe' | 'update-curve-handle';
  keyframeIndex?: number;
  handleType?: 'in' | 'out';
  cx?: number;
  cy?: number;
}

export class GraphEditor {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private editor: AnimationEditor;
  private onEvent: (event: GraphEvent) => void;

  private boneName: string | null = null;
  private channel: BoneChannel | null = null;
  private playheadTime = 0;
  private scrollX = 0;
  private scrollY = 0;
  private zoomX = 1;
  private zoomY = 1;

  // Drag state
  private dragging: 'handle' | 'pan' | null = null;
  private dragKfIndex = -1;
  private dragHandleType: 'in' | 'out' = 'out';
  private lastMouseX = 0;
  private lastMouseY = 0;

  constructor(container: HTMLElement, editor: AnimationEditor, onEvent: (event: GraphEvent) => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 上下文');
    this.ctx = ctx;

    this.editor = editor;
    this.onEvent = onEvent;

    this.canvas.addEventListener('mousedown', this.onMouseDown);
    this.canvas.addEventListener('mousemove', this.onMouseMove);
    this.canvas.addEventListener('mouseup', this.onMouseUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });

    // 延迟 resize，确保 canvas 已被布局
    requestAnimationFrame(() => this.resize());
    window.addEventListener('resize', () => this.resize());
  }

  setBoneChannel(bone: string | null, channel: BoneChannel | null): void {
    this.boneName = bone;
    this.channel = channel;
    this.render();
  }

  setPlayhead(time: number): void {
    this.playheadTime = time;
    this.render();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';
    this.render();
  }

  // ── Coordinate helpers ──

  private getPlotArea(): { x: number; y: number; w: number; h: number } {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    return {
      x: MARGIN.left,
      y: MARGIN.top,
      w: w - MARGIN.left - MARGIN.right,
      h: h - MARGIN.top - MARGIN.bottom,
    };
  }

  private getValueRange(): { min: number; max: number } {
    const anim = this.editor.getAnimation();
    if (!anim || !this.boneName || !this.channel) return { min: -1, max: 1 };
    // slot 关键帧没有数值曲线
    if (this.channel === ('slot' as any)) return { min: -1, max: 1 };

    const track = anim.boneTracks.get(this.boneName);
    if (!track) return { min: -1, max: 1 };

    const kfs = track[this.channel as BoneChannel];
    if (!kfs || kfs.length === 0) return { min: -1, max: 1 };

    const valType = getChannelValueType(this.channel as BoneChannel);
    let min = Infinity;
    let max = -Infinity;

    for (const kf of kfs) {
      if (valType === 'scalar') {
        const v = kf.value ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      } else {
        const vx = kf.x ?? 0;
        const vy = kf.y ?? 0;
        if (vx < min) min = vx;
        if (vx > max) max = vx;
        if (vy < min) min = vy;
        if (vy > max) max = vy;
      }
    }

    if (min === max) {
      min -= 10;
      max += 10;
    }

    const padding = (max - min) * 0.1;
    return { min: min - padding, max: max + padding };
  }

  private timeToX(time: number, plot: { x: number; w: number }): number {
    const anim = this.editor.getAnimation();
    const duration = anim ? anim.duration : 1;
    return plot.x + (time / duration) * plot.w * this.zoomX - this.scrollX;
  }

  private valueToY(value: number, plot: { y: number; h: number }, range: { min: number; max: number }): number {
    const ratio = (value - range.min) / (range.max - range.min);
    return plot.y + plot.h - ratio * plot.h * this.zoomY + this.scrollY;
  }

  // ── Mouse events ──

  private onMouseDown = (e: MouseEvent): void => {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const plot = this.getPlotArea();
    if (x < plot.x || x > plot.x + plot.w || y < plot.y || y > plot.y + plot.h) return;

    const anim = this.editor.getAnimation();
    if (!anim || !this.boneName || !this.channel) return;
    // slot 关键帧没有曲线图，无法 hit test
    if (this.channel === ('slot' as any)) return;

    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;

    const kfs = track[this.channel as BoneChannel];
    if (!kfs) return;
    const range = this.getValueRange();

    // Check for handle hits
    for (let i = 0; i < kfs.length; i++) {
      const kf = kfs[i];
      const valType = getChannelValueType(this.channel as BoneChannel);
      const val = valType === 'scalar' ? (kf.value ?? 0) : (kf.x ?? 0);
      const kfX = this.timeToX(kf.time, plot);
      const kfY = this.valueToY(val, plot, range);

      // Check bezier handles (if not stepped)
      if (kf.curve !== 'stepped') {
        const inCx = this.getBezierHandle(kf, 'in', plot, i > 0 ? kfs[i - 1] : null, range);
        const outCx = this.getBezierHandle(kf, 'out', plot, i < kfs.length - 1 ? kfs[i + 1] : null, range);

        for (const [hType, hx, hy] of [['in', inCx[0], inCx[1]], ['out', outCx[0], outCx[1]]] as const) {
          if (Math.abs(x - hx) <= HANDLE_SIZE + 2 && Math.abs(y - hy) <= HANDLE_SIZE + 2) {
            this.dragging = 'handle';
            this.dragKfIndex = i;
            this.dragHandleType = hType;
            return;
          }
        }
      }

      // Check keyframe point hit
      if (Math.abs(x - kfX) <= POINT_SIZE + 2 && Math.abs(y - kfY) <= POINT_SIZE + 2) {
        this.onEvent({ type: 'select-keyframe', keyframeIndex: i });
        return;
      }
    }

    // Pan
    this.dragging = 'pan';
    this.lastMouseX = e.clientX;
    this.lastMouseY = e.clientY;
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (this.dragging === 'handle') {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const plot = this.getPlotArea();
      const range = this.getValueRange();

      // 获取当前关键帧和邻居的位置
      const anim = this.editor.getAnimation();
      if (anim && this.boneName && this.channel && this.dragKfIndex >= 0 && this.channel !== ('slot' as any)) {
        const track = anim.boneTracks.get(this.boneName);
        if (track) {
          const kfs = track[this.channel as BoneChannel];
          if (!kfs) return;
          const kf = kfs[this.dragKfIndex];
          if (kf) {
            const kfX = this.timeToX(kf.time, plot);
            const valType = getChannelValueType(this.channel as BoneChannel);
            const val = valType === 'scalar' ? (kf.value ?? 0) : (kf.x ?? 0);
            const kfY = this.valueToY(val, plot, range);

            // 计算归一化坐标 [0-1, 0-1]
            const neighbor = this.dragHandleType === 'out'
              ? (kfs[this.dragKfIndex + 1] || null)
              : (kfs[this.dragKfIndex - 1] || null);

            if (neighbor) {
              const neighborX = this.timeToX(neighbor.time, plot);
              const dx = neighborX - kfX;
              const valRange = range.max - range.min || 1;

              // 归一化：cx 相对于 dx，cy 相对于 valRange
              const normCx = dx !== 0 ? (x - kfX) / dx : 0.33;
              const normCy = -((y - kfY) / (valRange * this.zoomY * 0.3));

              this.onEvent({
                type: 'update-curve-handle',
                keyframeIndex: this.dragKfIndex,
                handleType: this.dragHandleType,
                cx: Math.max(0, Math.min(1, normCx)),
                cy: Math.max(-1, Math.min(1, normCy)),
              });
            }
          }
        }
      }
      this.render();
      return;
    }

    if (this.dragging === 'pan') {
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.scrollX = Math.max(0, this.scrollX - dx);
      this.scrollY = Math.max(0, this.scrollY - dy);
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.render();
    }
  };

  private onMouseUp = (): void => {
    this.dragging = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    this.zoomX = Math.max(0.5, Math.min(5, this.zoomX * (1 + delta)));
    this.zoomY = Math.max(0.5, Math.min(5, this.zoomY * (1 + delta)));
    this.render();
  };

  private getBezierHandle(kf: Keyframe, type: 'in' | 'out', plot: { x: number; y: number; w: number; h: number }, neighbor: { time: number } | null, range: { min: number; max: number }): [number, number] {
    const valType = getChannelValueType(this.channel as BoneChannel);
    const val = valType === 'scalar' ? (kf.value ?? 0) : (kf.x ?? 0);
    const kfX = this.timeToX(kf.time, plot);
    const kfY = this.valueToY(val, plot, range);

    if (!neighbor || kf.curve === 'stepped') {
      return [kfX, kfY];
    }

    // Default bezier handles: 1/3 of the distance to neighbor（线性插值的默认控制点）
    const dx = this.timeToX(neighbor.time, plot) - kfX;
    const defaultCx = dx / 3;

    if (type === 'in') {
      // in handle 来自下一关键帧的 curve 数据，当前模型不存储 in，使用默认值
      return [kfX - defaultCx, kfY];
    } else {
      // out handle 来自当前关键帧的 bezier.out
      const bezierOut = kf.bezier?.out;
      if (bezierOut) {
        // bezierOut 是归一化坐标 [0-1, 0-1]
        // cx: 时间方向，cy: 值方向
        const cx = bezierOut[0] * dx;
        const valRange = range.max - range.min || 1;
        const cy = -bezierOut[1] * valRange * this.zoomY * 0.3;
        return [kfX + cx, kfY + cy];
      }
      return [kfX + defaultCx, kfY];
    }
  }

  // ── Render ──

  render(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, w, h);

    // Background
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, w, h);

    const plot = this.getPlotArea();

    // Plot area background
    ctx.fillStyle = '#16162a';
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    const anim = this.editor.getAnimation();
    if (!anim || !this.boneName || !this.channel) {
      // Draw grid lines on empty plot
      this.drawGrid(ctx, plot);
      return;
    }

    // slot 关键帧没有曲线图（attachment 切换是离散值，不是数值曲线）
    // 直接显示空网格 + 提示文字
    if (this.channel === ('slot' as any)) {
      this.drawGrid(ctx, plot);
      ctx.fillStyle = '#888';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Slot attachment 切换（无曲线）', plot.x + plot.w / 2, plot.y + plot.h / 2);
      return;
    }

    const track = anim.boneTracks.get(this.boneName);
    if (!track) return;

    const kfs = track[this.channel as BoneChannel];
    if (!kfs || kfs.length === 0) return;

    const range = this.getValueRange();
    const valType = getChannelValueType(this.channel as BoneChannel);
    const color = CHANNEL_COLORS[this.channel as BoneChannel];

    // Draw grid
    this.drawGrid(ctx, plot);

    // Draw axis labels
    ctx.fillStyle = '#888';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    const ySteps = 5;
    for (let i = 0; i <= ySteps; i++) {
      const val = range.min + (range.max - range.min) * (i / ySteps);
      const yPos = this.valueToY(val, plot, range);
      ctx.fillText(val.toFixed(1), plot.x - 4, yPos + 3);
    }

    ctx.textAlign = 'center';
    const xSteps = 5;
    for (let i = 0; i <= xSteps; i++) {
      const t = anim.duration * (i / xSteps);
      const xPos = this.timeToX(t, plot);
      ctx.fillText(t.toFixed(2) + 's', xPos, plot.y + plot.h + 14);
    }

    // Draw curve segments
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;

    for (let i = 0; i < kfs.length - 1; i++) {
      const kf0 = kfs[i];
      const kf1 = kfs[i + 1];
      const v0 = valType === 'scalar' ? (kf0.value ?? 0) : (kf0.x ?? 0);
      const v1 = valType === 'scalar' ? (kf1.value ?? 0) : (kf1.x ?? 0);

      const x0 = this.timeToX(kf0.time, plot);
      const y0 = this.valueToY(v0, plot, range);
      const x1 = this.timeToX(kf1.time, plot);
      const y1 = this.valueToY(v1, plot, range);

      if (kf0.curve === 'stepped') {
        // Stepped: horizontal then vertical
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      } else {
        // Bezier curve
        const outHandle = this.getBezierHandle(kf0, 'out', plot, kf1, range);
        const inHandle = this.getBezierHandle(kf1, 'in', plot, kf0, range);

        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.bezierCurveTo(outHandle[0], outHandle[1], inHandle[0], inHandle[1], x1, y1);
        ctx.stroke();
      }
    }

    // Draw keyframe points
    for (let i = 0; i < kfs.length; i++) {
      const kf = kfs[i];
      const v = valType === 'scalar' ? (kf.value ?? 0) : (kf.x ?? 0);
      const kfX = this.timeToX(kf.time, plot);
      const kfY = this.valueToY(v, plot, range);

      // Point
      ctx.fillStyle = color;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(kfX, kfY, POINT_SIZE, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      if (kf.curve !== 'stepped') {
        const inHandle = this.getBezierHandle(kf, 'in', plot, i > 0 ? kfs[i - 1] : null, range);
        const outHandle = this.getBezierHandle(kf, 'out', plot, i < kfs.length - 1 ? kfs[i + 1] : null, range);

        // Draw handle lines
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);

        if (i > 0) {
          ctx.beginPath();
          ctx.moveTo(kfX, kfY);
          ctx.lineTo(inHandle[0], inHandle[1]);
          ctx.stroke();
        }
        if (i < kfs.length - 1) {
          ctx.beginPath();
          ctx.moveTo(kfX, kfY);
          ctx.lineTo(outHandle[0], outHandle[1]);
          ctx.stroke();
        }
        ctx.setLineDash([]);

        // Draw handle points
        const drawHandle = (hx: number, hy: number) => {
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(hx, hy, HANDLE_SIZE, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        };

        if (i > 0) drawHandle(inHandle[0], inHandle[1]);
        if (i < kfs.length - 1) drawHandle(outHandle[0], outHandle[1]);
      }
    }

    // ── Playhead ──
    const phX = this.timeToX(this.playheadTime, plot);
    if (phX >= plot.x && phX <= plot.x + plot.w) {
      ctx.strokeStyle = '#ff4757';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(phX, plot.y);
      ctx.lineTo(phX, plot.y + plot.h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Plot border
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  }

  private drawGrid(ctx: CanvasRenderingContext2D, plot: { x: number; y: number; w: number; h: number }): void {
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.5;

    // Horizontal grid lines
    for (let i = 0; i <= 5; i++) {
      const y = plot.y + (plot.h / 5) * i;
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
    }

    // Vertical grid lines
    for (let i = 0; i <= 5; i++) {
      const x = plot.x + (plot.w / 5) * i;
      ctx.beginPath();
      ctx.moveTo(x, plot.y);
      ctx.lineTo(x, plot.y + plot.h);
      ctx.stroke();
    }
  }

  destroy(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    // 从 DOM 中移除旧 canvas
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}