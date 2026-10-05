/**
 * LyricsSegmentsEditor — segmented lyrics editor with bilingual structure
 * headers. Displays localized Chinese tags ([主歌]·Verse); submission always
 * serializes to the canonical English tags the engine expects (see
 * tagCatalog.serializeLyrics). Sections are reorderable via a pointer-based
 * drag on the ⠿ handle (GridDesktop-style live swap: once the dragged
 * section's center crosses a neighbour's center, the neighbour animates into
 * the freed slot with a FLIP transition); each section textarea is
 * fixed-size (no user resize) with internal vertical scrolling.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Plus, Trash2, ClipboardPaste, ArrowLeftRight, Copy } from 'lucide-react';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { Button, Modal, Popover, PopoverTrigger, PopoverContent, Textarea } from '@/component-library';
import { useCreateStore } from './createStore';
import { STRUCTURE_TAGS, parseLyricsText, zhTag, zhDescriptor, DESCRIPTOR_CHIPS } from './tagCatalog';
import { newId, type LyricsSegment } from './types';
import './CreateEditors.scss';

interface Props {
  creationId: string;
  /** Raw AI stream preview; when present the editor shows it instead. */
  streamingText?: string | null;
}

/** Pointer-drag session for live section reorder (all px in container-content coords). */
interface DragState {
  /** Dragged segment id. */
  id: string;
  /** Tentative visual order of segment ids. */
  order: string[];
  /** Dragged segment's visual top, following the pointer. */
  visualTop: number;
  /** Segment heights measured at drag start. */
  heights: Record<string, number>;
  /** Flex gap between segments. */
  gap: number;
  /** Container viewport top (constant while dragging). */
  containerTop: number;
  /** clientY - dragged element viewport top, captured at drag start. */
  grabOffsetY: number;
}

/** Layout top of `id` within `order`, from cached heights (transforms never affect layout). */
const slotTop = (order: string[], id: string, heights: Record<string, number>, gap: number): number => {
  let top = 0;
  for (const oid of order) {
    if (oid === id) return top;
    top += (heights[oid] ?? 0) + gap;
  }
  return top;
};

/** Remove all imperative FLIP/drag inline styles from segment nodes. */
const clearDragStyles = (refs: Map<string, HTMLDivElement>) => {
  for (const node of refs.values()) {
    node.style.transition = '';
    node.style.transform = '';
  }
};

const LyricsSegmentsEditor: React.FC<Props> = ({ creationId, streamingText }) => {
  const { t } = useI18n('acestep');
  const creation = useCreateStore((s) => s.creations.find((c) => c.id === creationId));
  const patchCreation = useCreateStore((s) => s.patchCreation);
  const [lang, setLang] = useState<'both' | 'zh' | 'en'>('both');
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  // pointer-drag live reorder state (dragRef = mutable mirror for move/up handlers)
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const segmentsRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingFlipRef = useRef<{ oldOrder: string[]; newOrder: string[] } | null>(null);
  // window 监听器持有的最新闭包引用（每次 render 在组件体内同步）
  const moveDragRef = useRef<((e: PointerEvent) => void) | null>(null);
  const endDragRef = useRef<((commit: boolean) => void) | null>(null);

  // FLIP: after a live reorder commits to the DOM, snap displaced neighbours
  // back to their previous visual position, then transition to the new slot.
  useLayoutEffect(() => {
    const flip = pendingFlipRef.current;
    const ds = dragRef.current;
    if (!flip || !ds) return;
    pendingFlipRef.current = null;
    for (const id of flip.newOrder) {
      if (id === ds.id) continue;
      const node = itemRefs.current.get(id);
      if (!node) continue;
      const delta = slotTop(flip.oldOrder, id, ds.heights, ds.gap) - slotTop(flip.newOrder, id, ds.heights, ds.gap);
      if (delta === 0) continue;
      // keep any in-flight offset so rapid successive swaps stay continuous
      const m = getComputedStyle(node).transform;
      const current = m === 'none' ? 0 : new DOMMatrixReadOnly(m).m42;
      node.style.transition = 'none';
      node.style.transform = `translateY(${current + delta}px)`;
    }
    // flush, then release to the target slot with the standard fast motion
    void segmentsRef.current?.offsetHeight;
    for (const id of flip.newOrder) {
      if (id === ds.id) continue;
      const node = itemRefs.current.get(id);
      if (!node) continue;
      node.style.transition = 'transform var(--motion-fast) var(--easing-standard)';
      node.style.transform = '';
    }
  }, [drag]);

  // Escape 取消拖动：不提交，弹回原顺序
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      endDragRef.current?.(false);
    };
    // 监听挂 window：换序时 React 会移动被拖 DOM 节点，挂在手柄子节点上的
    // pointer capture 有丢失风险（pointercancel 静默中断 = 拖到一半卡死）
    const onMove = (e: PointerEvent) => moveDragRef.current?.(e);
    const onUp = () => endDragRef.current?.(true);
    const onCancel = () => endDragRef.current?.(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
  }, [dragging]);

  if (!creation) return null;

  const setSegments = (segments: LyricsSegment[]) =>
    patchCreation(creationId, { lyricsSegments: segments });

  const addSegment = (kind: string) => {
    setAddOpen(false);
    setSegments([...creation.lyricsSegments, { id: newId('seg'), kind, lines: [] }]);
  };

  const duplicateSegment = (segId: string) => {
    const idx = creation.lyricsSegments.findIndex((s) => s.id === segId);
    if (idx === -1) return;
    const source = creation.lyricsSegments[idx];
    const clone: LyricsSegment = {
      ...source,
      id: newId('seg'),
      lines: [...source.lines],
      descriptors: source.descriptors ? [...source.descriptors] : undefined,
    };
    const next = [...creation.lyricsSegments];
    next.splice(idx + 1, 0, clone);
    setSegments(next);
  };

  const beginDrag = (e: React.PointerEvent, segId: string) => {
    if (e.button !== 0 || dragRef.current) return;
    const container = segmentsRef.current;
    const el = itemRefs.current.get(segId);
    if (!container || !el || creation.lyricsSegments.length < 2) return;
    e.preventDefault();
    const heights: Record<string, number> = {};
    for (const s of creation.lyricsSegments) {
      const node = itemRefs.current.get(s.id);
      if (node) heights[s.id] = node.getBoundingClientRect().height;
    }
    const gap = parseFloat(getComputedStyle(container).rowGap || '0') || 0;
    const state: DragState = {
      id: segId,
      order: creation.lyricsSegments.map((s) => s.id),
      visualTop: el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop,
      heights,
      gap,
      containerTop: container.getBoundingClientRect().top,
      grabOffsetY: e.clientY - el.getBoundingClientRect().top,
    };
    dragRef.current = state;
    setDrag(state);
  };

  const moveDrag = (e: PointerEvent) => {
    const ds = dragRef.current;
    const container = segmentsRef.current;
    if (!ds || !container) return;
    // 贴容器边缘自动滚动（长列表拖动不卡）
    const rect = container.getBoundingClientRect();
    if (e.clientY < rect.top + 24) container.scrollTop -= 8;
    else if (e.clientY > rect.bottom - 24) container.scrollTop += 8;
    const total =
      ds.order.reduce((acc, id) => acc + (ds.heights[id] ?? 0), 0) + ds.gap * Math.max(0, ds.order.length - 1);
    const h = ds.heights[ds.id] ?? 0;
    // pointer-driven visual top, clamped to the list bounds
    let visualTop = e.clientY - ds.grabOffsetY - ds.containerTop + container.scrollTop;
    visualTop = Math.max(0, Math.min(visualTop, total - h));
    const center = visualTop + h / 2;
    // 实时换位：插入槽位 = 中心被越过的邻段数。注意必须用**真实布局坐标**
    // （被拖段仍占位在流内，其高度计入后续槽位）——若按「移出压实」坐标算，
    // 被拖段下方元素的阈值会整体偏小一个被拖段高度，向下拖判定失真。
    let top = 0;
    let insertIndex = 0;
    for (const oid of ds.order) {
      const oh = ds.heights[oid] ?? 0;
      if (oid !== ds.id && center > top + oh / 2) insertIndex += 1;
      top += oh + ds.gap;
    }
    let order = ds.order;
    if (insertIndex !== ds.order.indexOf(ds.id)) {
      const others = ds.order.filter((x) => x !== ds.id);
      order = [...others.slice(0, insertIndex), ds.id, ...others.slice(insertIndex)];
      pendingFlipRef.current = { oldOrder: ds.order, newOrder: order };
    }
    const next = { ...ds, order, visualTop };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = (commit: boolean) => {
    const ds = dragRef.current;
    if (!ds) return;
    if (commit) {
      const byId = new Map(creation.lyricsSegments.map((s) => [s.id, s]));
      const next = ds.order.map((id) => byId.get(id)).filter((s): s is LyricsSegment => Boolean(s));
      if (next.length === creation.lyricsSegments.length && next.some((s, i) => s.id !== creation.lyricsSegments[i].id)) {
        setSegments(next);
      }
    }
    dragRef.current = null;
    pendingFlipRef.current = null;
    setDrag(null);
    clearDragStyles(itemRefs.current);
  };

  // window 监听器通过 ref 调最新闭包（moveDrag/endDrag 每次 render 重建）
  moveDragRef.current = moveDrag;
  endDragRef.current = endDrag;

  const importParsed = () => {
    const blocks = parseLyricsText(importText);
    setImportOpen(false);
    setImportText('');
    if (blocks.length === 0) return;
    setSegments(
      blocks.map((b) => ({
        id: newId('seg'),
        kind: b.tag,
        descriptors: b.descriptors.length > 0 ? b.descriptors.slice(0, 2) : undefined,
        lines: b.lines,
      })),
    );
  };

  const headerLabel = (kind: string): string => {
    const zh = zhTag(kind);
    if (lang === 'zh') return zh;
    if (lang === 'en') return kind;
    return `${zh} · ${kind}`;
  };

  /** 装饰词显示跟随语言：zh=中文 / en=原文 / both=中文·原文（序列化恒英文规范，不受影响）。 */
  const descLabel = (d: string): string =>
    lang === 'en' ? d : lang === 'zh' ? zhDescriptor(d) : `${zhDescriptor(d)}·${d}`;

  if (streamingText !== undefined && streamingText !== null) {
    return (
      <div className="ai00-x-lyrics-editor">
        <pre className="ai00-x-lyrics-editor__stream">{streamingText}</pre>
      </div>
    );
  }

  const displaySegments = drag
    ? drag.order
        .map((id) => creation.lyricsSegments.find((s) => s.id === id))
        .filter((s): s is LyricsSegment => Boolean(s))
    : creation.lyricsSegments;

  return (
    <div className="ai00-x-lyrics-editor">
      <div className="ai00-x-lyrics-editor__toolbar">
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger asChild>
            <Button size="small" variant="ghost">
              <Plus size={12} />
              {t('create.addSegment')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="ai00-x-lyrics-editor__tag-menu">
            {STRUCTURE_TAGS.map((tag) => (
              <button
                key={tag.en}
                type="button"
                className="ai00-x-lyrics-editor__tag-item"
                onClick={() => addSegment(tag.en)}
              >
                <span>{tag.zh}</span>
                <span className="ai00-x-lyrics-editor__tag-en">{tag.en}</span>
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <Button size="small" variant="ghost" onClick={() => setImportOpen(true)}>
          <ClipboardPaste size={12} />
          {t('create.importLyrics')}
        </Button>
        <div className="ai00-x-lyrics-editor__spacer" />
        <Button
          size="small"
          variant="ghost"
          title={t('create.toggleLang')}
          onClick={() => setLang(lang === 'both' ? 'zh' : lang === 'zh' ? 'en' : 'both')}
        >
          <ArrowLeftRight size={12} />
          {lang === 'both' ? '中/EN' : lang === 'zh' ? '中文' : 'EN'}
        </Button>
      </div>

      <div
        ref={segmentsRef}
        className={`ai00-x-lyrics-editor__segments${drag ? ' is-reordering' : ''}`}
      >
        {displaySegments.map((seg, idx) => {
          const isDragged = drag?.id === seg.id;
          const style: React.CSSProperties | undefined =
            drag && isDragged
              ? {
                  transform: `translateY(${drag.visualTop - slotTop(drag.order, seg.id, drag.heights, drag.gap)}px)`,
                  position: 'relative',
                  zIndex: 1,
                  transition: 'none',
                }
              : undefined;
          return (
            <div
              key={seg.id}
              ref={(node) => {
                if (node) itemRefs.current.set(seg.id, node);
                else itemRefs.current.delete(seg.id);
              }}
              className={`ai00-x-lyrics-editor__segment${isDragged ? ' is-dragging' : ''}`}
              style={style}
            >
              <div className="ai00-x-lyrics-editor__segment-head">
                <span
                  className="ai00-x-lyrics-editor__drag-handle"
                  title={t('create.dragSegment')}
                  onPointerDown={(e) => beginDrag(e, seg.id)}
                >
                  ⠿
                </span>
                <select
                  className="ai00-x-lyrics-editor__tag-select"
                  value={seg.kind}
                  onChange={(e) =>
                    setSegments(
                      creation.lyricsSegments.map((s) => (s.id === seg.id ? { ...s, kind: e.target.value } : s)),
                    )
                  }
                >
                  {STRUCTURE_TAGS.map((tag) => (
                    <option key={tag.en} value={tag.en}>
                      {headerLabel(tag.en)}
                    </option>
                  ))}
                </select>
                {/* 复合标记（规范 [Chorus - anthemic]，最多 2 个修饰词）：
                    徽章式多选，点选/取消；提交时按规范序列化。 */}
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={`ai00-x-lyrics-editor__desc-trigger${(seg.descriptors?.length ?? 0) > 0 ? ' has-desc' : ''}`}
                      title={t('create.tagDescTitle')}
                    >
                      {(seg.descriptors?.length ?? 0) === 0
                        ? t('create.tagDescHint')
                        : seg.descriptors!.map(descLabel).join(' · ')}
                      <Plus size={10} />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="ai00-x-lyrics-editor__desc-menu">
                    {DESCRIPTOR_CHIPS.map((chip) => {
                      const selected = seg.descriptors?.includes(chip.en) ?? false;
                      const full = (seg.descriptors?.length ?? 0) >= 2 && !selected;
                      return (
                        <button
                          key={chip.en}
                          type="button"
                          className={`ai00-x-lyrics-editor__chip${selected ? ' is-selected' : ''}`}
                          disabled={full}
                          title={`${chip.en}${full ? '（最多 2 个）' : ''}`}
                          onClick={() =>
                            setSegments(
                              creation.lyricsSegments.map((s) => {
                                if (s.id !== seg.id) return s;
                                const cur = s.descriptors ?? [];
                                const next = selected
                                  ? cur.filter((d) => d !== chip.en)
                                  : full
                                    ? cur
                                    : [...cur, chip.en];
                                return { ...s, descriptors: next.length > 0 ? next : undefined };
                              }),
                            )
                          }
                        >
                          {lang !== 'en' && <span>{chip.zh}</span>}
                          {lang !== 'zh' && (
                            <span className="ai00-x-lyrics-editor__chip-en">{chip.en}</span>
                          )}
                        </button>
                      );
                    })}
                  </PopoverContent>
                </Popover>
                <span className="ai00-x-lyrics-editor__segment-index">{idx + 1}</span>
                <button
                  type="button"
                  className="ai00-x-lyrics-editor__segment-copy"
                  title={t('create.copySegment')}
                  onClick={() => duplicateSegment(seg.id)}
                >
                  <Copy size={12} />
                </button>
                <button
                  type="button"
                  className="ai00-x-lyrics-editor__segment-delete"
                  title={t('create.deleteSegment')}
                  onClick={() => setSegments(creation.lyricsSegments.filter((s) => s.id !== seg.id))}
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {/* 固定大小（禁用拖拽 resize）+ 内部上下滚动 */}
              <Textarea
                className="ai00-x-lyrics-editor__segment-text"
                value={seg.lines.join('\n')}
                rows={4}
                placeholder={t('create.segmentPlaceholder')}
                onChange={(e) =>
                  setSegments(
                    creation.lyricsSegments.map((s) =>
                      s.id === seg.id ? { ...s, lines: e.target.value.split(/\r?\n/) } : s,
                    ),
                  )
                }
              />
            </div>
          );
        })}
        {creation.lyricsSegments.length === 0 && (
          <p className="ai00-x-lyrics-editor__empty">{t('create.lyricsEmpty')}</p>
        )}
      </div>

      <Modal isOpen={importOpen} onClose={() => setImportOpen(false)} title={t('create.importLyrics')}>
        <div className="ai00-x-lyrics-editor__import">
          <p className="ai00-x-lyrics-editor__import-hint">{t('create.importHint')}</p>
          <Textarea value={importText} rows={12} onChange={(e) => setImportText(e.target.value)} />
          <div className="ai00-x-lyrics-editor__import-actions">
            <Button size="small" variant="ghost" onClick={() => setImportOpen(false)}>
              {t('create.cancel')}
            </Button>
            <Button size="small" onClick={importParsed}>
              {t('create.importConfirm')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};

export default LyricsSegmentsEditor;
