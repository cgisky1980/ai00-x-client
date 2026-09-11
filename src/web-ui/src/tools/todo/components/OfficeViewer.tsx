/**
 * Office 预览内核（懒加载封装）：@file-viewer/react + 三个精准 renderer
 * （word=doc/docx/odt · spreadsheet=xls/xlsx/ods/csv · pptx）。
 * 仅当交付物预览命中 Office 扩展名时由 DeliverablePreview 动态 import 本模块，
 * 渲染链不进主包；文件以 File 对象直喂（本地字节，免 URL）。
 * 不用 preset-office：其 pdf/ofd/iwork/hangul 链路与 vendor 字体/legacy-ppt
 * WASM 会给客户端产物增加 ~36MB。
 */
import React, { useMemo } from 'react';
import FileViewer from '@file-viewer/react';
import type { FileViewerRendererPluginInput } from '@file-viewer/core';
import wordRenderer from '@file-viewer/renderer-word';
import spreadsheetRenderer from '@file-viewer/renderer-spreadsheet';
import { pptxRenderer } from '@file-viewer/renderer-pptx';

interface OfficeViewerProps {
  /** 文件字节（plugin-fs readFile 读出） */
  data: ArrayBuffer | Uint8Array;
  /** 文件名（含扩展名——格式路由依据） */
  filename: string;
}

// 三个 renderer 各自以 HTMLDivElement 特化泛型，options.renderers 期望默认泛型
// ——库侧泛型摩擦，在集成边界统一收窄
const RENDERERS = [
  wordRenderer,
  spreadsheetRenderer,
  pptxRenderer,
] as unknown as FileViewerRendererPluginInput;

export const OfficeViewer: React.FC<OfficeViewerProps> = ({ data, filename }) => {
  const file = useMemo(() => new File([data], filename), [data, filename]);
  return (
    <div className="td-dlv-preview__office">
      <FileViewer
        file={file}
        options={{
          renderers: RENDERERS,
          theme: 'system',
          styleIsolation: 'shadow',
          toolbar: { position: 'bottom-right' },
        }}
      />
    </div>
  );
};
