 

import React from 'react';
import { Code } from 'lucide-react';
import type { CodeSnippetContext, ValidationResult, RenderOptions } from '../../../types/context';
import type { 
  ContextTransformer, 
  ContextValidator, 
  ContextCardRenderer 
} from '../../../services/ContextRegistry';
import { i18nService } from '@/infrastructure/i18n';



export class CodeSnippetContextTransformer implements ContextTransformer<'code-snippet'> {
  readonly type = 'code-snippet' as const;
  
  transform(context: CodeSnippetContext): unknown {
    return {
      type: 'code_snippet',
      file: context.filePath,
      lines: {
        start: context.startLine,
        end: context.endLine
      },
      content: context.selectedText,
      language: context.language,
      context: {
        before: context.beforeContext,
        after: context.afterContext
      }
    };
  }
  
  estimateSize(context: CodeSnippetContext): number {
    let size = context.selectedText.length;
    if (context.beforeContext) size += context.beforeContext.length;
    if (context.afterContext) size += context.afterContext.length;
    return size;
  }
}



export class CodeSnippetContextValidator implements ContextValidator<'code-snippet'> {
  readonly type = 'code-snippet' as const;
  
  async validate(context: CodeSnippetContext): Promise<ValidationResult> {
    const warnings: string[] = [];
    
    
    if (context.startLine < 1) {
      return { valid: false, error: 'Start line must be greater than 0.' };
    }
    
    if (context.endLine < context.startLine) {
      return { valid: false, error: 'End line must be greater than or equal to start line.' };
    }
    
    
    const lineCount = context.endLine - context.startLine + 1;
    if (lineCount > 500) {
      warnings.push(i18nService.t('components:contextSystem.validation.warnings.codeLinesLarge', { max: 500 }));
    }
    
    if (context.selectedText.length > 50000) {
      warnings.push(i18nService.t('components:contextSystem.validation.warnings.codeContentLarge', { maxChars: 50000 }));
    }
    
    
    if (!context.selectedText || context.selectedText.trim() === '') {
      return { valid: false, error: 'Selected code is empty.' };
    }
    
    return {
      valid: true,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }
  
  quickValidate(context: CodeSnippetContext): ValidationResult {
    if (!context.selectedText || context.selectedText.trim() === '') {
      return { valid: false, error: 'Code content is empty.' };
    }
    
    if (context.startLine < 1 || context.endLine < context.startLine) {
      return { valid: false, error: 'Invalid line range.' };
    }
    
    return { valid: true };
  }
}



export class CodeSnippetCardRenderer implements ContextCardRenderer<'code-snippet'> {
  readonly type = 'code-snippet' as const;
  
  render(context: CodeSnippetContext, options?: RenderOptions): React.ReactNode {
    const { compact = false, interactive = true, showPreview = true } = options || {};
    
    const lineCount = context.endLine - context.startLine + 1;
    const previewText = compact 
      ? context.selectedText.slice(0, 50) + (context.selectedText.length > 50 ? '...' : '')
      : context.selectedText.split('\n').slice(0, 3).join('\n');
    
    return (
      <div className={`ai00-x-context-card ai00-x-context-card--code-snippet ${compact ? 'ai00-x-context-card--compact' : ''}`}>
        <div className="ai00-x-context-card__icon">
          <Code size={compact ? 16 : 20} />
        </div>
        
        <div className="ai00-x-context-card__content">
          <div className="ai00-x-context-card__title">
            {context.fileName}
            <span className="ai00-x-context-card__badge">
              L{context.startLine}-{context.endLine}
            </span>
          </div>
          
          {!compact && (
            <>
              <div className="ai00-x-context-card__subtitle">
                {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                {context.language && (
                  <span className="ai00-x-context-card__meta">
                    {' • '}{context.language}
                  </span>
                )}
              </div>
              
              {showPreview && (
                <div className="ai00-x-context-card__preview">
                  <code className="ai00-x-context-card__code">
                    {previewText}
                  </code>
                </div>
              )}
            </>
          )}
        </div>
        
        {interactive && (
          <div className="ai00-x-context-card__actions">
            <button 
              className="ai00-x-context-card__action-btn"
              title={i18nService.t('components:contextSystem.contextCard.viewFullCode')}
            >
              <Code size={14} />
            </button>
          </div>
        )}
      </div>
    );
  }
}



export function getLanguageDisplayName(language?: string): string {
  const langMap: Record<string, string> = {
    'javascript': 'JavaScript',
    'typescript': 'TypeScript',
    'python': 'Python',
    'rust': 'Rust',
    'go': 'Go',
    'java': 'Java',
    'cpp': 'C++',
    'c': 'C',
    'csharp': 'C#',
    'html': 'HTML',
    'css': 'CSS',
    'scss': 'SCSS',
    'json': 'JSON',
    'yaml': 'YAML',
    'markdown': 'Markdown'
  };
  
  return language ? (langMap[language] || language) : 'Text';
}

export function getLanguageColor(language?: string): string {
  const colorMap: Record<string, string> = {
    'javascript': '#f7df1e',
    'typescript': '#3178c6',
    'python': '#3776ab',
    'rust': 'var(--color-bg-primary)',
    'go': '#00add8',
    'java': '#007396',
    'html': '#e34c26',
    'css': '#1572b6',
    'scss': '#cc6699'
  };
  
  return language ? (colorMap[language] || '#858585') : '#858585';
}
