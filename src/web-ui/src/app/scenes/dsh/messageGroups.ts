import type { DshMessage, DshMessageSegment, DshMessageUsage } from '@/infrastructure/api/service-api/DshAPI';

/**
 * 把落盘消息按「回合」合并后再交给 UI。
 *
 * 引擎每完成一次模型响应就落一条 assistant/message（中间还可能夹着工具调用的
 * 消息），逐条渲染会变成「一条工具卡一个气泡、正文又一个气泡」的碎片。
 * 对话区按 Trae 的形态呈现：**一次用户输入 → 一个助手气泡**，里面依次是
 * 推理、工具动作、正文，底部是复制与用量。
 *
 * 合并规则：
 * - 连续 assistant 消息并成一个；遇到 user 消息即换组
 * - 正文/推理用空行连接，工具调用按原顺序拼接
 * - `streaming` 取或、`toolCallUnparsed` 取或、`error` 取最后一条非空
 * - `usage` 累加（引擎按请求上报，一个回合可能多次请求）
 */

const joinBlocks = (parts: string[]): string =>
  parts.filter(part => part.trim().length > 0).join('\n\n');

function mergeUsage(
  left: DshMessageUsage | undefined,
  right: DshMessageUsage | undefined,
): DshMessageUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const merged: DshMessageUsage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
  if (left.cacheReadTokens !== undefined || right.cacheReadTokens !== undefined) {
    merged.cacheReadTokens = (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0);
  }
  return merged;
}

/** 单条落盘消息 → 一个片段（空片段返回 null，避免气泡里出现空段）。 */
function toSegment(message: DshMessage): DshMessageSegment | null {
  const hasText = message.text.trim().length > 0;
  if (!hasText && message.toolCalls.length === 0) return null;
  return { text: message.text, toolCalls: message.toolCalls };
}

export function groupMessagesForDisplay(messages: DshMessage[]): DshMessage[] {
  const grouped: DshMessage[] = [];
  /** 当前正在累积的助手组（位于 grouped 末尾）。 */
  let current: DshMessage | null = null;

  for (const message of messages) {
    if (message.role === 'user') {
      current = null;
      grouped.push(message);
      continue;
    }
    const segment = toSegment(message);
    if (!current) {
      current = {
        ...message,
        toolCalls: [...message.toolCalls],
        segments: segment ? [segment] : [],
      };
      grouped.push(current);
      continue;
    }
    current = {
      ...current,
      text: joinBlocks([current.text, message.text]),
      reasoning: joinBlocks([current.reasoning ?? '', message.reasoning ?? '']) || undefined,
      toolCalls: [...current.toolCalls, ...message.toolCalls],
      segments: segment ? [...(current.segments ?? []), segment] : current.segments,
      streaming: current.streaming || message.streaming,
      error: message.error ?? current.error,
      toolCallUnparsed: current.toolCallUnparsed || message.toolCallUnparsed,
      usage: mergeUsage(current.usage, message.usage),
    };
    // 上面是新建对象，需要把它写回数组（React 的 key 仍是组首条的 id）
    grouped[grouped.length - 1] = current;
  }

  return grouped;
}

export default groupMessagesForDisplay;
