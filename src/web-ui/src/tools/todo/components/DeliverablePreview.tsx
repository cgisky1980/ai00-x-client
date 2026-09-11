/**
 * 交付物预览弹窗：按扩展名分流渲染（md / 文本代码 / 图片 / 音视频 / pdf /
 * 兜底），供策窗口计划面板「交付物」抽屉点击产物链接预览。
 * 文本读取走 plugin-fs（fs:read-all 已授权）；媒体走 convertFileSrc 资产协议
 * （assetProtocol.scope "**"）；「在文件夹中显示」走 workspaceAPI.revealInExplorer。
 * 安全阀：文本 >1MB 只读前 256KB 并标注「已截断」。
 */
import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { readFile, stat } from '@tauri-apps/plugin-fs';
import { FileQuestion, FolderOpen } from 'lucide-react';
import { Markdown, Modal } from '@/component-library';
import { workspaceAPI } from '@/infrastructure/api/service-api/WorkspaceAPI';

// Office 预览内核懒加载：只在命中 Office 扩展名时才拉取该 chunk 与其资产
const OfficeViewer = lazy(() =>
  import('./OfficeViewer').then(m => ({ default: m.OfficeViewer }))
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
// Office 文档族 → file-viewer 内核。仅装了 word/spreadsheet/pptx 三个 renderer，
// 此清单必须与之对齐（rtf/老 ppt 等未装链路走 binary 兜底，避免弹窗内报错）
const OFFICE_EXTS = new Set([
  'doc', 'docx', 'odt',
  'xls', 'xlsx', 'xlsm', 'ods', 'csv',
  'pptx',
]);

type Kind = 'markdown' | 'text' | 'image' | 'audio' | 'video' | 'pdf' | 'office' | 'binary';

/** 1MB 以上文本只读前 256KB（防大文件撑爆内存/弹窗） */
const SIZE_LIMIT = 1024 * 1024;
const READ_LIMIT = 256 * 1024;
/** Office 文档预览的字节上限（整文件读入内存喂给渲染器） */
const OFFICE_LIMIT = 64 * 1024 * 1024;

function kindOf(path: string): Kind {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  const e = m ? m[1].toLowerCase() : '';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'pdf') return 'pdf';
  if (IMG_EXTS.has(e)) return 'image';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (VIDEO_EXTS.has(e)) return 'video';
  if (OFFICE_EXTS.has(e)) return 'office';
  if (TEXT_EXTS.has(e)) return 'text';
  return 'binary';
}

export interface DeliverablePreviewProps {
  /** 预览的文件绝对路径；null = 关闭 */
  path: string | null;
  onClose: () => void;
}

export const DeliverablePreview: React.FC<DeliverablePreviewProps> = ({ path, onClose }) => {
  const [content, setContent] = useState<string | null>(null);
  const [bytes, setBytes] = useState<ArrayBuffer | Uint8Array | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = useMemo(() => (path ? kindOf(path) : 'binary'), [path]);
  const fileName = useMemo(() => {
    if (!path) return '';
    const norm = path.replace(/[\\/]+$/, '');
    const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return i >= 0 ? norm.slice(i + 1) : norm;
  }, [path]);

  useEffect(() => {
    if (!path) return;
    // 媒体/PDF 走资产协议 URL，Office 走独立字节流，二者不进文本装载逻辑
    if (kind !== 'markdown' && kind !== 'text' && kind !== 'office') {
      setContent(null);
      setBytes(null);
      setTruncated(false);
      setError(null);
      return;
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
            setError(`文件超过 ${Math.round(OFFICE_LIMIT / 1024 / 1024)}MB，不支持内置预览`);
            return;
          }
          setBytes(buf);
          return;
        }
        const overLimit = size > SIZE_LIMIT || buf.byteLength > SIZE_LIMIT;
        const slice = overLimit ? buf.slice(0, READ_LIMIT) : buf;
        const text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
        setContent(text);
        setTruncated(overLimit);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, kind]);

  const reveal = () => {
    if (path) workspaceAPI.revealInExplorer(path).catch(() => undefined);
  };

  const assetUrl = useMemo(
    () => (path && kind !== 'markdown' && kind !== 'text' ? convertFileSrc(path) : null),
    [path, kind]
  );

  return (
    <Modal
      isOpen={!!path}
      onClose={onClose}
      title={`预览 · ${fileName}`}
      size="xlarge"
    >
      <div className="td-dlv-preview">
        {(kind === 'markdown' || kind === 'text') && (
          error ? (
            <div className="td-dlv-preview__fallback">
              <FileQuestion size={28} />
              <p>读取失败：{error}</p>
              <button className="td-chip" onClick={reveal}>
                <FolderOpen size={11} /> 在文件夹中显示
              </button>
            </div>
          ) : content === null ? (
            <div className="td-dlv-preview__loading">读取中…</div>
          ) : kind === 'markdown' ? (
            <div className="td-dlv-preview__md">
              {truncated && <div className="td-dlv-preview__notice">文件较大，仅显示前 256KB</div>}
              <Markdown content={content} />
            </div>
          ) : (
            <div className="td-dlv-preview__code">
              {truncated && <div className="td-dlv-preview__notice">文件较大，仅显示前 256KB</div>}
              <pre>{content}</pre>
            </div>
          )
        )}
        {kind === 'image' && <img className="td-dlv-preview__img" src={assetUrl ?? ''} alt={fileName} />}
        {kind === 'audio' && <audio className="td-dlv-preview__media" src={assetUrl ?? ''} controls />}
        {kind === 'video' && <video className="td-dlv-preview__media" src={assetUrl ?? ''} controls />}
        {kind === 'pdf' && <iframe className="td-dlv-preview__pdf" src={assetUrl ?? ''} title={fileName} />}
        {kind === 'office' && (
          error ? (
            <div className="td-dlv-preview__fallback">
              <FileQuestion size={28} />
              <p>{error}</p>
              <button className="td-chip" onClick={reveal}>
                <FolderOpen size={11} /> 在文件夹中显示
              </button>
            </div>
          ) : bytes === null ? (
            <div className="td-dlv-preview__loading">读取中…</div>
          ) : (
            <Suspense fallback={<div className="td-dlv-preview__loading">加载预览内核…</div>}>
              <OfficeViewer data={bytes} filename={fileName} />
            </Suspense>
          )
        )}
        {kind === 'binary' && (
          <div className="td-dlv-preview__fallback">
            <FileQuestion size={28} />
            <p>该文件类型暂不支持内置预览</p>
            <button className="td-chip" onClick={reveal}>
              <FolderOpen size={11} /> 在文件夹中显示
            </button>
          </div>
        )}
        <div className="td-dlv-preview__foot">
          <span className="td-dlv-preview__path">{path}</span>
          <button className="td-chip" onClick={reveal} title="在资源管理器中定位该文件">
            <FolderOpen size={11} /> 在文件夹中显示
          </button>
        </div>
      </div>
    </Modal>
  );
};
