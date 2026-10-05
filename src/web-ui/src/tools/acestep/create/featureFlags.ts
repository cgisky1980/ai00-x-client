/**
 * 创作分区功能开关（localStorage 可覆盖，默认关）。
 *
 * - ai00-x-create:remixEnabled = '1'：显示「改歌 / 局部重绘」入口（新建菜单、
 *   送去改歌/重绘按钮）。开关只藏入口，已存在的 remix 创作仍可打开编辑。
 * 置 '1' 即可重新打开，无需改代码重编。
 */

export function isRemixUiEnabled(): boolean {
  try {
    return localStorage.getItem('ai00-x-create:remixEnabled') === '1';
  } catch {
    return false;
  }
}
