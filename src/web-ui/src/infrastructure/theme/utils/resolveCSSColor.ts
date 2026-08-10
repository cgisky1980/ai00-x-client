/**
 * Resolves a CSS custom property (--var) to a hex color string.
 *
 * Creates a temporary element, applies the CSS variable as background-color,
 * reads the computed style, and converts the result to #RRGGBB.
 *
 * Supports browser-returned formats:
 * - rgb(r, g, b) / rgba(r, g, b, a)
 * - color(srgb r g b) / color(srgb r g b / a)
 * - oklch(l c h) — resolved via Canvas API when returned directly by browser
 * - #RRGGBB / #RRGGBBAA
 */

function parseRGBComponents(computed: string): [number, number, number] | null {
  const rgbaMatch = computed.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbaMatch) {
    return [
      parseInt(rgbaMatch[1], 10),
      parseInt(rgbaMatch[2], 10),
      parseInt(rgbaMatch[3], 10),
    ];
  }
  return null;
}

function parseSRGBComponents(computed: string): [number, number, number] | null {
  const srgbMatch = computed.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
  if (srgbMatch) {
    return [
      Math.round(parseFloat(srgbMatch[1]) * 255),
      Math.round(parseFloat(srgbMatch[2]) * 255),
      Math.round(parseFloat(srgbMatch[3]) * 255),
    ];
  }
  return null;
}

/**
 * Uses Canvas 2D API to convert any CSS color string to RGB components.
 * This is the ultimate fallback because the browser's rendering engine
 * already knows how to convert oklch(), lab(), color() etc. to RGB.
 */
function resolveViaCanvas(colorString: string): [number, number, number] | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    ctx.fillStyle = colorString;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return [data[0], data[1], data[2]];
  } catch {
    return null;
  }
}

function componentsToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

export function resolveCSSColorToHex(cssVar: string, fallback?: string): string | undefined {
  if (typeof document === 'undefined') {
    return fallback;
  }

  try {
    const el = document.createElement('div');
    el.style.backgroundColor = `var(${cssVar})`;
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    el.style.top = '-9999px';
    el.style.width = '1px';
    el.style.height = '1px';
    el.style.pointerEvents = 'none';
    document.body.appendChild(el);
    const computed = getComputedStyle(el).backgroundColor;
    document.body.removeChild(el);

    // Direct hex fallback
    if (computed.startsWith('#')) {
      return computed.length === 7 ? computed : computed.slice(0, 7);
    }

    let rgb = parseRGBComponents(computed);
    if (!rgb) {
      rgb = parseSRGBComponents(computed);
    }
    if (!rgb) {
      rgb = resolveViaCanvas(computed);
    }
    if (rgb) {
      return componentsToHex(rgb[0], rgb[1], rgb[2]);
    }

    return fallback;
  } catch {
    return fallback;
  }
}
