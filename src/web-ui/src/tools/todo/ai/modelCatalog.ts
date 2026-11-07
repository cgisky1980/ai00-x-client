/**
 * modelCatalog — 策·讨论的模型选择持久化。
 *
 * 控件已与 task 窗口统一（ModelSelector 受控模式）：
 * 列表固定三概念——本地模型（RWKV 3B/7B/13B + Qwen3.8 27B 槽位）/
 * Ai00-API（服务器下发列表 + 积分倍率）/ 自定义模型API；
 * 不再扫描本地模型目录（list_rwkv_models / list_gguf_models 已废弃）。
 *
 * 通道：plugin_ai_complete 的 model 引用（缺省 'ai00-api' AI00-API 主模型；
 * 'auto' 不传 = 本地 RWKV 优先 + primary 回退；'rwkv-local' /
 * 'ai00s:<子模型>' / 'gguf-local:<路径>' / 自定义 id 均由 client_factory
 * resolve 解析）。
 * 选择持久化：localStorage（纯 UI 偏好）。
 */

const STORAGE_KEY = 'ai00x.todo.discussModel';

/** 「自动」引用 id（不传 model——本地 RWKV 优先 + primary 自动回退）。 */
export const MODEL_AUTO = 'auto';

/** 默认讨论/规划模型：AI00-API 主模型槽（本地 RWKV 可在 ModelSelector 手切）。 */
export const MODEL_REMOTE = 'ai00-api';

/** 读取持久化的选择；缺省 AI00-API 主模型（已存值的用户尊重其选择）。 */
export function getDiscussModel(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return MODEL_REMOTE;
    // 旧入口 id → 新入口（网关仍接受旧 id，这里只是让显示不再出现旧名字）
    return stored === 'ai00-salvo' ? MODEL_REMOTE : stored;
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
