/**
 * usePopupResize — 8 方向边缘/角落拖拽调整弹窗大小。
 *
 * 配合 useDraggable 使用：useDraggable 控制 left/top，本 hook 控制 width/height。
 * 当从 west/north 边拖动时，需要同时调整 left/top 以保持右下角不动。
 *
 * @param options
 *   - initialSize: 初始大小 { width, height }
 *   - minWidth / minHeight: 最小尺寸（保证内容可读）
 *   - positionRef: 当前 position getter（用于读取起始 left/top）
 *   - setPosition: 来自 useDraggable 的 setPosition，用于 west/north 拖动时同步调整位置
 *   - elementRef: 弹窗 DOM ref，用于 getBoundingClientRect
 *
 * @returns
 *   - size: 当前大小
 *   - setSize: 直接设置大小
 *   - activeResize: 当前激活的拖动方向（null 表示未在拖动）
 *   - handleResizeMouseDown(dir): 返回 mousedown handler
 */
import { useState, useRef, useEffect, useCallback } from 'react'

export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface Size {
  width: number
  height: number
}

interface Position {
  x: number
  y: number
}

interface UsePopupResizeOptions {
  initialSize: Size
  minWidth: number
  minHeight: number
  getPosition: () => Position
  setPosition: (p: Position) => void
  elementRef: React.MutableRefObject<HTMLDivElement | null>
}

interface ResizeStart {
  x: number
  y: number
  width: number
  height: number
  left: number
  top: number
}

export function usePopupResize(options: UsePopupResizeOptions) {
  const {
    initialSize,
    minWidth,
    minHeight,
    getPosition,
    setPosition,
    elementRef,
  } = options

  const [size, setSize] = useState<Size>(initialSize)
  const [activeResize, setActiveResize] = useState<ResizeDir | null>(null)
  const resizeStartRef = useRef<ResizeStart>({ x: 0, y: 0, width: 0, height: 0, left: 0, top: 0 })
  // Keep latest min sizes in refs so the effect closure doesn't go stale
  const minWRef = useRef(minWidth)
  const minHRef = useRef(minHeight)
  minWRef.current = minWidth
  minHRef.current = minHeight

  const handleResizeMouseDown = useCallback(
    (dir: ResizeDir) => (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const el = elementRef.current
      const rect = el?.getBoundingClientRect()
      const pos = getPosition()
      resizeStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        width: size.width,
        height: size.height,
        left: rect?.left ?? pos.x,
        top: rect?.top ?? pos.y,
      }
      setActiveResize(dir)
    },
    [size.width, size.height, getPosition, elementRef],
  )

  useEffect(() => {
    if (!activeResize) return
    const dir = activeResize

    const handleMouseMove = (e: MouseEvent) => {
      const dx = e.clientX - resizeStartRef.current.x
      const dy = e.clientY - resizeStartRef.current.y
      let newWidth = resizeStartRef.current.width
      let newHeight = resizeStartRef.current.height
      let newLeft = resizeStartRef.current.left
      let newTop = resizeStartRef.current.top

      if (dir.includes('e')) {
        newWidth = Math.max(minWRef.current, resizeStartRef.current.width + dx)
      }
      if (dir.includes('s')) {
        newHeight = Math.max(minHRef.current, resizeStartRef.current.height + dy)
      }
      if (dir.includes('w')) {
        newWidth = Math.max(minWRef.current, resizeStartRef.current.width - dx)
        newLeft = resizeStartRef.current.left + (resizeStartRef.current.width - newWidth)
      }
      if (dir.includes('n')) {
        newHeight = Math.max(minHRef.current, resizeStartRef.current.height - dy)
        newTop = resizeStartRef.current.top + (resizeStartRef.current.height - newHeight)
      }

      // Clamp to viewport (don't let the popup extend off-screen)
      const maxW = window.innerWidth - newLeft - 8
      const maxH = window.innerHeight - newTop - 8
      if (newWidth > maxW) {
        // If clamped from the right/bottom, just cap the size
        newWidth = Math.max(minWRef.current, maxW)
      }
      if (newHeight > maxH) {
        newHeight = Math.max(minHRef.current, maxH)
      }

      setSize({ width: newWidth, height: newHeight })
      setPosition({ x: newLeft, y: newTop })
    }

    const handleMouseUp = () => setActiveResize(null)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [activeResize, setPosition])

  return {
    size,
    setSize,
    activeResize,
    handleResizeMouseDown,
  }
}
