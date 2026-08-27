import React, { useCallback, useRef } from 'react'

/**
 * useHorizontalScroll — 灵动岛行内水平滚动（拖动 + 滚轮）。
 *
 * - 拖动：mousedown 记录 startX + scrollLeft，move 时位移写入 scrollLeft
 * - 滚轮：deltaY 转横向滚动（行内无纵向内容）
 * - 点击守卫：拖动位移 >= 5px 标记 didDrag，宿主按钮 onClick 先检查
 *   `if (scroll.didDrag.current) return`，避免拖动结束误触 click
 */
export interface HorizontalScroll {
  ref: React.RefObject<HTMLDivElement | null>
  didDrag: React.RefObject<boolean>
  onMouseDown: (e: React.MouseEvent) => void
  onMouseMove: (e: React.MouseEvent) => void
  onMouseUp: () => void
  onMouseLeave: () => void
  onWheel: (e: React.WheelEvent) => void
}

const DRAG_THRESHOLD = 5

export const useHorizontalScroll = (): HorizontalScroll => {
  const ref = useRef<HTMLDivElement>(null)
  const didDrag = useRef(false)
  const dragState = useRef<{ startX: number; scrollLeft: number; dragging: boolean }>({
    startX: 0,
    scrollLeft: 0,
    dragging: false,
  })

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    const el = ref.current
    if (!el) return
    dragState.current = {
      startX: e.clientX,
      scrollLeft: el.scrollLeft,
      dragging: true,
    }
    didDrag.current = false
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragState.current.dragging) return
    const el = ref.current
    if (!el) return
    const dx = e.clientX - dragState.current.startX
    if (Math.abs(dx) >= DRAG_THRESHOLD) didDrag.current = true
    el.scrollLeft = dragState.current.scrollLeft - dx
  }, [])

  const onMouseUp = useCallback(() => {
    dragState.current.dragging = false
  }, [])

  const onMouseLeave = useCallback(() => {
    dragState.current.dragging = false
  }, [])

  const onWheel = useCallback((e: React.WheelEvent) => {
    const el = ref.current
    if (!el) return
    // 行内没有纵向内容：垂直滚轮直接驱动横向滚动
    e.stopPropagation()
    if (e.deltaY !== 0) el.scrollLeft += e.deltaY
    else if (e.deltaX !== 0) el.scrollLeft += e.deltaX
  }, [])

  return { ref, didDrag, onMouseDown, onMouseMove, onMouseUp, onMouseLeave, onWheel }
}
