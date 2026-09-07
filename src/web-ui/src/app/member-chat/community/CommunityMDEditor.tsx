/**
 * CommunityMDEditor — 社区帖子 Markdown 编辑器
 *
 * 基于 fork Vditor（@ai00-x/vditor，上游 v4.0.0 自维护快照）的所见即所得模式（单模式精简版，
 * ir/sv 分屏模式已从 fork 移除）。
 * 媒体整合（P1.1）：工具栏图片按钮/拖拽/粘贴 → onImagesPicked 上抛（由 Composer 走
 * /media/upload 上传进九宫格，不内插正文）；工具栏「插入视频」→ onInsertVideo 上抛弹窗。
 * 受控接口：value（MD 源文）/ onChange（MD 源文）；外部 value 重置时同步回编辑器。
 *
 * ⚠️ 初始化时序：Vditor 的 initUI 在 lute 脚本加载完成后的微任务里执行（fork 已内联
 * zh_CN/en_US 语言包消除 i18n 异步；lute 走 _lutePath 本地资产）。在 `after` 回调触发前，
 * 实例的 vditor.wysiwyg / currentMode 未就绪，任何 getValue/setValue/enable 调用都会抛
 * "Cannot read properties of undefined (reading 'element')" —— 所有方法调用必须以 ready 门控。
 */
import React from 'react';
import Vditor from '@ai00-x/vditor';
import '@ai00-x/vditor/dist/index.css';
// lute 引擎为 3.7MB 全局脚本，不可打包进主 bundle；以 URL 资产随 dist 产出、本地加载
// （替代默认 jsdelivr CDN——境内不可达时 initUI 永远不会执行）
import luteUrl from '@ai00-x/vditor/dist/js/lute/lute.min.js?url';
import { useI18n } from '@/infrastructure/i18n';
import { useThemeStore } from '@/infrastructure/theme/store/themeStore';
import { searchMentionMembers } from './mention';
import type { MemberHit } from '../chatApi';

export interface CommunityMDEditorProps {
  /** MD 源文（受控） */
  value: string;
  onChange: (md: string) => void;
  disabled?: boolean;
  /** 图片上传：工具栏选择/拖拽/粘贴的图片上抛（Composer 统一上传进九宫格） */
  onImagesPicked?: (files: File[]) => void;
  /** 「插入视频」工具栏按钮点击（Composer 弹输入层） */
  onInsertVideo?: () => void;
}

/** 应用语言 → Vditor 语言键 */
const toVditorLang = (lang: string): 'zh_CN' | 'en_US' =>
  lang.toLowerCase().startsWith('zh') ? 'zh_CN' : 'en_US';

/** 自定义「插入视频」按钮图标（16×16 线性，currentColor） */
const VIDEO_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m10 9 5 3-5 3Z"/></svg>';

/** HTML 转义（hint 下拉项以原始 HTML 注入） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @提及自动补全候选（Vditor hint.extend：输入 @ 触发，value 插回光标处替换 @query） */
async function mentionHint(query: string) {
  const hits: MemberHit[] = await searchMentionMembers(query);
  return hits.map((h) => ({
    html: `<span class="community-hint-mention">${escapeHtml(h.nickname || h.username)}<small>@${escapeHtml(h.username)}</small></span>`,
    value: `@${h.username} `,
  }));
}

/**
 * 工具栏（气泡统一朝下 se）。
 * 编辑器位于弹窗顶部，Vditor 默认气泡朝上（n/ne）会被弹窗上缘裁切；
 * 按名覆盖 tipPosition，其余属性由 fork 的 mergeToolbar 按默认值合并。
 * upload/insert-video 为 P1.1 媒体整合项（行为上抛，不在编辑器内插内容）。
 */
const TOOLBAR: Array<
  string | { name: string; tipPosition?: 'se'; icon?: string; click?: () => void }
> = [
  'headings',
  'bold',
  'italic',
  'strike',
  'emoji',
  '|',
  'list',
  'ordered-list',
  'check',
  'quote',
  '|',
  'code',
  'inline-code',
  'link',
  'table',
  '|',
  'upload',
  { name: 'insert-video', tipPosition: 'se', icon: VIDEO_ICON },
  '|',
  'undo',
  'redo',
];

export const CommunityMDEditor: React.FC<CommunityMDEditorProps> = ({
  value,
  onChange,
  disabled = false,
  onImagesPicked,
  onInsertVideo,
}) => {
  const { t, currentLanguage } = useI18n('community');
  const themeType = useThemeStore((s) => s.currentTheme?.type);
  const vditorTheme = themeType === 'dark' ? ('dark' as const) : ('classic' as const);
  const lang = toVditorLang(currentLanguage ?? 'zh');

  const hostRef = React.useRef<HTMLDivElement>(null);
  const vditorRef = React.useRef<Vditor | null>(null);
  /** initUI 完成标记（after 回调置位；之前一切实例方法都不可调） */
  const readyRef = React.useRef(false);
  const [ready, setReady] = React.useState(false);
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  const tRef = React.useRef(t);
  tRef.current = t;
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const onImagesPickedRef = React.useRef(onImagesPicked);
  onImagesPickedRef.current = onImagesPicked;
  const onInsertVideoRef = React.useRef(onInsertVideo);
  onInsertVideoRef.current = onInsertVideo;
  /** 编辑器最近一次向外发出的 MD（防 onChange → value → setValue 回环） */
  const lastEmitRef = React.useRef(value);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    readyRef.current = false;
    setReady(false);
    let cancelled = false;
    const md0 = valueRef.current;
    lastEmitRef.current = md0;
    const vditor = new Vditor(host, {
      // wysiwyg 真所见即所得：加粗/标题等直接渲染，无 MD 噪声；存储仍为 MD
      mode: 'wysiwyg',
      theme: vditorTheme,
      lang,
      value: md0,
      height: 260,
      placeholder: tRef.current('composePlaceholder', {
        defaultValue: '分享点什么…（支持 Markdown）',
      }),
      cache: { enable: false },
      counter: { enable: true, max: 5000 },
      // @提及自动补全（fork Hint 的 hint.extend 自定义钩子：@ 触发 → mentionHint 查询 →
      // Enter/点击把 @username 插回 @ 起始位置；delay 200ms 内建防抖）
      hint: {
        delay: 200,
        extend: [{ key: '@', hint: mentionHint }],
      },
      // lute 本地资产：见文件头注释
      _lutePath: luteUrl,
      // 媒体整合：图片选择/拖拽/粘贴全部上抛 Composer 上传进九宫格；不在编辑器内插内容
      upload: {
        accept: 'image/*',
        multiple: true,
        handler: (files: File[] | null) => {
          if (files && files.length > 0) {
            onImagesPickedRef.current?.(Array.from(files));
          }
          // 返回空串 = 已处理，无需错误提示
          return '';
        },
      },
      toolbar: TOOLBAR.map((item) => {
        if (typeof item === 'string' || item.name !== 'insert-video') {
          return item;
        }
        // 自定义项在 init 时绑定当前回调（ref 透传，重建实例时更新）
        return { ...item, click: () => onInsertVideoRef.current?.() };
      }),
      after: () => {
        if (cancelled) {
          // 卸载早于 initUI：就地销毁，避免在已脱离的 host 上继续挂载
          try {
            vditor.destroy();
          } catch {
            /* init 未完成时 destroy 会访问未初始化字段，忽略 */
          }
          return;
        }
        readyRef.current = true;
        setReady(true);
      },
      input: (md) => {
        lastEmitRef.current = md;
        onChangeRef.current(md);
      },
    });
    vditorRef.current = vditor;
    return () => {
      cancelled = true;
      vditorRef.current = null;
      // init 未完成时 destroy 内部访问 this.vditor.element 会抛错；静默即可（init 侧有 isDestroyed 语义兜底）
      try {
        vditor.destroy();
      } catch {
        /* noop */
      }
    };
    // 主题/语言变化时整体重建（低频操作，可接受）；value/t/onChange 经 ref 读取
  }, [vditorTheme, lang]);

  // 外部 value 变化（清空草稿等）时同步进编辑器；ready 翻转后补跑一次，兜住 init 期间的 value 变更
  React.useEffect(() => {
    const vditor = vditorRef.current;
    if (!vditor || !readyRef.current) return;
    if (value !== lastEmitRef.current && value !== vditor.getValue()) {
      vditor.setValue(value);
      lastEmitRef.current = value;
    }
  }, [value, ready]);

  // 禁用态切换
  React.useEffect(() => {
    const vditor = vditorRef.current;
    if (!vditor || !readyRef.current) return;
    if (disabled) {
      vditor.disabled();
    } else {
      vditor.enable();
    }
  }, [disabled, vditorTheme, lang, ready]);

  return (
    <div className="community-md-editor" data-vditor-theme={vditorTheme}>
      <div ref={hostRef} className="community-md-editor__host" />
    </div>
  );
};
