// ========================================================================
// 花园世界核心类型定义（local-first，本地 IndexedDB 存储）
// ========================================================================
// 设计原则：
// - 所有数据最终归本地 IndexedDB，不与服务器同步
// - 服务器仅提供访客(NPC)信息与"是否派访客"的决策
// - 化身行为以"活动(Activity)"为粒度，状态机驱动
// ========================================================================

// ─── 化身活动（15 种状态） ────────────────────────────────────────────
/**
 * 化身当前活动。
 * - 基础移动 5 种：idle / walking / jumping / rolling / flying
 * - 本地活动 6 种：resting / reading / watering / harvesting / planting / greeting
 * - 社交活动 2 种：playing / chatting
 * - 出门相关 2 种：visiting / returning
 */
export type AvatarActivity =
    | 'idle'        // 待机
    | 'walking'     // 散步
    | 'jumping'     // 跳跃
    | 'rolling'     // 翻滚
    | 'flying'      // 下落/飞行
    | 'resting'     // 休息（用户5分钟无操作触发）
    | 'reading'     // 阅读/学习（坐在草地上看书）
    | 'watering'    // 浇花
    | 'harvesting'  // 收获
    | 'planting'    // 种植
    | 'photographing' // 拍照留念（走到花盆边拍照）
    | 'greeting'    // 迎接访客
    | 'playing'     // 与访客玩耍
    | 'chatting'    // 与访客聊天
    | 'visiting'    // 外出串门中（不显示在桌面）
    | 'returning';  // 回家途中

/** 活动状态对应的情绪（用于气泡显示与未来动画选择） */
export type AvatarMood = 'neutral' | 'happy' | 'curious' | 'sleepy' | 'focused' | 'social';

// ─── 植物 ──────────────────────────────────────────────────────────
/** 植物生长阶段 */
export type PlantStage =
    | 'seed'        // 种子（埋在土里）
    | 'sprout'      // 发芽
    | 'growing'     // 生长
    | 'blooming'    // 开花
    | 'fruiting'    // 结果
    | 'wilting';    // 枯萎（即将消失，掉落种子/物品）

/** 植物种类 ID（MVP 5 种，与 plants.json 对应） */
export type PlantType = 'sunflower' | 'daisy' | 'lavender' | 'mimosa' | 'cactus';

/** 单株植物记录 */
export interface Plant {
    id: string;            // uuid
    type: PlantType;
    stage: PlantStage;
    potId: string;         // 所在花盆 id
    plantedAt: number;     // 种植时间戳（ms）
    /** 进入当前阶段的时间戳（ms），用于推进到下一阶段 */
    stageEnteredAt: number;
    /** 上次浇水时间戳（ms），0 表示未浇过 */
    lastWateredAt: number;
    /** 浇水次数（影响生长速度与品质） */
    waterCount: number;
    /** 是否已被收获 */
    harvested: boolean;
    /** 来源（自己种 / 访客带来 / 出门带回） */
    source: 'self' | 'visitor' | 'outing';
    /** 来源访客用户名（仅 source=visitor 时有值，用于图鉴记录） */
    sourceVisitorName?: string;
}

// ─── 花盆 ──────────────────────────────────────────────────────────
/** 花盆（放在桌面指定坐标，可放一株植物） */
export interface Pot {
    id: string;            // uuid
    /** 桌面坐标 X（屏幕像素） */
    x: number;
    /** 桌面坐标 Y（屏幕像素） */
    y: number;
    /** 花盆样式（MVP 单一样式） */
    style: 'clay' | 'wood' | 'ceramic';
    /** 当前是否种植了植物（plantId 引用） */
    plantId: string | null;
    /** 创建时间戳 */
    createdAt: number;
}

// ─── 收集册 ─────────────────────────────────────────────────────────
/** 收集物品类型 */
export type CollectionItemType =
    | 'seed'         // 种子（可种）
    | 'flower'       // 花朵（已收获，纯展示）
    | 'fruit'        // 果实
    | 'trace'        // 痕迹纪念（访客留下的脚印/贴纸等）
    | 'diary'        // 旅行日记（化身出门带回的）
    | 'gift';        // 访客礼物

/** 收集物品 */
export interface CollectionItem {
    id: string;
    type: CollectionItemType;
    /** 物品子类型（如 seed:sunflower, flower:lavender, gift:stamp_jp） */
    subType: string;
    /** 获得时间戳 */
    obtainedAt: number;
    /** 来源描述 */
    source: 'harvest' | 'visitor' | 'outing' | 'withered';
    /** 来源详情（访客用户名/旅行目的地） */
    sourceDetail?: string;
    /** 数量（仅种子/果实等可堆叠物品） */
    count: number;
    /** 是否收藏（true 不可堆叠/丢弃，仅展示） */
    favorited: boolean;
}

// ─── 痕迹 ──────────────────────────────────────────────────────────
/** 痕迹类型（访客/化身在桌面上留下的短暂痕迹） */
export type TraceType =
    | 'footprint'   // 脚印
    | 'sticker'     // 贴纸
    | 'note'        // 小纸条
    | 'flower_petals' // 花瓣
    | 'sparkle'     // 闪光
    | 'dust';       // 灰尘（化身休息时的痕迹）

/** 痕迹（桌面上的短暂装饰） */
export interface Trace {
    id: string;
    type: TraceType;
    /** 屏幕坐标 X */
    x: number;
    /** 屏幕坐标 Y */
    y: number;
    /** 创建时间戳 */
    createdAt: number;
    /** 过期时间戳（自动消失） */
    expiresAt: number;
    /** 来源（谁留下的） */
    source: 'self' | 'visitor';
    /** 来源详情（访客用户名/国家） */
    sourceDetail?: string;
    /** 痕迹子类型（如 sticker:japan_flag） */
    subType?: string;
}

// ─── 访客 ──────────────────────────────────────────────────────────
/** 访客生命周期阶段（与 activity 正交：phase 管理来/留/走，activity 管理在干什么） */
export type VisitorPhase = 'arriving' | 'visiting' | 'leaving';

/** 当前桌面上的访客（来自服务器的 NPC 信息 + 本地状态） */
export interface ActiveVisitor {
    /** 本地分配的实例 id（区分同一 NPC 多次访问） */
    instanceId: string;
    /** 服务器返回的 NPC member_id */
    memberId: number;
    /** NPC 用户名 */
    username: string;
    /** 国家 */
    country: string;
    /** 性别 */
    gender: string;
    /** 头像数据（复用 AvatarData） */
    avatarData: import('../api/types').AvatarData;
    /** 带来的种子类型 */
    broughtSeed: PlantType;
    /** 到达时间戳 */
    arrivedAt: number;
    /** 预计离开时间戳（3-10 分钟） */
    leaveAt: number;
    /** 访客当前活动（统一用 AvatarActivity，与主角一致） */
    activity: AvatarActivity;
    /** 访客生命周期阶段 */
    phase: VisitorPhase;
    /** 访客当前位置（屏幕坐标） */
    x: number;
    y: number;
}

// ─── 化身持久化状态 ─────────────────────────────────────────────────
/** 化身在 IndexedDB 中持久化的状态（页面刷新后恢复） */
export interface AvatarPersistentState {
    id: 'singleton';       // 单例 key
    /** 当前活动 */
    activity: AvatarActivity;
    /** 当前情绪 */
    mood: AvatarMood;
    /** 屏幕坐标 X（用于恢复位置） */
    x: number;
    /** 屏幕坐标 Y */
    y: number;
    /** 朝向（1=右，-1=左） */
    facing: 1 | -1;
    /** 上次出门时间戳（用于决定下次出门时机） */
    lastOutingAt: number;
    /** 上次更新时间戳 */
    updatedAt: number;
    /** 当前正在进行的访客互动 id（如有） */
    interactingWith?: string;
}

// ─── 出门旅行（旅行青蛙式） ─────────────────────────────────────────
/** 旅行记录 */
export interface OutingRecord {
    id: string;
    /** 出发时间戳 */
    startedAt: number;
    /** 返回时间戳 */
    returnedAt: number | null;
    /** 目的地（随机国家名） */
    destination: string;
    /** 带回的种子/物品（返回时填入） */
    broughtItem?: {
        type: CollectionItemType;
        subType: string;
        count: number;
    };
    /** 旅行日记文本（返回时生成） */
    diaryText?: string;
}

// ─── 全局世界状态快照 ───────────────────────────────────────────────
/** GardenManager 在内存中维护的全局状态快照 */
export interface WorldSnapshot {
    avatar: AvatarPersistentState;
    plants: Plant[];
    pots: Pot[];
    collection: CollectionItem[];
    traces: Trace[];
    activeVisitors: ActiveVisitor[];
    ongoingOutings: OutingRecord[];
}

// ─── 事件类型（GardenManager 对外广播） ──────────────────────────────
export type GardenEvent =
    | { type: 'avatar:activity-changed'; activity: AvatarActivity; mood: AvatarMood }
    | { type: 'plant:planted'; plant: Plant }
    | { type: 'plant:stage-changed'; plantId: string; newStage: PlantStage }
    | { type: 'plant:harvested'; plantId: string }
    | { type: 'plant:withered'; plantId: string }
    | { type: 'visitor:arrived'; visitor: ActiveVisitor }
    | { type: 'visitor:left'; instanceId: string }
    | { type: 'visitor:interacting'; instanceId: string; activity: 'playing' | 'chatting' }
    | { type: 'outing:started'; destination: string }
    | { type: 'outing:returned'; record: OutingRecord }
    | { type: 'collection:added'; item: CollectionItem }
    | { type: 'trace:added'; trace: Trace }
    | { type: 'trace:expired'; traceId: string };

/** 事件监听器 */
export type GardenEventListener = (event: GardenEvent) => void;
