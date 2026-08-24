/**
 * 内测申请 API 客户端 —— 对接 sites/default/ai00-s/api/applications/*.ais
 * 约定见 参考/2026-08-04-website-i18n-questionnaire-config.md（两阶段流程）
 */

export interface L10nText {
  zh: string;
  en: string;
}

export interface BasicInfoField {
  key: string;
  type: "text" | "select";
  title: L10nText;
  help?: L10nText;
  placeholder?: L10nText;
  options?: { value: string; label: L10nText }[];
}

export interface QuizQuestion {
  key: string;
  title: L10nText;
  options: { value: string; label: L10nText }[];
}

export interface QuestionsData {
  title: L10nText;
  subtitle: L10nText;
  basicInfo: BasicInfoField[];
  questions: QuizQuestion[];
  hourlyQuota: number;
  currentHourIssued: number;
}

interface ApiResp<T> {
  code: number;
  message: string;
  data?: T;
}

const API_BASE = "/ai00-s/api/applications";

async function post<T>(path: string, body?: unknown): Promise<ApiResp<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

export async function fetchQuestions(): Promise<QuestionsData> {
  const res = await fetch(`${API_BASE}/questions`);
  const json: ApiResp<QuestionsData> = await res.json();
  if (json.code !== 0 || !json.data) throw new Error(json.message || "问卷加载失败");
  return json.data;
}

export interface ClaimResult {
  token: string;
  expires_at: string;
}

export async function claimSlot(): Promise<ClaimResult> {
  const json = await post<ClaimResult>("/claim");
  if (json.code !== 0 || !json.data) {
    const err = new Error(json.message || "名额已被抢完") as Error & { code?: number };
    err.code = json.code;
    throw err;
  }
  return json.data;
}

export interface SubmitResult {
  invite_code: string;
  email?: string;
  email_sent?: boolean;
}

export async function submitApplication(
  token: string,
  email: string,
  answers: Record<string, string>,
): Promise<SubmitResult> {
  const json = await post<SubmitResult>("/submit", { token, email, answers });
  if (json.code !== 0 || !json.data) {
    const err = new Error(json.message || "提交失败") as Error & { code?: number };
    err.code = json.code;
    throw err;
  }
  return json.data;
}

/** 后端错误码 → 用户可读文案（4000-4006 见 submit.ais） */
export function apiErrorMessage(code: number | undefined, fallback: string): string {
  switch (code) {
    case 4000: return "请完整填写所有必填项";
    case 4001: return "邮箱格式不正确";
    case 4002: return "该邮箱已提交过申请，请勿重复提交";
    case 4003: return "该邮箱已注册，无需再申请内测";
    case 4004: return "该邮箱已领取过邀请码，请查收邮件";
    case 4005: return "本小时名额已满，请等下一整点再抢";
    case 4006: return "资格已过期（10 分钟有效），请重新抢名额";
    default: return fallback;
  }
}
