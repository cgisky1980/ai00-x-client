export type ElementPalette = {
  name: string
  colors: Array<{ hue: number; saturation: number; lightness: number }>
}

export type SpellEffect = {
  id: number
  x: number
  y: number
  hue: number
  saturation: number
  lightness: number
  size: number
  type: 'burst' | 'ring' | 'spark' | 'triangle'
}

export type ClickEffect = {
  id: number
  x: number
  y: number
  text: string
  color: string
}

export const ELEMENT_PALETTES: ElementPalette[] = [
  {
    name: 'fire',
    colors: [
      { hue: 0, saturation: 100, lightness: 65 },
      { hue: 15, saturation: 100, lightness: 60 },
      { hue: 30, saturation: 100, lightness: 60 },
      { hue: 45, saturation: 100, lightness: 65 },
      { hue: 50, saturation: 95, lightness: 70 },
    ],
  },
  {
    name: 'ice',
    colors: [
      { hue: 190, saturation: 80, lightness: 65 },
      { hue: 200, saturation: 85, lightness: 70 },
      { hue: 210, saturation: 90, lightness: 72 },
      { hue: 220, saturation: 80, lightness: 75 },
      { hue: 195, saturation: 60, lightness: 82 },
    ],
  },
  {
    name: 'thunder',
    colors: [
      { hue: 50, saturation: 100, lightness: 75 },
      { hue: 55, saturation: 100, lightness: 70 },
      { hue: 270, saturation: 70, lightness: 72 },
      { hue: 260, saturation: 80, lightness: 75 },
      { hue: 60, saturation: 90, lightness: 85 },
    ],
  },
  {
    name: 'shadow',
    colors: [
      { hue: 270, saturation: 70, lightness: 65 },
      { hue: 280, saturation: 75, lightness: 68 },
      { hue: 290, saturation: 60, lightness: 70 },
      { hue: 260, saturation: 65, lightness: 62 },
      { hue: 300, saturation: 70, lightness: 68 },
    ],
  },
  {
    name: 'nature',
    colors: [
      { hue: 120, saturation: 70, lightness: 58 },
      { hue: 130, saturation: 75, lightness: 62 },
      { hue: 140, saturation: 65, lightness: 65 },
      { hue: 80, saturation: 80, lightness: 60 },
      { hue: 150, saturation: 60, lightness: 68 },
    ],
  },
]

export const BLESSING_WORDS_ZH = [
  '财运', '功德', '桃花运', '好运', '福气', '智商', '颜值', '运气', '健康', '快乐',
  '幸福', '财富', '智慧', '魅力', '人缘', '事业', '学业', '灵感', '创意', '能量',
  '元气', '幸运', '机遇', '贵人',
]

export const BLESSING_WORDS_EN = [
  'Luck', 'Fortune', 'Wisdom', 'Health', 'Happiness', 'Love', 'Joy', 'Success',
  'Wealth', 'Charm', 'Creativity', 'Energy', 'Harmony', 'Peace', 'Hope',
  'Courage', 'Inspiration', 'Vitality', 'Prosperity', 'Blessing',
  'Serendipity', 'Abundance', 'Confidence', 'Gratitude',
]

/** @deprecated Use BLESSING_WORDS_ZH or getBlessingWordsByLang instead */
export const BLESSING_WORDS = BLESSING_WORDS_ZH

export function getBlessingWordsByLang(lang: string): string[] {
  return lang.startsWith('zh') ? BLESSING_WORDS_ZH : BLESSING_WORDS_EN
}

export const BLESSING_COLORS = [
  '#FFD700', '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE',
  '#85C1E9', '#F8B500', '#FF69B4', '#00CED1', '#FFB6C1',
]

let _currentElementPalette: ElementPalette | null = null
let _gesturePoints: Array<{ x: number; y: number }> = []
let _lastGesturePoints: Array<{ x: number; y: number }> = []

export function getCurrentElementPalette(): ElementPalette | null {
  return _currentElementPalette
}

export function setCurrentElementPalette(palette: ElementPalette | null) {
  _currentElementPalette = palette
}

export function getGesturePoints(): Array<{ x: number; y: number }> {
  return _gesturePoints
}

export function getLastGesturePoints(): Array<{ x: number; y: number }> {
  return _lastGesturePoints
}

export function resetGesturePoints() {
  _gesturePoints = []
}

export function pushGesturePoint(point: { x: number; y: number }) {
  _gesturePoints.push(point)
}

export function saveLastGesturePoints() {
  _lastGesturePoints = [..._gesturePoints]
  _gesturePoints = []
}
