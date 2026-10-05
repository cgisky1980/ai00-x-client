import type { DollManifest } from './types'

/** 模块级图片缓存：同 URL 只解码一次（多画布/换装复用）。 */
const imgCache = new Map<string, Promise<HTMLImageElement>>()

export function joinUrl(base: string, rel: string): string {
  return base.endsWith('/') ? base + rel : `${base}/${rel}`
}

export async function loadManifest(baseUrl: string): Promise<DollManifest> {
  const res = await fetch(joinUrl(baseUrl, 'manifest.json'))
  if (!res.ok) throw new Error(`paper-doll: manifest 加载失败 ${res.status} (${joinUrl(baseUrl, 'manifest.json')})`)
  return (await res.json()) as DollManifest
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  const hit = imgCache.get(url)
  if (hit) return hit
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`paper-doll: 图片加载失败 ${url}`))
    img.src = url
  })
  imgCache.set(url, p)
  return p
}
