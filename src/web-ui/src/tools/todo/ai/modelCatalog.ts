/**
 * modelCatalog — 策·讨论的模型选择持久化。
 *
 * 控件已与 task 窗口统一（ModelSelector 受控模式）：
 * 列表固定三概念——本地模型（RWKV 3B/7B/13B + Qwen3.8 27B 槽位）/
 * Ai00-API（服务器下发列表 + 积分倍率）/ 自定义模型API；
 * 不再扫描本地模型目录（list_rwkv_models / list_gguf_models 已废弃）。
 *
 * 通道：plugin_ai_complete 的 model 引用（缺省 'ai00-salvo' 远程主模型；
 * 'auto' 不传 = 本地 RWKV 优先 + primary 回退；'rwkv-local' /
 * 'ai00s:<子模型>' / 'gguf-local:<路径>' / 自定义 id 均由 client_factory
 * resolve 解析）。
 * 选择持久化：localStorage（纯 UI 偏好）。
 */

const STORAGE_KEY = 'ai00x.todo.discussModel';

/** 「自动」引用 id（不传 model——本地 RWKV 优先 + primary 自动回退）。 */
export const MODEL_AUTO = 'auto';

/** 默认讨论/规划模型：远程 ai00-salvo（主模型槽；本地 RWKV 可在 ModelSelector 手切）。 */
export const MODEL_REMOTE = 'ai00-salvo';

/** 读取持久化的选择；缺省远程 ai00-salvo（已存值的用户尊重其选择）。 */
export function getDiscussModel(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || MODEL_REMOTE;
  } catch {
    return MODEL_REMOTE;
  }
}

/** 持久化选择。 */
export function setDiscussModel(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // localStorage 不可用（隐私模式等）——仅会话内生效
  }
}
