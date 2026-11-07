 

import { createLogger } from '@/shared/utils/logger';

const log = createLogger('TextSelection');

export interface TextSelection {
  text: string;
  element: HTMLElement;
  range?: Range;
}

 
export const getSelectedText = (): TextSelection | null => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const text = range.toString().trim();
  
  if (!text) {
    return null;
  }

  const commonAncestor = range.commonAncestorContainer;
  const element = commonAncestor.nodeType === Node.ELEMENT_NODE 
    ? commonAncestor as HTMLElement 
    : commonAncestor.parentElement;

  if (!element) {
    return null;
  }

  return {
    text,
    element,
    range
  };
};

 
export const clearSelection = (): void => {
  const selection = window.getSelection();
  if (selection) {
    selection.removeAllRanges();
  }
};

 
/**
 * 复制文本到剪贴板。
 *
 * WebView2 下 `navigator.clipboard.writeText` 在无窗口焦点/无用户激活时会走
 * 权限询问（弹出 edge://permission-request-dialog），表现为「点了复制没反应」。
 * 因此失败时退回 `execCommand('copy')`——它不需要该权限，能保证点击即复制。
 */
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      log.warn('Async clipboard rejected, falling back to execCommand', error);
    }
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.style.position = 'fixed';
  textArea.style.left = '-999999px';
  textArea.style.top = '-999999px';
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  try {
    return document.execCommand('copy');
  } catch (error) {
    log.error('Failed to copy text to clipboard', error);
    return false;
  } finally {
    document.body.removeChild(textArea);
  }
};

 
export const getElementText = (element: HTMLElement): string => {
  
  if (element.tagName === 'PRE' || element.tagName === 'CODE') {
    return element.textContent || '';
  }
  
  
  return element.innerText || element.textContent || '';
};
