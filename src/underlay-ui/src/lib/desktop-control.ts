import { invoke } from "@tauri-apps/api/core";

/**
 * 设置屏幕工作区边距（保留区域）。
 * 这些区域将不会被最大化的窗口覆盖。
 * 
 * @param left 左侧保留像素
 * @param top 顶部保留像素
 * @param right 右侧保留像素
 * @param bottom 底部保留像素
 */
export async function setScreenMargin(left: number, top: number, right: number, bottom: number) {
    try {
        await invoke('set_screen_margin', { left, top, right, bottom });
        console.log(`Screen margin set to: L:${left} T:${top} R:${right} B:${bottom}`);
    } catch (error) {
        console.error('Failed to set screen margin:', error);
    }
}

/**
 * 重置屏幕工作区（设置为全屏无边距，注意这可能会覆盖任务栏，通常建议设置为 0,0,0,0 但需谨慎）
 * 或者由调用者传入 0 即可。
 */
export async function resetScreenMargin() {
    await setScreenMargin(0, 0, 0, 0);
}
