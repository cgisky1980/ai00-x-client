import { useState, useRef, useEffect, useLayoutEffect } from "react"
import { createPortal } from "react-dom"
import { cn } from "@underlay/lib/utils"
import { Palette, X } from "lucide-react"

// 预设颜色（不含透明，透明度由滑块单独控制）
const PRESET_COLORS: { value: string, label: string }[] = [
  { value: "#3b82f6", label: "蓝" },
  { value: "#10b981", label: "绿" },
  { value: "#f59e0b", label: "橙" },
  { value: "#ef4444", label: "红" },
  { value: "#8b5cf6", label: "紫" },
  { value: "#ec4899", label: "粉" },
  { value: "#06b6d4", label: "青" },
  { value: "#facc15", label: "黄" },
  { value: "#374151", label: "深灰" },
  { value: "#1f2937", label: "夜色" },
  { value: "#ffffff", label: "白" },
  { value: "#000000", label: "黑" },
]

// 透明度范围
const OPACITY_MIN = 40
const OPACITY_MAX = 80
const OPACITY_DEFAULT = 60

const PANEL_WIDTH = 200
const PANEL_HEIGHT_ESTIMATE = 130 // 12 色面板 + 滑块 + 清除按钮

/** hex (#rrggbb) → rgba(r,g,b,a) */
function hexToRgba(hex: string, alpha: number): string | undefined {
  if (!hex) return undefined
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return undefined
  const r = parseInt(m[1].slice(0, 2), 16)
  const g = parseInt(m[1].slice(2, 4), 16)
  const b = parseInt(m[1].slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface ItemWrapperProps {
  /** 来自 GridItem.color 的颜色（hex；空字符串=清除颜色，undefined=未设置） */
  color?: string
  /** 当 color 未设置（undefined）时的回退颜色，例如 category.color */
  fallbackColor?: string
  /** 来自 GridItem.opacity 的不透明度 0-100（未设置=不应用背景色） */
  opacity?: number
  /** 颜色变化回调 */
  onColorChange?: (color: string) => void
  /** 透明度变化回调 */
  onOpacityChange?: (opacity: number) => void
  /** 是否禁用颜色按钮 */
  disableColorPicker?: boolean
  className?: string
  children: React.ReactNode
}

/**
 * 桌面网格元素的统一包裹器：
 * - 应用 GridItem.color + opacity 组合作为背景色
 * - 左上角 hover 显示颜色拾取按钮（点击展开预设色 + 透明度滑块）
 */
export function ItemWrapper({
  color,
  fallbackColor,
  opacity,
  onColorChange,
  onOpacityChange,
  disableColorPicker,
  className,
  children,
}: ItemWrapperProps) {
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [panelPos, setPanelPos] = useState<{ top: number, left: number } | null>(null)
  const paletteBtnRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // 打开面板时计算位置
  useLayoutEffect(() => {
    if (!paletteOpen) {
      setPanelPos(null)
      return
    }
    const btn = paletteBtnRef.current
    if (!btn) return
    const r = btn.getBoundingClientRect()
    let top = r.bottom + 4
    let left = r.left
    if (top + PANEL_HEIGHT_ESTIMATE > window.innerHeight) {
      top = r.top - PANEL_HEIGHT_ESTIMATE - 4
    }
    if (left + PANEL_WIDTH > window.innerWidth) {
      left = window.innerWidth - PANEL_WIDTH - 8
    }
    if (left < 8) left = 8
    setPanelPos({ top, left })
  }, [paletteOpen])

  // 点击外部关闭
  useEffect(() => {
    if (!paletteOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (paletteBtnRef.current?.contains(t)) return
      if (panelRef.current?.contains(t)) return
      setPaletteOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPaletteOpen(false)
    }
    window.addEventListener("mousedown", onDown)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("mousedown", onDown)
      window.removeEventListener("keydown", onKey)
    }
  }, [paletteOpen])

  // 背景色计算：
  // - color === "" → 清除颜色（透明）
  // - color !== undefined → 用 color + opacity 组合
  // - color === undefined && fallbackColor → 用 fallbackColor（实色）
  // - 都没有 → 不设置背景
  const bgColor = (() => {
    if (color === "") return "transparent"
    const hex = color !== undefined ? color : (fallbackColor && fallbackColor !== "" ? fallbackColor : undefined)
    if (!hex) return undefined
    if (opacity !== undefined && opacity >= 0 && opacity <= 100) {
      const rgba = hexToRgba(hex, opacity / 100)
      return rgba || hex
    }
    return hex
  })()

  const handlePick = (c: string) => {
    onColorChange?.(c)
    // 第一次选颜色时，若 opacity 未设置，给一个默认透明度
    if (onOpacityChange && opacity === undefined) {
      onOpacityChange(OPACITY_DEFAULT)
    }
  }

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation()
    onColorChange?.("")
    setPaletteOpen(false)
  }

  const handleOpacityInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value)
    if (!isNaN(v)) onOpacityChange?.(Math.max(OPACITY_MIN, Math.min(OPACITY_MAX, v)))
  }

  // 当前用于滑块显示的 opacity 值
  const sliderValue = opacity ?? OPACITY_DEFAULT

  return (
    <div
      className={cn(
        "w-full h-full relative group overflow-hidden rounded-xl",
        className
      )}
      style={{
        isolation: "isolate",
        position: "relative",
        backgroundColor: bgColor,
      }}
    >
      {children}

      {/* 左上角：颜色拾取按钮 */}
      {!disableColorPicker && (onColorChange || onOpacityChange) && (
        <div
          ref={paletteBtnRef}
          className={cn(
            "p-1 rounded-md bg-zinc-800/80 border border-white/10 text-white shadow-md cursor-pointer",
            "opacity-0 group-hover:opacity-100 transition-opacity pointer-events-auto",
            paletteOpen && "opacity-100"
          )}
          style={{ zIndex: 9999, position: "absolute", top: "8px", left: "8px" }}
          title="改变颜色"
          onClick={(e) => {
            e.stopPropagation()
            setPaletteOpen((v) => !v)
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Palette className="w-3.5 h-3.5" />
        </div>
      )}

      {/* 颜色 + 透明度面板（Portal 到 body） */}
      {paletteOpen && panelPos && createPortal(
        <div
          ref={panelRef}
          className="fixed bg-zinc-900/95 backdrop-blur-md border border-white/10 rounded-lg shadow-2xl p-2.5 flex flex-col gap-2"
          style={{
            top: `${panelPos.top}px`,
            left: `${panelPos.left}px`,
            width: `${PANEL_WIDTH}px`,
            zIndex: 100000,
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {/* 预设颜色网格 */}
          <div className="grid grid-cols-6 gap-1.5">
            {PRESET_COLORS.map((c) => {
              const isActive = color === c.value
              return (
                <button
                  key={c.label}
                  type="button"
                  title={c.label}
                  onClick={() => handlePick(c.value)}
                  className={cn(
                    "w-6 h-6 rounded-md border transition-transform hover:scale-110",
                    isActive ? "border-white ring-1 ring-white" : "border-white/15 hover:border-white/60"
                  )}
                  style={{ backgroundColor: c.value }}
                />
              )
            })}
          </div>

          {/* 透明度滑块（40-80%） */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[10px] text-white/70">
              <span>透明度</span>
              <span className="font-mono">{sliderValue}%</span>
            </div>
            <input
              type="range"
              min={OPACITY_MIN}
              max={OPACITY_MAX}
              value={sliderValue}
              onChange={handleOpacityInput}
              className="w-full h-1 accent-white cursor-pointer"
              style={{ pointerEvents: "auto" }}
            />
          </div>

          {/* 清除按钮 */}
          <button
            type="button"
            title="清除颜色"
            onClick={handleClear}
            className="px-2 py-1 text-[10px] text-white/80 bg-white/5 hover:bg-white/15 rounded border border-white/10 flex items-center justify-center gap-1"
          >
            <X className="w-3 h-3" /> 清除颜色
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}
