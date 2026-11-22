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

export interface FailureGuidance {
  /** true = 重试没有意义，先修环境（额度 / 凭据 / 模型）。 */
  blocking: boolean;
  /** 给人看的一句话处理建议；非 blocking 时为空串。 */
  hint: string;
}

const CREDITS = /积分余额不足|余额不足|充值|insufficient|quota exceeded|billing/i;
const AUTH = /unauthorized|forbidden|invalid api key|invalid_api_key|authentication|凭据|密钥无效/i;
const MODEL = /model.*not (found|exist)|invalid model|upstream returned 404|model_not_found/i;

export function failureGuidance(err?: FailureLike): FailureGuidance {
  if (!err) return { blocking: false, hint: '' };
  const text = `${err.code ?? ''} ${err.message ?? ''}`;
  if (CREDITS.test(text)) {
    return { blocking: true, hint: '额度不足：充值后再继续，重试不会改变结果' };
  }
  if (AUTH.test(text)) {
    return { blocking: true, hint: '凭据/权限问题：先处理账号或密钥' };
  }
  if (MODEL.test(text)) {
    return { blocking: true, hint: '模型不可用：到设置里换一个可用模型' };
  }
  return { blocking: false, hint: '' };
}

/**
 * 失败原因的一句话摘要（通知 / 计划卡共用）：`code · 首个分句`，超长截断。
 *
 * 只写「以错误收尾」等于让人再去翻对话；摘要给到「哪一类错、报在哪」就够判断了。
 */
export function summarizeFailure(err?: FailureLike): string {
  if (!err) return '';
  const clause = (err.message ?? '').split(/[;；]/)[0].trim();
  const short = clause.length > 80 ? `${clause.slice(0, 80)}…` : clause;
  return [err.code, short].filter(Boolean).join(' · ');
}
