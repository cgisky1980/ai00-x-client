/**
 * 硬件尽力检测（浏览器 API，失败留空由用户手动填）——约定见 2026-08-04 升级记录
 */

export function detectGpuModel(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") as WebGLRenderingContext | null;
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? "")
      : String(gl.getParameter(gl.RENDERER) ?? "");
    return renderer.trim();
  } catch {
    return "";
  }
}

/** 从渲染器字符串猜显存档位（与 questions.ais 的 gpu_vram 选项对齐） */
export function guessVramOptions(): string {
  const s = detectGpuModel().toLowerCase();
  const pick = (v: string) => v;
  if (/rtx\s*5090|rtx\s*5080/.test(s)) return pick("32G+");
  if (/4090|3090|a100|h100/.test(s)) return pick("24G");
  if (/4080|4070ti|3080ti|titan/.test(s)) return pick("16G");
  if (/4070|3080|2080ti|3060ti|t1200/.test(s)) return pick("12G");
  if (/3060|2060|1070|1080|1660|rx\s*5[67]00|arc\s*a7/.test(s)) return pick("8G");
  if (/1060|580|5600|1650|mx\d{3}|arc\s*a3/.test(s)) return pick("6G");
  if (/1050|1030|vega\s*[68]|uhd|iris/.test(s)) return pick("4G");
  return "";
}

/** navigator.deviceMemory（GB，仅 Chromium 系，向上取档） */
export function detectMemoryOption(): string {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (!dm || dm <= 0) return "";
  if (dm >= 128) return "128G+";
  if (dm >= 64) return "64G";
  if (dm >= 32) return "32G";
  if (dm >= 16) return "16G";
  return "8G";
}
