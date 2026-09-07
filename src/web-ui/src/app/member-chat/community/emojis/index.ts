/**
 * 灵印表情包（24 枚，切自品牌表情原图，黑底转透明 + 纯红噪点清理）。
 *
 * PNG 经 Vite 构建为带 hash 的绝对 URL（base /main/）。EMOJI_PACK 同时驱动两处：
 * - hint.emoji：表情面板列表（value 含 "." 时渲染为 <img src=value>，点击插入 `:key: `）；
 * - Lute PutEmojis（vditor index.ts 直接取 hint.emoji）：正文 `:key:` 渲染为
 *   <img alt=":key:" src=value>（自定义 value 不经 emojiSite 前缀拼接）。
 */

/** 面板展示顺序（两批原图各 6×4 网格行优先，情绪由浅入深分组） */
const ORDER = [
  'smile',
  'laugh',
  'smirk',
  'blush',
  'heart-eyes',
  'wink',
  'uwu',
  'star-struck',
  'oh',
  'shocked',
  'hmm',
  'unamused',
  'angry',
  'burn',
  'cry',
  'sob',
  'sad',
  'dizzy',
  'sweat',
  'yawn',
  'sleepy',
  'thinking',
  'smug',
  'kiss',
  // 第二批
  'cool',
  'love',
  'cheeky',
  'surprised',
  'tears',
  'nerd',
  'furious',
  'sulk',
  'dazed',
  'silly',
  'puzzled',
  'zzz',
  'heart-hands',
  'meh',
  'bawling',
  'flushed',
  'rofl',
  'ponder',
  'sparkle',
  'blow-kiss',
  'gasp',
  'yelling',
  'yummy',
  'flirt',
] as const;

const modules = import.meta.glob('./*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const byName: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => [
    path.slice(path.lastIndexOf('/') + 1).replace(/\.png$/, ''),
    url,
  ]),
);

/** key → 构建 URL；仅保留 ORDER 内声明的表情，保证面板顺序稳定 */
export const EMOJI_PACK: Record<string, string> = Object.fromEntries(
  ORDER.map((name) => [name, byName[name]]).filter(([, url]) => Boolean(url)),
);
