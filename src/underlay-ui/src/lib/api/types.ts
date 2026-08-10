// ========================================================================
// API 类型定义 — 花园社交系统
// ========================================================================

/** NPC 邻居 */
export interface Neighbor {
    memberId: number;
    username: string;
    country: string;
    gender: string;
    personality: Personality;
    activeWindow: ActiveWindow;
    avatarData: AvatarData;
}

/** 性格 */
export interface Personality {
    activity: number;      // 活跃度 0-1
    sociability: number;   // 社交倾向 0-1
    plantPreference: string; // 偏好植物类型
}

/** 活跃窗口（模拟时区） */
export interface ActiveWindow {
    start: string;   // "09:00"
    end: string;     // "23:00"
    timezone: string; // "Asia/Tokyo"
}

/** 头像数据（复用 avatar-config.ts 的 AvatarSelection 格式） */
export interface AvatarData {
    parts: Record<string, string>;
    colors: Record<string, string>;
}

/** 访客请求结果 */
export interface VisitRequest {
    visitor: Neighbor;
    broughtSeed: string;
}
