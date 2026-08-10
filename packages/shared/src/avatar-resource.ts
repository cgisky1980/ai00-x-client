/**
 * 头像资源管理器（三包共用，工厂模式）
 *
 * loader-ui / web-ui / underlay-ui 的资源管理逻辑完全一致（拉 manifest、提供资源 URL、
 * 记录版本），仅 baseUrl 获取方式与存储后端不同。抽成工厂函数，由各包传入自己的
 * getAssetsBaseUrl 与 storage adapter 即可。
 *
 * 缓存策略：
 * - 依赖浏览器 HTTP 缓存（服务器设置正确的 Cache-Control + ETag）
 * - manifest.json 用 cache: 'no-cache' 每次验证
 * - 资源文件由浏览器自动缓存
 *
 * 按需下载：
 * - SpineAvatarRenderer 只加载选中物种的 URL
 * - 浏览器只下载该物种的文件，不下载未访问的物种
 *
 * 降级：
 * - 服务器不可达时，用 public/pet/ 硬编码资源
 */

export interface ManifestFileInfo {
  hash: string;
  size: number;
}

export interface Manifest {
  version: string;
  generatedAt: string;
  fileCount: number;
  totalSize: number;
  files: Record<string, ManifestFileInfo>;
}

/** 各包 storage adapter 需满足的最小接口（get/set 字符串） */
export interface StringStorageLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface AvatarResourceManager {
  init(): Promise<void>;
  isAvailable(): boolean;
  getTemplatePath(): string;
  getTexturePath(speciesId: number): string;
  getSkeletonPath(): string;
  getPartsPath(): string;
  resolveResourcePath(resourcePath: string): string;
  getConfigUrl(): string;
  getVersion(): string | null;
  getManifest(): Manifest | null;
  hasFile(relPath: string): boolean;
  reset(): void;
}

export interface CreateResourceManagerOptions {
  /** 返回完整资源根 URL（如 `${baseUrl}/pet`，即 manifest.json 所在目录对应的 URL） */
  getAssetsBaseUrl: () => Promise<string>;
  storage: StringStorageLike;
}

const LOCAL_MANIFEST_KEY = 'avatar-manifest-version';

/**
 * 基于传入的资源根 URL 与存储后端创建头像资源管理器。
 * @param options getAssetsBaseUrl + storage
 */
export function createResourceManager(options: CreateResourceManagerOptions): AvatarResourceManager {
  let remoteManifest: Manifest | null = null;
  let baseUrl = '';
  let initialized = false;
  let initPromise: Promise<void> | null = null;

  async function doInit(): Promise<void> {
    try {
      baseUrl = await options.getAssetsBaseUrl();
      const resp = await fetch(`${baseUrl}/manifest.json`, { cache: 'no-cache' });
      if (resp.ok) {
        remoteManifest = (await resp.json()) as Manifest;
        // 记录版本到存储（用于检测变化）
        const lastVersion = await options.storage.get(LOCAL_MANIFEST_KEY);
        if (lastVersion && lastVersion !== remoteManifest.version) {
          console.info(
            `[ResourceManager] Resource updated: ${lastVersion} → ${remoteManifest.version}`
          );
        }
        await options.storage.set(LOCAL_MANIFEST_KEY, remoteManifest.version);
      } else {
        console.warn(`[ResourceManager] manifest fetch failed: HTTP ${resp.status}`);
      }
    } catch (err) {
      console.warn('[ResourceManager] Server unavailable, fallback to public/', err);
    } finally {
      initialized = true;
    }
  }

  return {
    /** 初始化：拉服务器 manifest；多次调用安全（幂等） */
    async init(): Promise<void> {
      if (initialized) return;
      if (initPromise) return initPromise;
      initPromise = doInit();
      await initPromise;
    },

    /** 服务器是否可用（manifest 拉取成功） */
    isAvailable(): boolean {
      return remoteManifest !== null;
    },

    /** 获取模板路径（共用资源目录），用于 loadSkeletonWithTemplate 的 templatePath */
    getTemplatePath(): string {
      return baseUrl ? baseUrl : 'pet';
    },

    /** 获取物种纹理路径（已废弃，兼容旧接口） */
    getTexturePath(speciesId: number): string {
      return baseUrl ? `${baseUrl}/${speciesId}` : `pet/${speciesId}`;
    },

    /** 获取共享骨骼路径（部位导向架构） */
    getSkeletonPath(): string {
      return baseUrl ? `${baseUrl}/skeleton` : 'pet/skeleton';
    },

    /** 获取部位资源根路径（部位导向架构） */
    getPartsPath(): string {
      return baseUrl ? `${baseUrl}/parts` : 'pet/parts';
    },

    /** 解析 config.json 中 partDef.resourcePath（如 '/pet/heads'）为可访问 URL */
    resolveResourcePath(resourcePath: string): string {
      const relPath = resourcePath.replace(/^\/?pet\//, '');
      return baseUrl ? `${baseUrl}/${relPath}` : `pet/${relPath}`;
    },

    /** 获取 config.json URL（部位配置） */
    getConfigUrl(): string {
      return baseUrl ? `${baseUrl}/config.json` : 'pet/config.json';
    },

    /** 获取资源版本号 */
    getVersion(): string | null {
      return remoteManifest?.version ?? null;
    },

    /** 获取 manifest（用于调试/显示） */
    getManifest(): Manifest | null {
      return remoteManifest;
    },

    /** 检查某文件是否在 manifest 中（服务器有此资源） */
    hasFile(relPath: string): boolean {
      if (!remoteManifest) return true; // 服务器不可用时，假设有
      return relPath in remoteManifest.files;
    },

    /** 重置（用于测试或强制刷新） */
    reset(): void {
      remoteManifest = null;
      initialized = false;
      initPromise = null;
      baseUrl = '';
    },
  };
}