/**
 * 独立版 i18n shim —— layouts 迁移自 web-ui（用 useI18n），演示站无 i18n 基建，
 * 以固定中文键值代偿，保持 layouts 源码零改动。
 */
const ZH: Record<string, string> = {
  // common
  collapse: '收起',
  expand: '展开',
  // components.componentLibrary.layouts.*
  'componentLibrary.layouts.previewLabel': '预览',
  'componentLibrary.layouts.idLabel': '标识',
  'componentLibrary.layouts.quickJump': '快速跳转',
};

export function useI18n(_ns?: string) {
  return { t: (key: string) => ZH[key] ?? key };
}
