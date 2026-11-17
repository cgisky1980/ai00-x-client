/**
 * WorkbenchCodeView — 代码预览（Shiki 高亮 + 行号）。
 *
 * 采用 `@kayingai/kaying-filetree` 的 `<agent-file-preview>` Web Component：
 * 它是命令式属性 API（filename / content / filePath / theme），没有 React 包装，
 * 所以这里用 createElement 挂载，避免全局 JSX 类型污染。
 *
 * 该模块只被懒加载（见 WorkbenchFilePreview 的 text 分支），Shiki 与组件本体
 * 不进主包。
 */
import React, { useEffect, useRef } from 'react';
import '@kayingai/kaying-filetree';
import { useTheme } from '@/infrastructure/theme/hooks/useTheme';
import './WorkbenchCodeView.scss';

export interface WorkbenchCodeViewProps {
  filename: string;
  content: string;
  /** 完整路径（组件内部面包屑用；我们已关掉）。 */
  filePath: string;
  fileSize?: number | null;
}

export const WorkbenchCodeView: React.FC<WorkbenchCodeViewProps> = ({
  filename,
  content,
  filePath,
  fileSize = null,
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { isLight } = useTheme();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const element = document.createElement('agent-file-preview') as HTMLElement & {
      filename: string;
      content: string;
      filePath: string;
      fileSize: number | null;
      showBreadcrumb: boolean;
      theme: 'light' | 'dark';
      shikiTheme?: string;
    };
    element.filename = filename;
    element.content = content;
    element.filePath = filePath;
    element.fileSize = fileSize;
    element.showBreadcrumb = false;
    element.theme = isLight ? 'light' : 'dark';
    host.appendChild(element);
    return () => {
      element.remove();
    };
  }, [filename, content, filePath, fileSize, isLight]);

  return <div className="ai00-x-code-view" ref={hostRef} />;
};

export default WorkbenchCodeView;
