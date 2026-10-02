/**
 * playShare — 遥控常驻 overlay 播放社区歌曲（迁移 030）
 *
 * emit `acestep://player-command` {action:'playShare'}，与乐窗/灵动岛同链路；
 * 返回是否可达（事件失败 = 播放引擎未挂），供 UI 提示。
 */
import { emit } from '@tauri-apps/api/event';

export async function playShare(shareId: string): Promise<'ok' | 'unavailable'> {
  try {
    await emit('acestep://player-command', {
      action: 'playShare',
      payload: { shareId },
    });
    return 'ok';
  } catch {
    return 'unavailable';
  }
}
