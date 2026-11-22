/**
 * failureHint —「这一轮为什么失败、该怎么办」的分类（通知/卡片共用的单一来源）。
 *
 * 有些失败重试一百次也是同样结果（额度不足、凭据失效、模型不存在）。这类失败
 * 不该在第一次就摆「继续执行」按钮劝人撞墙，也不该等到连续三次才收敛——按错误
 * 原文直接判「需要先修环境」，并把要修什么写进通知。
 */

export interface FailureLike {
  code?: string;
  message?: string;
}

/** 可本地化的失败类别（卡片按 i18n 渲染；通知仍是中文文案，直接用 hint）。 */
export type FailureKind = 'credits' | 'auth' | 'model' | 'rateLimit';

export interface FailureGuidance {
  /** true = 重试没有意义，先修环境（额度 / 凭据 / 模型）。 */
  blocking: boolean;
  /** 类别；非 blocking 时为 null。 */
  kind: FailureKind | null;
  /** 给人看的一句话处理建议（中文，通知用）；非 blocking 时为空串。 */
  hint: string;
}

const CREDITS = /积分余额不足|余额不足|充值|insufficient|quota exceeded|billing/i;
const AUTH = /unauthorized|forbidden|invalid api key|invalid_api_key|authentication|凭据|密钥无效/i;
const MODEL = /model.*not (found|exist)|invalid model|upstream returned 404|model_not_found/i;
/**
 * 限流：**不属于 blocking**——等待几十秒后重试确实会成功，环境不需要人改；
 * 但也不该劝人立刻重试（马上点只会再撞一次 429）。卡片/通知给「稍等再试」。
 */
const RATE_LIMIT = /rate limit|too many requests|429|限流|请求过于频繁/i;

export function failureGuidance(err?: FailureLike): FailureGuidance {
  if (!err) return { blocking: false, kind: null, hint: '' };
  const text = `${err.code ?? ''} ${err.message ?? ''}`;
  if (CREDITS.test(text)) {
    return { blocking: true, kind: 'credits', hint: '额度不足：充值后再继续，重试不会改变结果' };
  }
  if (AUTH.test(text)) {
    return { blocking: true, kind: 'auth', hint: '凭据/权限问题：先处理账号或密钥' };
  }
  if (MODEL.test(text)) {
    return { blocking: true, kind: 'model', hint: '模型不可用：到设置里换一个可用模型' };
  }
  if (RATE_LIMIT.test(text)) {
    return { blocking: false, kind: 'rateLimit', hint: '请求被限流：等几十秒再点「继续执行」' };
  }
  return { blocking: false, kind: null, hint: '' };
}

/**
 * 从网关包装的错误文案里挖出最内层可读 message。
 *
 * 网关（以及早期会话记录）会把上游错误原样序列化进 message：
 * `Ai00-X gateway HTTP 502: {"error":{"message":"{\"code\":402,...}"}}`。
 * 直接摘要只会露出一串转义 JSON，人要自己从里面找「积分余额不足」。这里逐层解包，
 * 取最内层的 message 字符串（保留 `HTTP 502` 这类定位前缀）。解析不了就原样返回。
 */
export function unwrapFailureMessage(text: string): string {
  const start = text.indexOf('{');
  if (start < 0) return text;
  const prefix = text.slice(0, start).replace(/[\s:：]+$/, '');
  let node: unknown;
  try {
    node = JSON.parse(text.slice(start));
  } catch {
    return text;
  }
  let message = '';
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof node === 'string') {
      const raw = node.trim();
      try {
        node = JSON.parse(raw);
        continue;
      } catch {
        message = raw;
        break;
      }
    }
    if (!node || typeof node !== 'object') break;
    const record = node as { message?: unknown; error?: unknown };
    if (typeof record.message === 'string' && record.message.trim()) {
      const inner = record.message.trim();
      // message 本身可能又是一段 JSON（实测两层嵌套）。
      if (inner.startsWith('{') || inner.startsWith('"')) {
        node = inner;
        continue;
      }
      message = inner;
      break;
    }
    if (record.error !== undefined) {
      node = record.error;
      continue;
    }
    break;
  }
  const merged = [prefix, message].filter(Boolean).join(': ');
  return merged || text;
}

/**
 * 失败原因的一句话摘要（通知 / 计划卡 / 列表与看板悬停共用）：`code · 首个分句`，超长截断。
 *
 * 只写「以错误收尾」等于让人再去翻对话；摘要给到「哪一类错、报在哪」就够判断了。
 * 网关包装过的 JSON 先解包（`unwrapFailureMessage`），否则摘要里只有转义字符。
 */
export function summarizeFailure(err?: FailureLike): string {
  if (!err) return '';
  const clause = unwrapFailureMessage(err.message ?? '').split(/[;；]/)[0].trim();
  const short = clause.length > 80 ? `${clause.slice(0, 80)}…` : clause;
  return [err.code, short].filter(Boolean).join(' · ');
}
