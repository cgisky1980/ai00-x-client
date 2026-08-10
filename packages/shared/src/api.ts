/**
 * 统一 API 响应解包（code/data 包络）
 *
 * 三个前端包（web-ui / loader-ui / underlay-ui）共用的 API 响应结构类型与解包工具。
 * 由 packages/shared 统一导出，禁止各包重复定义。
 */

/** 服务端统一响应包络结构 */
export interface ApiResponse<T = unknown> {
  code: number;
  message: string;
  data: T;
}

/** 业务错误响应 */
export interface ApiError {
  code: number;
  message: string;
}

/** 类型守卫：判断是否为业务错误（code !== 0 且带 message） */
export function isApiError(data: unknown): data is ApiError {
  return (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    "message" in data &&
    typeof (data as ApiError).code === "number" &&
    typeof (data as ApiError).message === "string" &&
    (data as ApiError).code !== 0
  );
}

/** 解包 ApiResponse：code === 0 时返回 data 字段，否则原样返回 */
export function unwrapApiResponse<T>(data: unknown): T {
  if (
    typeof data === "object" &&
    data !== null &&
    "code" in data &&
    "data" in data &&
    (data as { code: number }).code === 0
  ) {
    return (data as { data: T }).data;
  }
  return data as T;
}