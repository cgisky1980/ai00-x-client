export type RichTextExternalSyncAction = 'noop' | 'clear' | 'replace';

export function getRichTextExternalSyncAction(
  value: string,
  currentContent: string
): RichTextExternalSyncAction {
  if (value === currentContent) {
    return 'noop';
  }

  if (!value) {
    return currentContent ? 'clear' : 'noop';
  }

  return 'replace';
}
