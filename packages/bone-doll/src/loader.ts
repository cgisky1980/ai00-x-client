import type { SkeletonAsset } from './types'
import { validateSkeleton } from './math'

const jsonCache = new Map<string, Promise<SkeletonAsset>>()
const imgCache = new Map<string, Promise<HTMLImageElement>>()

export function joinUrl(base: string, rel: string): string {
  // 裸根 '/' 归一为空串，避免拼出 '//x'（协议相对 URL 会被当成外站 host）
  const b = base === '/' ? '' : base.endsWith('/') ? base.slice(0, -1) : base
  return `${b}/${rel}`
}

/**
 * 带重试的 fetch：页面加载早期的请求偶发瞬态失败（IAB 代理 / 桌面端 zip 懒解压首启竞态），
 * 短退避重试 3 次，重试仍失败才抛错。
 */
async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return res
      lastErr = new Error(`bone-doll: HTTP ${res.status} (${url})`)
    } catch (e) {
      lastErr = e
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 120 * (i + 1)))
  }
  throw lastErr instanceof Error ? lastErr : new Error(`bone-doll: fetch 失败 (${url})`)
}

function loadImageEl(url: string, attempts = 3): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    let attempt = 0
    const tryOnce = () => {
      attempt += 1
      const img = new Image()
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => {
        if (attempt < attempts) setTimeout(tryOnce, 120 * attempt)
        else reject(new Error(`bone-doll: 图片加载失败 ${url}`))
      }
      img.src = url
    }
    tryOnce()
  })
}

export async function loadSkeleton(baseUrl: string): Promise<SkeletonAsset> {
  const url = joinUrl(baseUrl, 'skeleton.json')
  const hit = jsonCache.get(url)
  if (hit) return hit
  const p = (async () => {
    const res = await fetchWithRetry(url)
    const json = (await res.json()) as SkeletonAsset
    const errs = validateSkeleton(json)
    if (errs.length > 0) throw new Error(`bone-doll: skeleton 校验失败 (${url})\n- ${errs.join('\n- ')}`)
    return json
  })()
  jsonCache.set(url, p)
  return p
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  const hit = imgCache.get(url)
  if (hit) return hit
  const p = loadImageEl(url)
  imgCache.set(url, p)
  return p
}
