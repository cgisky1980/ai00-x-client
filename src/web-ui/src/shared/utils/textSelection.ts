 

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

 
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    } else {
      
      const textArea = document.createElement('textarea');
      textArea.value = text;
      textArea.style.position = 'fixed';
      textArea.style.left = '-999999px';
      textArea.style.top = '-999999px';
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      
      const result = document.execCommand('copy');
      document.body.removeChild(textArea);
      return result;
    }
  } catch (error) {
    log.error('Failed to copy text to clipboard', error);
    return false;
  }
};

 
export const getElementText = (element: HTMLElement): string => {
  
  if (element.tagName === 'PRE' || element.tagName === 'CODE') {
    return element.textContent || '';
  }
  
  
  return element.innerText || element.textContent || '';
};

 
export const isInFlowChat = (element: HTMLElement): boolean => {
  return element.closest('.flow-chat-container') !== null;
};

 
export const getFlowChatContext = (element: HTMLElement) => {
  const flowChatContainer = element.closest('.flow-chat-container');
  if (!flowChatContainer) {
    return null;
  }

  const dialogTurn = element.closest('.flow-chat-dialog-turn');
  const modelRound = element.closest('.model-round');
  const textBlock = element.closest('.flow-text-block');
  const toolCard = element.closest('.flow-tool-card');
  const userMessage = element.closest('.user-message');

  return {
    container: flowChatContainer as HTMLElement,
    dialogTurn: dialogTurn as HTMLElement | null,
    modelRound: modelRound as HTMLElement | null,
    textBlock: textBlock as HTMLElement | null,
    toolCard: toolCard as HTMLElement | null,
    userMessage: userMessage as HTMLElement | null
  };
};
