/**
 * DiffView —— 行内 diff 视图（v0.15 AI 系）
 * diff 算法归消费方；本组件只渲染 add/del/ctx/hunk 行。
 * 语义色仅表状态：add=success / del=error（规范 4.6）。
 */
import React from 'react';
import './DiffView.scss';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'hunk';
  oldNo?: number;
  newNo?: number;
  content: string;
}

export interface DiffViewProps {
  lines: DiffLine[];
  /** 顶栏文件路径 */
  filePath?: string;
  stats?: { additions: number; deletions: number };
  /** px，默认 320 */
  maxHeight?: number;
  className?: string;
}

export const DiffView: React.FC<DiffViewProps> = ({
  lines,
  filePath,
  stats,
  maxHeight = 320,
  className = '',
}) => (
  <div className={['ai-diff', className].filter(Boolean).join(' ')}>
    {(filePath != null || stats != null) && (
      <div className="ai-diff__bar">
        {filePath != null && <span className="ai-diff__path">{filePath}</span>}
        {stats != null && (
          <span className="ai-diff__stats">
            <span className="ai-diff__additions">+{stats.additions}</span>
            <span className="ai-diff__deletions">−{stats.deletions}</span>
          </span>
        )}
      </div>
    )}
    <div className="ai-diff__body" style={{ maxHeight }}>
      <table className="ai-diff__table">
        <tbody>
          {lines.map((line, i) => {
            if (line.type === 'hunk') {
              return (
                <tr key={i} className="ai-diff__hunk">
                  <td className="ai-diff__no" />
                  <td className="ai-diff__no" />
                  <td className="ai-diff__content">{line.content}</td>
                </tr>
              );
            }
            return (
              <tr key={i} className={`ai-diff__row ai-diff__row--${line.type}`}>
                <td className="ai-diff__no">{line.oldNo ?? ''}</td>
                <td className="ai-diff__no">{line.newNo ?? ''}</td>
                <td className="ai-diff__content">
                  <span className="ai-diff__sign" aria-hidden="true">
                    {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
                  </span>
                  {line.content || ' '}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </div>
);
