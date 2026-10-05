import { inflateSync } from 'node:zlib'

/**
 * 最小 PNG 解码器（RGBA 8bit 输出）——零依赖，供 Spine 生成器读部件图。
 * 支持：非交错；color type 6(RGBA) / 2(RGB) / 0(灰度)；bit depth 8；filter 0-4。
 * 素体图（encodePNG 产物）与浏览器 canvas.toBlob 产物均覆盖。
 */

export function decodePNG(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('png-decode: 非 PNG 签名')

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  let pos = 8
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (bitDepth !== 8) throw new Error(`png-decode: 不支持 bit depth ${bitDepth}`)
  if (interlace !== 0) throw new Error('png-decode: 不支持交错 PNG')
  const channels = { 6: 4, 2: 3, 0: 1 }[colorType]
  if (!channels) throw new Error(`png-decode: 不支持 color type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('png-decode: IDAT 数据不足')

  // 逐行 unfilter（filter 0-4）
  const lines = []
  const prev = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = new Uint8Array(raw.buffer, raw.byteOffset + y * (stride + 1) + 1, stride)
    const out = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      out[i] = v
    }
    lines.push(out)
    prev.set(out)
  }

  // → RGBA
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const line = lines[y]
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 6) {
        rgba[o] = line[x * 4]
        rgba[o + 1] = line[x * 4 + 1]
        rgba[o + 2] = line[x * 4 + 2]
        rgba[o + 3] = line[x * 4 + 3]
      } else if (colorType === 2) {
        rgba[o] = line[x * 3]
        rgba[o + 1] = line[x * 3 + 1]
        rgba[o + 2] = line[x * 3 + 2]
        rgba[o + 3] = 255
      } else {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = line[x]
        rgba[o + 3] = 255
      }
    }
  }
  return { width, height, rgba }
}

/** RGBA 内水平翻转（返回新缓冲） */
export function flipX(width, height, rgba) {
  const out = new Uint8Array(rgba.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4
      const d = (y * width + (width - 1 - x)) * 4
      out[d] = rgba[s]
      out[d + 1] = rgba[s + 1]
      out[d + 2] = rgba[s + 2]
      out[d + 3] = rgba[s + 3]
    }
  }
  return out
}
