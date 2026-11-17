/**
 * WorkbenchFilePreview — 工作台中间标签区的内联文件预览。
 *
 * 按扩展名分流（md / 文本代码 / 图片 / 音视频 / pdf / office / 兜底），
 * 与「交付物预览弹窗」同一套读取逻辑：文本走 plugin-fs，媒体走资产协议，
 * Office 内核懒加载，>1MB 文本只读前 256KB。
 */
import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import { FileQuestion, FolderOpen } from 'lucide-react';
import { Markdown } from '@/component-library';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';
import { useI18n } from '@/infrastructure/i18n/hooks/useI18n';
import { baseName } from './useWorkbenchTabs';
import './WorkbenchFilePreview.scss';

const OfficeViewer = lazy(() =>
  import('@/tools/todo/components/OfficeViewer').then((m) => ({ default: m.OfficeViewer })),
);
// 代码预览（Shiki 高亮）同样懒加载：只有打开代码文件才拉这份 chunk
const WorkbenchCodeView = lazy(() =>
  import('./WorkbenchCodeView').then((m) => ({ default: m.WorkbenchCodeView })),
);

const TEXT_EXTS = new Set([
  'txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less',
  'html', 'htm', 'vue', 'svelte', 'py', 'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp',
  'hpp', 'cs', 'rb', 'php', 'sh', 'ps1', 'bat', 'cmd', 'yml', 'yaml', 'toml',
  'xml', 'log', 'csv', 'tsv', 'ini', 'cfg', 'conf', 'env', 'sql', 'gitignore',
]);
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);
const OFFICE_EXTS = new Set(['doc', 'docx', 'odt', 'xls', 'xlsx', 'xlsm', 'ods', 'csv', 'pptx']);

type Kind = 'markdown' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'office' | 'binary';

/** 1MB 以上文本只读前 256KB（防大文件撑爆内存） */
const SIZE_LIMIT = 1024 * 1024;
const READ_LIMIT = 256 * 1024;
/** Office 文档预览的字节上限（整文件读入内存喂给渲染器） */
const OFFICE_LIMIT = 64 * 1024 * 1024;

function kindOf(path: string): Kind {
  const match = /\.([a-z0-9]+)$/i.exec(path.trim());
  const ext = match ? match[1].toLowerCase() : '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (IMG_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}

/** 无法预览时的兜底面板（图标 + 说明 + 定位到文件夹）。 */
const PreviewFallback: React.FC<{ message: string; onReveal: () => void }> = ({
  message,
  onReveal,
}) => {
  const { t } = useI18n('common');
  return (
    <div className="ai00-x-wb-file-preview__fallback">
      <FileQuestion size={26} />
      <p>{message}</p>
      <button type="button" className="ai00-x-wb-file-preview__action" onClick={onReveal}>
        <FolderOpen size={12} />
        {t('nav.workbenchWindow.tabs.openInFolder')}
      </button>
    </div>
  );
};

export interface WorkbenchFilePreviewProps {
  /** 文件绝对路径。 */
  path: string;
  /** 是否显示顶部文件条（标签页里保留，弹窗里由弹窗标题承担）。 */
  showToolbar?: boolean;
}

export const WorkbenchFilePreview: React.FC<WorkbenchFilePreviewProps> = ({
  path,
  showToolbar = true,
}) => {
  const { t } = useI18n('common');
  const [content, setContent] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | Uint8Array | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = useMemo(() => kindOf(path), [path]);
  const fileName = useMemo(() => baseName(path), [path]);

  useEffect(() => {
    // 媒体/PDF 走资产协议 URL，Office 走独立字节流，二者不进文本装载逻辑
    if (kind !== 'markdown' && kind !== 'text' && kind !== 'office') {
      setContent(null);
      setBytes(null);
      setTruncated(false);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setContent(null);
    setBytes(null);
    setTruncated(false);
    setError(null);
    void (async () => {
      try {
        const meta = await stat(path).catch(() => null);
        const size = meta?.size ?? 0;
        const buf = await readFile(path);
        if (cancelled) return;
        if (kind === 'office') {
          if (size > OFFICE_LIMIT || buf.byteLength > OFFICE_LIMIT) {
            setError(t('nav.workbenchWindow.tabs.fileTooLarge', { size: 64 }));
            return;
          }
          setBytes(buf);
          return;
        }
        const overLimit = size > SIZE_LIMIT || buf.byteLength > SIZE_LIMIT;
        const slice = overLimit ? buf.slice(0, READ_LIMIT) : buf;
        setContent(new TextDecoder('utf-8', { fatal: false }).decode(slice));
        setTruncated(overLimit);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, kind, t]);

  const reveal = (): void => {
    workspaceAPI.revealInExplorer(path).catch(() => undefined);
  };

  const assetUrl = useMemo(
    () => (kind !== 'markdown' && kind !== 'text' ? convertFileSrc(path) : null),
    [path, kind],
  );

  return (
    <div className="ai00-x-wb-file-preview">
      {showToolbar && (
        <div className="ai00-x-wb-file-preview__bar">
          <span className="ai00-x-wb-file-preview__name" title={path}>
            {fileName}
          </span>
          <span className="ai00-x-wb-file-preview__path" title={path}>
            {path}
          </span>
          <button
            type="button"
            className="ai00-x-wb-file-preview__action"
            onClick={reveal}
            title={t('nav.workbenchWindow.tabs.openInFolder')}
          >
            <FolderOpen size={12} />
            {t('nav.workbenchWindow.tabs.openInFolder')}
          </button>
        </div>
      )}

      <div className="ai00-x-wb-file-preview__body">
        {(kind === 'markdown' || kind === 'text') &&
          (error ? (
            <PreviewFallback message={error} onReveal={reveal} />
          ) : content === null ? (
            <p className="ai00-x-wb-file-preview__hint">{t('nav.workbenchWindow.tabs.loading')}</p>
          ) : kind === 'markdown' ? (
            <div className="ai00-x-wb-file-preview__md">
              {truncated && (
                <p className="ai00-x-wb-file-preview__notice">
                  {t('nav.workbenchWindow.tabs.truncated')}
                </p>
              )}
              <Markdown content={content} />
            </div>
          ) : (
            <>
              {truncated && (
                <p className="ai00-x-wb-file-preview__notice">
                  {t('nav.workbenchWindow.tabs.truncated')}
                </p>
              )}
              <Suspense
                fallback={
                  <p className="ai00-x-wb-file-preview__hint">
                    {t('nav.workbenchWindow.tabs.loadingKernel')}
                  </p>
                }
              >
                <WorkbenchCodeView filename={fileName} content={content} filePath={path} />
              </Suspense>
            </>
          ))}
        {kind === 'image' && (
          <img className="ai00-x-wb-file-preview__img" src={assetUrl ?? ''} alt={fileName} />
        )}
        {kind === 'audio' && (
          <audio className="ai00-x-wb-file-preview__media" src={assetUrl ?? ''} controls />
        )}
        {kind === 'video' && (
          <video className="ai00-x-wb-file-preview__media" src={assetUrl ?? ''} controls />
        )}
        {kind === 'pdf' && (
          <iframe className="ai00-x-wb-file-preview__pdf" src={assetUrl ?? ''} title={fileName} />
        )}
        {kind === 'office' &&
          (error ? (
            <PreviewFallback message={error} onReveal={reveal} />
          ) : bytes === null ? (
            <p className="ai00-x-wb-file-preview__hint">{t('nav.workbenchWindow.tabs.loading')}</p>
          ) : (
            <Suspense
              fallback={
                <p className="ai00-x-wb-file-preview__hint">
                  {t('nav.workbenchWindow.tabs.loadingKernel')}
                </p>
              }
            >
              <OfficeViewer data={bytes} filename={fileName} />
            </Suspense>
          ))}
        {kind === 'binary' && (
          <PreviewFallback
            message={t('nav.workbenchWindow.tabs.unsupported')}
            onReveal={reveal}
          />
        )}
      </div>
    </div>
  );
};

export default WorkbenchFilePreview;
