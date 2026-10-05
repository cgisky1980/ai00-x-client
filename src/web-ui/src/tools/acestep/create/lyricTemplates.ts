/**
 * Built-in lyric structure templates (常见曲式).
 *
 * Section orders follow the official ACE-Step tutorial's structural tag
 * guidance. Selecting a template FILLS the sections with short sample
 * lyrics so the user can start from existing words (改词即可); empty
 * sections show the writing hint as placeholder.
 */

export interface TemplateBlock {
  tag: string;
  hint: string;
  /** Sample lines pre-filled on template selection (user edits them). */
  sample: string[];
}

export interface LyricTemplate {
  id: string;
  /** zh name shown in the picker (en name resolved via i18n when present). */
  nameZh: string;
  nameEn: string;
  /** Short description of the feel. */
  descZh: string;
  blocks: TemplateBlock[];
}

export const LYRIC_TEMPLATES: LyricTemplate[] = [
  {
    id: 'classic-pop',
    nameZh: '经典流行',
    nameEn: 'Classic Pop',
    descZh: '主歌铺垫 → 预副歌蓄力 → 副歌爆发',
    blocks: [
      { tag: 'Intro', hint: '（器乐前奏，可留空）', sample: [] },
      {
        tag: 'Verse 1',
        hint: '四行左右，铺垫场景与情绪，每行 6-10 字',
        sample: ['晚风穿过旧街道', '路灯把影子拉长', '你说过的话还在', '在耳边轻轻发烫'],
      },
      {
        tag: 'Pre-Chorus',
        hint: '两行，情绪蓄力，推向副歌',
        sample: ['心跳开始变得滚烫', '有些话再也藏不住'],
      },
      {
        tag: 'Chorus',
        hint: '四行，全曲最抓耳的记忆点，可重复核心句',
        sample: ['就趁夜色正漂亮', '把心事都点亮', '哪怕明天天各一方', '今晚我们尽情唱'],
      },
      {
        tag: 'Verse 2',
        hint: '四行，推进故事，与主歌 1 音节相近',
        sample: ['时光走得不声不响', '带走了那年的冲动', '可每次抬头看月亮', '还是会想起你模样'],
      },
      { tag: 'Pre-Chorus', hint: '两行，与第一遍预副歌呼应', sample: ['心跳再次变得滚烫', '这一次我不会退让'] },
      { tag: 'Chorus', hint: '重复副歌，可微调最后一行', sample: ['就趁夜色正漂亮', '把心事都点亮', '哪怕明天天各一方', '今晚我们尽情唱'] },
      {
        tag: 'Bridge',
        hint: '两行，转折或升华，情绪对比',
        sample: ['如果回忆会发光', '那一定是你的方向'],
      },
      { tag: 'Final Chorus', hint: '收束全曲，力度最强', sample: ['就趁夜色正漂亮', '把心事都点亮', '哪怕明天天各一方', '这一夜我们尽情唱'] },
      { tag: 'Outro', hint: '（尾声，可留空或 [Fade Out]）', sample: [] },
    ],
  },
  {
    id: 'folk-narrative',
    nameZh: '民谣叙事',
    nameEn: 'Folk Narrative',
    descZh: '平铺直叙讲故事，副歌轻收',
    blocks: [
      {
        tag: 'Verse 1',
        hint: '四行，交代时间地点人物',
        sample: ['九月的小城很安静', '我背着吉他去远行', '站台上的风有点冷', '吹散了昨天的约定'],
      },
      {
        tag: 'Verse 2',
        hint: '四行，故事推进',
        sample: ['路过山也路过海', '路过陌生人的对白', '每张车票都是路牌', '指向还没有的未来'],
      },
      {
        tag: 'Chorus',
        hint: '四行，点题的轻副歌',
        sample: ['走吧走吧别回头', '自由就在前方的路口', '就算走得慢一些', '也要走到心里去'],
      },
      {
        tag: 'Verse 3',
        hint: '四行，故事收尾',
        sample: ['多年后再回到小城', '老槐树下还坐着等', '那些流浪过的黄昏', '都变成了眼里星辰'],
      },
      { tag: 'Chorus', hint: '重复副歌', sample: ['走吧走吧别回头', '自由就在前方的路口', '就算走得慢一些', '也要走到心里去'] },
      { tag: 'Outro', hint: '（尾声，可留空）', sample: [] },
    ],
  },
  {
    id: 'rap-hook',
    nameZh: '说唱嘻哈',
    nameEn: 'Rap / Hip-Hop',
    descZh: 'Verse 念白 + Hook 旋律钩子',
    blocks: [
      { tag: 'Intro', hint: '（可写 [spoken word] 开场白）', sample: ['Yeah, check it'] },
      {
        tag: 'Verse 1',
        hint: '8 行左右说唱段落，韵脚一致，标注 [spoken word]',
        sample: ['[spoken word]', '凌晨两点的写字楼还亮着灯', '我揉了揉眼睛继续跟生活硬碰', '他们说安稳是唯一的选项', '可我偏要在格子间里做梦', '口袋很干净但野心很重', '每一步都算数从没有落空', '质疑声当成背景音效', '等我站起来他们会鼓掌尖叫'],
      },
      {
        tag: 'Chorus',
        hint: '4 行旋律钩子，简单上口',
        sample: ['不服就干到天亮', '汗水就是我的光', '跌倒了拍拍灰尘', '下一秒继续狂奔'],
      },
      {
        tag: 'Verse 2',
        hint: '8 行说唱，与 Verse 1 同韵式',
        sample: ['[spoken word]', '曾被现实按在地上摩擦', '也曾在深夜里自我怀疑啊', '但放弃这两个字我不会写', '字典里只有 reload 再来一遍', '时间是最好的裁判', '它看得见每一次加班', '现在我站在聚光灯下面', '把过去都变成笑谈'],
      },
      { tag: 'Chorus', hint: '重复钩子', sample: ['不服就干到天亮', '汗水就是我的光', '跌倒了拍拍灰尘', '下一秒继续狂奔'] },
      { tag: 'Outro', hint: '（收尾，可 [Fade Out]）', sample: [] },
    ],
  },
  {
    id: 'edm-drop',
    nameZh: '电子舞曲',
    nameEn: 'EDM',
    descZh: 'Build → Drop 能量结构',
    blocks: [
      { tag: 'Intro', hint: '（氛围铺底）', sample: [] },
      {
        tag: 'Verse 1',
        hint: '4 行，人声进入',
        sample: ['霓虹在夜空闪烁', '节奏撞进了心窝', '把手都举起来', '跟着我一起摇摆'],
      },
      { tag: 'Build', hint: '2-4 行，能量攀升', sample: ['三 二 一 跳进来', '让全世界的灯都打开'] },
      { tag: 'Drop', hint: '（能量释放，可留空或短句）', sample: ['Woah-oh-oh-oh!'] },
      { tag: 'Breakdown', hint: '2 行，抽掉鼓组留白', sample: ['安静下来 听心跳', '风暴前总有一秒静悄悄'] },
      { tag: 'Build', hint: '再次攀升', sample: ['最后一波 跟我唱', '把整片夜空都点燃'] },
      { tag: 'Drop', hint: '最后一波释放', sample: ['Woah-oh-oh-oh!'] },
      { tag: 'Outro', hint: '（淡出）', sample: [] },
    ],
  },
  {
    id: 'ballad',
    nameZh: '抒情慢歌',
    nameEn: 'Ballad',
    descZh: '钢琴叙事，副歌情感浓',
    blocks: [
      { tag: 'Intro', hint: '（钢琴前奏，可留空）', sample: [] },
      {
        tag: 'Verse 1',
        hint: '四行，轻声叙事',
        sample: ['窗外的雨下得很轻', '像你离开时的脚步声', '我数着杯里的涟漪', '一圈一圈都是曾经'],
      },
      {
        tag: 'Chorus',
        hint: '四行，情感浓烈',
        sample: ['我还想再抱你一次', '在梦醒来的位置', '如果思念有形状', '那一定是你的样子'],
      },
      {
        tag: 'Verse 2',
        hint: '四行，深入一层',
        sample: ['电话簿停在你的名字', '却再没有拨出去的勇气', '有些爱只能放在心底', '连问候都显得多余'],
      },
      { tag: 'Bridge', hint: '两行，低语转折 [whispered]', sample: ['[whispered]', '如果时光能倒流', '我想好好说再见'] },
      { tag: 'Final Chorus', hint: '全力收束', sample: ['我还想再抱你一次', '在梦醒来的位置', '如果思念有形状', '那全都是你的样子'] },
      { tag: 'Outro', hint: '（[Fade Out]）', sample: [] },
    ],
  },
  {
    id: 'kids-short',
    nameZh: '儿歌短曲',
    nameEn: 'Kids / Short',
    descZh: '短小 loop，词句简单重复',
    blocks: [
      {
        tag: 'Verse 1',
        hint: '四行短句，词语简单',
        sample: ['小星星 眨眼睛', '月亮船 摇啊摇', '小猫咪 喵喵叫', '宝宝闭上眼睛觉觉'],
      },
      {
        tag: 'Chorus',
        hint: '两行，重复度高、易跟唱',
        sample: ['啦啦啦 啦啦啦', '快乐的童年顶呱呱'],
      },
      {
        tag: 'Verse 2',
        hint: '四行短句',
        sample: ['小风车 转呀转', '糖果甜 笑脸圆', '小手手 拍一拍', '好梦就在眼前'],
      },
      { tag: 'Chorus', hint: '重复副歌', sample: ['啦啦啦 啦啦啦', '快乐的童年顶呱呱'] },
    ],
  },
];

export const INSTRUMENTAL_TEMPLATE_ID = '__instrumental__';

/** 歌词行数（跳过空行与纯标记行，如 [whispered]）→ 估算时长秒数。
 *  公式取自 ACE-Step 官方教程：每行 ≈3s + 前后奏 15s，取 10 的倍数；
 *  下限 60s（引擎 auto 只有 ~30s，太短）。 */
export function estimateDurationSec(
  segments: Array<{ lines: string[] }>,
  instrumental: boolean,
): number {
  if (instrumental) return 90;
  const lines = segments.flatMap((s) => s.lines).filter(
    (l) => l.trim().length > 0 && !/^\[[^\]]*\]$/.test(l.trim()),
  ).length;
  const raw = lines * 3 + 15;
  const rounded = Math.round(raw / 10) * 10;
  return Math.min(300, Math.max(60, rounded));
}

/** Find a template by id (returns null for the instrumental pseudo-template). */
export function findTemplate(id: string): LyricTemplate | null {
  return LYRIC_TEMPLATES.find((t) => t.id === id) ?? null;
}
