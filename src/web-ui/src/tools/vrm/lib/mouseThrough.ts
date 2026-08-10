import { invoke } from '@tauri-apps/api/core'

interface Region {
  x: number
  y: number
  width: number
  height: number
}

let updateTimeout: ReturnType<typeof setTimeout> | null = null
let dragRegionRaf: number | null = null
let isDragging = false
let draggingRegion: Region | null = null

export function setDragging(dragging: boolean) {
  isDragging = dragging
  if (!dragging) {
    draggingRegion = null
    if (dragRegionRaf !== null) {
      cancelAnimationFrame(dragRegionRaf)
      dragRegionRaf = null
    }
  }
}

export function setDraggingRegion(region: Region | null) {
  draggingRegion = region
  if (isDragging && region) {
    if (dragRegionRaf === null) {
      dragRegionRaf = requestAnimationFrame(() => {
        dragRegionRaf = null
        updateRegions()
      })
    }
  }
}

function getMarkedRegions(): Region[] {
  if (isDragging && draggingRegion) {
    return [draggingRegion]
  }
  if (isDragging) return []

  const regions: Region[] = []
  const elements = document.querySelectorAll('.no-penetrate, [data-no-penetrate]')

  elements.forEach((el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      regions.push({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }
  })

  return regions
}

async function updateRegions() {
  const regions = getMarkedRegions()
  try {
    await invoke('set_no_penetrate_regions', { regions, forceUpdate: true })
  } catch (err) {
    console.error('Failed to update regions:', err)
  }
}

export function refreshRegions() {
  updateRegions()
}

function debouncedUpdate() {
  if (updateTimeout) {
    clearTimeout(updateTimeout)
  }
  updateTimeout = setTimeout(updateRegions, 100)
}

export function initMouseThrough(): () => void {
  const observer = new ResizeObserver(debouncedUpdate)
  observer.observe(document.body)

  document.body.addEventListener('DOMSubtreeModified', debouncedUpdate)

  updateRegions()

  return () => {
    observer.disconnect()
    document.body.removeEventListener('DOMSubtreeModified', debouncedUpdate)
    if (updateTimeout) {
      clearTimeout(updateTimeout)
    }
  }
}
