/**
 * DshMarketApi — DSH 插件市场（Salvo 服务端 /api/v1/dsh-market/*）。
 *
 * 浏览公开无鉴权（noAuth）；提交/反馈走 member JWT（fetchWithAuth 自动注入，
 * 内部通道头豁免 CSRF Origin 校验）。
 *
 * 安全约定：「一键安装」前必须经 getItem 确认 status=approved 且 npmSpec 取自
 * 服务端版本行 —— 前端不接受用户手输 spec 直接安装。
 */
import { fetchWithAuth } from '../../auth/fetchWithAuth';

/** 市场条目（对齐服务端 DshMarketPlugin，serde camelCase）。 */
export interface DshMarketItem {
  id: string;
  latestVersion: string;
  title: string;
  summary: string;
  descriptionMd: string;
  homepage: string;
  repoUrl: string;
  tags: string[];
  /** 权限声明（notify/wallpaper/todo/xp/tools），UI 显示徽章 */
  permissions: string[];
  status: string;
  installedCount: number;
  failReportCount: number;
  createdAt: number;
  updatedAt: number;
}

/** 版本行（详情接口返回）。 */
export interface DshMarketVersionRow {
  version: string;
  npmSpec: string;
  approvedBy?: string | null;
  reviewNote?: string | null;
}

interface ApiResp<T> {
  code: number;
  message?: string;
  data: T;
}

function unwrap<T>(resp: ApiResp<T>): T {
  if (resp.code !== 0) throw new Error(resp.message || 'dsh-market request failed');
  return resp.data;
}

/** 浏览已上架列表（公开）：GET /api/v1/dsh-market/items */
export async function listMarketItems(opts?: {
  search?: string;
  tag?: string;
  sort?: 'installs' | 'updated';
}): Promise<DshMarketItem[]> {
  const q = new URLSearchParams();
  if (opts?.search) q.set('search', opts.search);
  if (opts?.tag) q.set('tag', opts.tag);
  if (opts?.sort) q.set('sort', opts.sort);
  const qs = q.toString();
  const resp = await fetchWithAuth<ApiResp<{ items: DshMarketItem[] }>>(
    `/api/v1/dsh-market/items${qs ? `?${qs}` : ''}`,
    { noAuth: true },
  );
  return unwrap(resp).items ?? [];
}

/** 详情 + 版本历史（公开）：GET /api/v1/dsh-market/items/{id} */
export async function getMarketItem(
  id: string,
): Promise<{ package: DshMarketItem; versions: DshMarketVersionRow[] }> {
  const resp = await fetchWithAuth<ApiResp<{
    package: DshMarketItem;
    versions: DshMarketVersionRow[];
  }>>(`/api/v1/dsh-market/items/${encodeURIComponent(id)}`, { noAuth: true });
  return unwrap(resp);
}

/** 上架/升版提交（member）：POST /api/v1/dsh-market/submissions */
export async function submitMarketItem(body: {
  npm_spec: string;
  title: string;
  summary?: string;
  description_md?: string;
  homepage?: string;
  repo_url?: string;
  tags?: string[];
  permissions?: string[];
  check_report: Record<string, unknown>;
}): Promise<{ packageId: string; version: string; status: string }> {
  const resp = await fetchWithAuth<ApiResp<{
    packageId: string;
    version: string;
    status: string;
  }>>('/api/v1/dsh-market/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return unwrap(resp);
}

/** 运行时失败反馈（member，7d 同键去重）：POST /api/v1/dsh-market/items/{id}/feedback */
export async function reportMarketFeedback(
  packageId: string,
  version: string,
  errorKind: string,
): Promise<void> {
  await fetchWithAuth<ApiResp<{ counted: boolean }>>(
    `/api/v1/dsh-market/items/${encodeURIComponent(packageId)}/feedback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version, error_kind: errorKind }),
    },
  );
}

/** 本会话已上报过的 (packageId, errorKind)——会话级节流去重（服务端另有 7d 窗口兜底）。 */
const reportedFailures = new Set<string>();

/**
 * 运行时插件失败上报（fire-and-forget）：
 * 版本取服务端 latestVersion（一期不建模历史版本归因）；未上架/未登录等场景静默忽略。
 */
export async function reportRuntimeFailure(packageId: string, errorKind: string): Promise<void> {
  const key = `${packageId}::${errorKind}`;
  if (reportedFailures.has(key)) return;
  reportedFailures.add(key);
  try {
    const detail = await getMarketItem(packageId);
    await reportMarketFeedback(packageId, detail.package.latestVersion, errorKind);
  } catch {
    /* 静默：反馈失败不影响本地功能 */
  }
}
