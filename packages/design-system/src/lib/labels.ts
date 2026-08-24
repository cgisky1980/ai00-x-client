/**
 * 组件文案注入机制 —— 解耦包对消费方 i18n 的依赖
 *
 * 包内组件统一用 label(key, fallback) 取文案：默认返回 fallback（中文），
 * 消费方启动时调用 setComponentLabels 注册覆盖。值支持：
 *   - string：静态覆盖
 *   - () => string：动态 getter（如包装 i18n 的 t()，语言切换后组件重渲染取新值）
 */
export type LabelValue = string | (() => string);
export type ComponentLabels = Record<string, LabelValue>;

let overrides: ComponentLabels = {};

export function setComponentLabels(map: ComponentLabels): void {
  overrides = map;
}

export function label(key: string, fallback: string): string {
  const v = overrides[key];
  if (typeof v === 'function') return v();
  if (typeof v === 'string') return v;
  return fallback;
}
