/**
 * CodeBlock —— AI 代码块（v0.15 AI 系）
 * mono 无高亮（design-system 零运行时依赖）；streaming 自动滚底；内置复制。
 */
import React, { useRef, useState, useEffect } from 'react';
import { label } from '../../../../lib/labels';
import './CodeBlock.scss';

export interface CodeBlockProps {
  code: string;
  /** 仅顶栏标签展示，不做语法高亮 */
  language?: string;
  /** 流式输出：容器自动滚到底 */
  streaming?: boolean;
  showLineNumbers?: boolean;
  /** px，默认 320 */
  maxHeight?: number;
  /** 顶栏内容（文件名等）；提供后显示顶栏 + 复制按钮 */
  header?: React.ReactNode;
  className?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({
  code,
  language,
  streaming = false,
  showLineNumbers = true,
  maxHeight = 320,
  header,
  className = '',
}) => {
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [code, streaming]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板不可用时静默 */
    }
  };

  const lines = code.split('\n');
  const showBar = header != null || language != null;

  return (
    <div className={['ai-code', className].filter(Boolean).join(' ')}>
      {showBar && (
        <div className="ai-code__bar">
          <span className="ai-code__lang">{header ?? language}</span>
          <button
            type="button"
            className="ai-code__copy"
            onClick={() => void copy()}
            aria-label={label('components.ai.copy', '复制')}
          >
            {copied ? label('components.ai.copied', '已复制') : label('components.ai.copy', '复制')}
          </button>
        </div>
      )}
      <div ref={scrollRef} className="ai-code__body" style={{ maxHeight }}>
        <pre>
          <code>
            {lines.map((line, i) => (
              <span className="ai-code__line" key={i}>
                {showLineNumbers && <span className="ai-code__ln" aria-hidden="true">{i + 1}</span>}
                <span className="ai-code__lc">{line || ' '}</span>
              </span>
            ))}
          </code>
        </pre>
        {streaming && <span className="ai-code__cursor" aria-hidden="true" />}
      </div>
    </div>
  );
};
