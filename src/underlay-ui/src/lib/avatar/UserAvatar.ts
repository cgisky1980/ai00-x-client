import * as PIXI from 'pixi.js';
import Matter from 'matter-js';
import { Spine, TextureAtlas, AtlasAttachmentLoader, SkeletonJson, SpineTexture } from '@esotericsoftware/spine-pixi-v8';
import type { AvatarSelection, AvatarConfigFile, PartDef } from './avatar-config';
import type { PhysicsSystem } from '../physics/PhysicsSystem';
import { getApiUrl } from '../config';
import type { GardenManager } from '../world/GardenManager';
import { AvatarBehaviorController } from './AvatarBehaviorController';
import { storage } from '../storage';
import { tokenManager } from '../tokenManager';

/**
 * 加载跨域图片纹理（强制 crossOrigin='anonymous'，绕过 PIXI.Assets.load 缓存）
 *
 * PIXI.Assets.load 在跨域资源加载失败时会缓存空 texture，即使后续请求成功
 * 也返回缓存的空 texture。此函数用独立 Image 对象加载，避免缓存污染，
 * 加载成功后用 Texture.from 创建 PIXI texture。
 *
 * 重要：必须根据 atlas 的 pma 标志设置正确的 alphaMode。
 * 官方 spine-pixi-v8 AtlasLoader 会设置：
 *   alphaMode: page.pma ? 'premultiplied-alpha' : 'premultiply-alpha-on-upload'
 * 如果 pma=true（已预乘 alpha）但用默认的 'premultiply-alpha-on-upload'，
 * GPU 上传时会二次预乘，半透明像素变全透明 → 头像透明。
 *
 * @param url 图片 URL（跨域）
 * @param pma atlas 的 premultiplied alpha 标志（page.pma）
 * @returns PIXI Texture
 */
async function loadCrossOriginTexture(url: string): Promise<PIXI.Texture> {
    // 原版 Image 加载方式：crossOrigin='anonymous' + PIXI.Texture.from(img)
    // PIXI 默认 alphaMode='premultiply-alpha-on-upload'，由 spine-pixi-v8 渲染管线处理。
    // 不要手动设置 alphaMode（之前尝试 'premultiplied-alpha' 和 fetch+ImageBitmap 都导致头像透明）。
    return new Promise<PIXI.Texture>((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            const texture = PIXI.Texture.from(img);
            resolve(texture);
        };
        img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
        img.src = url;
    });
}

/** 角色缩放比例（3/5 = 0.6） */
export const AVATAR_SCALE = 0.6;

/**
 * 共享 Spine 头像加载函数（UserAvatar 和 VisitorAvatar 复用）
 *
 * 步骤：
 * 1. 加载 config.json
 * 2. 加载 base atlas (skeleton/Characters.atlas)
 * 3. 加载 skeleton json (skeleton/Characters.json)
 * 4. 对每个部位加载 variant atlas，合并 regions
 * 5. 清理缺失 attachment
 * 6. 创建 SkeletonData + Spine 实例
 * 7. 应用 slot 颜色
 * 8. 播放默认 idle 动画
 *
 * @param baseUrl avatar 资源根目录（如 `${BASE_URL}avatar`）
 * @param selection 部位和颜色选择，为空时用 config defaults
 * @returns 创建好的 Spine 实例
 */
export async function createSpineAvatar(
    baseUrl: string,
    selection?: AvatarSelection,
): Promise<Spine> {
    // 1. 加载 config.json
    const configResp = await fetch(`${baseUrl}/config.json`);
    const config = await configResp.json() as AvatarConfigFile;

    // 2. 获取选择（不传则用默认值）
    const sel: AvatarSelection = selection && Object.keys(selection.parts ?? {}).length > 0
        ? selection
        : { parts: { ...config.defaults }, colors: { ...config.defaultColors } };

    // 3. 加载共享骨骼 atlas（用 fetch + new TextureAtlas，避免 PIXI.Assets.load 缓存导致多实例共享）
    const baseAtlasUrl = `${baseUrl}/skeleton/Characters.atlas`;
    console.log(`[createSpineAvatar] loading base atlas: ${baseAtlasUrl}`);
    const baseAtlasResp = await fetch(baseAtlasUrl);
    if (!baseAtlasResp.ok) {
        throw new Error(`fetch base atlas HTTP ${baseAtlasResp.status}: ${baseAtlasUrl}`);
    }
    const baseAtlasText = await baseAtlasResp.text();
    const baseAtlas = new TextureAtlas(baseAtlasText);
    console.log(`[createSpineAvatar] base atlas parsed: pages=${baseAtlas.pages.length}, regions=${baseAtlas.regions.length}`);
    for (const page of baseAtlas.pages) {
        // page.name 可能含空格（如 "All Characters.png"），必须 URL-encode，否则 Salvo 静态服务 404
        const textureUrl = `${baseUrl}/skeleton/${encodeURIComponent(page.name)}`;
        console.log(`[createSpineAvatar] loading base page texture: ${textureUrl} (raw name="${page.name}")`);
        const pixiTexture = await loadCrossOriginTexture(textureUrl);
        page.setTexture(SpineTexture.from(pixiTexture.source));
    }
    console.log('[createSpineAvatar] base atlas ready');

    // 4. 加载 skeleton json
    const jsonResp = await fetch(`${baseUrl}/skeleton/Characters.json`);
    const jsonData = await jsonResp.json();

    // 5. 对每个部位加载 variant atlas，合并 regions
    for (const partDef of config.parts) {
        const variantId = sel.parts[partDef.partId];
        if (!variantId || variantId === 'none') {
            if (variantId === 'none') {
                hidePartAttachments(jsonData, partDef.slots);
            }
            continue;
        }
        try {
            await mergeVariantAtlas(baseUrl, baseAtlas, partDef, variantId);
        } catch (e) {
            const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
            console.error(`[createSpineAvatar] ❌ Failed to load variant ${partDef.partId}/${variantId}: ${errMsg}`);
        }
    }

    // 6. 清理 JSON 中引用了不存在 region 的 attachment
    cleanupMissingAttachments(jsonData, baseAtlas);

    // 7. 创建 SkeletonData + Spine 实例
    const attachmentLoader = new AtlasAttachmentLoader(baseAtlas);
    const skeletonJson = new SkeletonJson(attachmentLoader);
    const skeletonData = skeletonJson.readSkeletonData(jsonData);
    const spine = new Spine(skeletonData);

    // 8. 应用颜色（全名 → 短名映射，skeleton slot 名是短名如 "Head"）
    // spine-pixi-v8 4.2.95: 颜色存储在 slot.color（直接属性），渲染时 Spine.js 读 slot.color
    // 注意:4.3.x 才用 slot.pose.color,4.2.x 是 slot.color
    const slotNameMap = buildSlotNameMap(config);
    for (const [slotName, colorHex] of Object.entries(sel.colors)) {
        const resolvedName = slotNameMap.get(slotName) || slotName;
        const slot = spine.skeleton.findSlot(resolvedName);
        if (slot) {
            const slotAny = slot as any;
            // 优先 slot.color(4.2.x),回退 slot.pose.color(4.3.x)
            const colorObj = slotAny.color ?? slotAny.pose?.color;
            if (colorObj) {
                const { r, g, b } = hexToRgb(colorHex);
                colorObj.set(r, g, b, colorObj.a);
            }
        }
    }

    // 9. 播放默认 idle 动画
    const animations = spine.skeleton.data.animations;
    const idleAnim = animations.find(a => a.name.toLowerCase().includes('idle')) || animations[0];
    if (idleAnim) {
        spine.state.setAnimation(0, idleAnim.name, true);
    }

    // 应用缩放
    spine.scale.set(AVATAR_SCALE);
    return spine;
}

/** 合并 variant atlas 的 regions 到 base atlas（手动 fetch + 创建 TextureAtlas，绕过 PIXI.Assets.load） */
async function mergeVariantAtlas(baseUrl: string, baseAtlas: TextureAtlas, partDef: PartDef, variantId: string): Promise<void> {
    let variantAtlasUrl: string;
    if (partDef.resourceType === 'image' && partDef.resourcePath) {
        const dir = partDef.resourcePath.split('/').filter(Boolean).pop() || partDef.partId;
        variantAtlasUrl = `${baseUrl}/${dir}/${variantId}.atlas`;
    } else {
        variantAtlasUrl = `${baseUrl}/parts/${partDef.partId}/${variantId}/Characters.atlas`;
    }

    console.log(`[mergeVariantAtlas] loading: ${partDef.partId}/${variantId} → ${variantAtlasUrl}`);

    // 1. fetch atlas 文本
    const resp = await fetch(variantAtlasUrl);
    if (!resp.ok) {
        throw new Error(`fetch atlas HTTP ${resp.status}: ${variantAtlasUrl}`);
    }
    const atlasText = await resp.text();
    // 检测 HTML 响应（vite SPA fallback 返回 200 + HTML）
    const trimmed = atlasText.trimStart();
    if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<!DOCTYPE')) {
        throw new Error(`atlas URL returned HTML (file not found): ${variantAtlasUrl}`);
    }
    console.log(`[mergeVariantAtlas] atlas text loaded, length=${atlasText.length}`);

    // 2. 创建 TextureAtlas（解析 pages 和 regions）
    const variantAtlas = new TextureAtlas(atlasText);
    console.log(`[mergeVariantAtlas] parsed: pages=${variantAtlas.pages.length}, regions=${variantAtlas.regions.length}`);

    // 3. 加载每个 page 的 texture
    const baseDir = variantAtlasUrl.substring(0, variantAtlasUrl.lastIndexOf('/') + 1);
    for (const page of variantAtlas.pages) {
        const textureUrl = baseDir + encodeURIComponent(page.name);
        console.log(`[mergeVariantAtlas] loading page texture: ${textureUrl}`);
        const pixiTexture = await loadCrossOriginTexture(textureUrl);
        page.setTexture(SpineTexture.from(pixiTexture.source));
    }

    // 4. 用 variant atlas 的 region 替换 base atlas 的同名 region
    let replacedCount = 0;
    let addedCount = 0;
    for (const variantRegion of variantAtlas.regions) {
        if (!variantRegion.name) continue;
        const idx = baseAtlas.regions.findIndex(r => r.name === variantRegion.name);
        if (idx >= 0) {
            baseAtlas.regions[idx] = variantRegion;
            replacedCount++;
        } else {
            baseAtlas.regions.push(variantRegion);
            addedCount++;
        }
    }
    console.log(`[mergeVariantAtlas] done: replaced=${replacedCount}, added=${addedCount}`);
}

/** 从 JSON 中清除指定 slot 的 attachment（隐藏部位）
 * 注意：config.json 的 slots 用全名（如 "Base/Cloth"），但 skeleton JSON 的 slot 名是短名（如 "Cloth"）。
 * 需要同时尝试全名和短名。
 */
function hidePartAttachments(jsonData: any, slots: string[]): void {
    if (!jsonData.skins) return;
    for (const skin of Object.values(jsonData.skins) as any[]) {
        if (!skin.attachments) continue;
        for (const slotName of slots) {
            delete skin.attachments[slotName];
            const shortName = slotName.split('/').pop();
            if (shortName && shortName !== slotName) {
                delete skin.attachments[shortName];
            }
        }
    }
    if (jsonData.animations) {
        for (const anim of Object.values(jsonData.animations) as any[]) {
            if (anim.slots) {
                for (const slotName of slots) {
                    delete anim.slots[slotName];
                    const shortName = slotName.split('/').pop();
                    if (shortName && shortName !== slotName) {
                        delete anim.slots[shortName];
                    }
                }
            }
        }
    }
}

/** 清理 JSON 中引用了不存在 region 的 attachment */
function cleanupMissingAttachments(jsonData: any, atlas: TextureAtlas): void {
    const regionNames = new Set(atlas.regions.map(r => r.name));
    if (!jsonData.skins) return;
    for (const skin of Object.values(jsonData.skins) as any[]) {
        if (!skin.attachments) continue;
        for (const attachments of Object.values(skin.attachments) as any[]) {
            if (!attachments || typeof attachments !== 'object') continue;
            for (const [attName, att] of Object.entries(attachments) as [string, any][]) {
                if (!att) continue;
                const regionName = att.path || attName;
                if (!regionNames.has(regionName)) {
                    delete attachments[attName];
                }
            }
        }
    }
}

/** Hex 颜色转 RGB (0-1) */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    return { r, g, b };
}

/**
 * 构建 slot 名映射表：全名 → 短名。
 *
 * config.json 的 slots 用全名（如 "Base/Head"），但 Spine skeleton 的实际
 * slot 名是短名（如 "Head"）。defaultColors 的 key 也是短名。
 *
 * 映射方向：全名 → 短名。这样：
 * - 短名 key（如 "Head"）→ 直接用 "Head" 查找，成功
 * - 全名 key（如 "Base/Head"）→ 映射到 "Head"，成功
 */
function buildSlotNameMap(config: AvatarConfigFile): Map<string, string> {
    const map = new Map<string, string>();
    for (const partDef of config.parts) {
        if (partDef.isColorable) {
            for (const slotFullName of partDef.slots) {
                const shortName = slotFullName.split('/').pop() || slotFullName;
                map.set(slotFullName, shortName);
            }
        }
    }
    return map;
}

/**
 * 用户化身渲染器
 * 基于 spine-pixi-v8 实现 Spine 头像加载、mix-and-match 换装、颜色应用
 * 接入 PhysicsSystem 实现物理落地
 */
export class UserAvatar {
  private app: PIXI.Application;
  private spine: Spine | null = null;
  private container: PIXI.Container;
  private baseUrl: string;
  private physicsSystem: PhysicsSystem | null;
  private physicsBody: Matter.Body | null = null;
  private behaviorController: AvatarBehaviorController | null = null;
  private config: AvatarConfigFile | null = null;
  private selection: AvatarSelection | null = null;
  private gardenManager: GardenManager | null;

  /** 持久化 slot 颜色（每帧重新应用，防止被动画覆盖） */
  private persistentSlotColors: Map<string, string> = new Map();
  /** colors 短名 → Spine slot 全名 映射（解决 defaultColors "Head" vs slot "Base/Head"） */
  private slotNameMap: Map<string, string> = new Map();
  private _loggedMissingSlots: Set<string> = new Set();
  /** 从服务端 profile 获取的昵称（loadSelectionFromServer 顺带提取，loadNickname 使用） */
  private nickname: string | null = null;

  constructor(app: PIXI.Application, baseUrl: string, physicsSystem?: PhysicsSystem, gardenManager?: GardenManager) {
    this.app = app;
    this.baseUrl = baseUrl;
    this.physicsSystem = physicsSystem || null;
    this.gardenManager = gardenManager ?? null;
    this.container = new PIXI.Container();
    this.container.zIndex = 10;
    this.container.sortableChildren = true;
    this.app.stage.addChild(this.container);
  }

  /**
   * 加载配置 + 创建化身
   * @param selection 用户选择的部位和颜色。如果不传，尝试从 localStorage 读取。
   */
  async load(selection?: AvatarSelection): Promise<void> {
    // 1. 加载 config.json
    const configResp = await fetch(`${this.baseUrl}/config.json`);
    this.config = await configResp.json() as AvatarConfigFile;
    // 构建 colors 短名 → slot 全名 映射（解决 defaultColors "Head" vs slot "Base/Head"）
    this.slotNameMap = buildSlotNameMap(this.config);

    // 2. 获取用户选择（优先级：参数 > 服务端 profile > localStorage > 默认值）
    let selectionSource = 'default';
    if (selection) {
      this.selection = selection;
      selectionSource = 'param';
    } else {
      const serverSel = await this.loadSelectionFromServer();
      if (serverSel) {
        this.selection = serverSel;
        selectionSource = 'server';
      } else {
        const storageSel = await this.loadSelectionFromStorage();
        if (storageSel) {
          this.selection = storageSel;
          selectionSource = 'storage';
        }
      }
    }
    if (!this.selection) {
      // 使用默认值
      this.selection = {
        parts: { ...this.config.defaults },
        colors: { ...this.config.defaultColors },
      };
    }
    console.log(`[UserAvatar] ★ selection source=${selectionSource}, body=${this.selection?.parts?.body ?? '?'}, head=${this.selection?.parts?.head ?? '?'}, parts=${JSON.stringify(this.selection?.parts)}`);

    // 3. 加载共享骨骼 atlas（用 fetch + new TextureAtlas，避免 PIXI.Assets.load 缓存导致与 VisitorAvatar 共享实例）
    const baseAtlasUrl = `${this.baseUrl}/skeleton/Characters.atlas`;
    console.log(`[UserAvatar] loading base atlas: ${baseAtlasUrl}`);
    const baseAtlasResp = await fetch(baseAtlasUrl);
    if (!baseAtlasResp.ok) {
      throw new Error(`fetch base atlas HTTP ${baseAtlasResp.status}: ${baseAtlasUrl}`);
    }
    const baseAtlasText = await baseAtlasResp.text();
    const baseAtlas = new TextureAtlas(baseAtlasText);
    console.log(`[UserAvatar] base atlas parsed: pages=${baseAtlas.pages.length}, regions=${baseAtlas.regions.length}`);
    // 为 baseAtlas 的每个 page 设置 texture（page.setTexture 会遍历 page.regions 设置 region.texture）
    for (const page of baseAtlas.pages) {
      // page.name 可能含空格（如 "All Characters.png"），必须 URL-encode，否则 Salvo 静态服务 404
      const textureUrl = `${this.baseUrl}/skeleton/${encodeURIComponent(page.name)}`;
      console.log(`[UserAvatar] loading base page texture: ${textureUrl} (raw name="${page.name}")`);
      const pixiTexture = await loadCrossOriginTexture(textureUrl);
      page.setTexture(SpineTexture.from(pixiTexture.source));
    }
    console.log('[UserAvatar] base atlas ready');

    // 4. 加载 skeleton json
    const jsonResp = await fetch(`${this.baseUrl}/skeleton/Characters.json`);
    const jsonData = await jsonResp.json();

    // 5. 对每个部位加载 variant atlas，合并 regions
    if (this.config && this.selection) {
      console.log('[UserAvatar] load() step5 selection.parts:', JSON.stringify(this.selection.parts));
      for (const partDef of this.config.parts) {
        const variantId = this.selection.parts[partDef.partId];
        if (!variantId || variantId === 'none') {
          // 隐藏该部位：清除 JSON 中对应 slot 的 attachment
          if (variantId === 'none') {
            this.hidePartAttachments(jsonData, partDef.slots);
          }
          continue;
        }

        try {
          await this.mergeVariantAtlas(baseAtlas, partDef, variantId);
        } catch (e) {
          const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          const errStack = e instanceof Error ? e.stack?.split('\n').slice(0, 5).join('\n') : 'no stack';
          console.error(`[UserAvatar] ❌ Failed to load variant ${partDef.partId}/${variantId}: ${errMsg}`);
          console.error(`[UserAvatar] stack:\n${errStack}`);
        }
      }
      console.log('[UserAvatar] load() step5 done, baseAtlas regions count:', baseAtlas.regions.length);
    }

    // 6. 清理 JSON 中引用了不存在 region 的 attachment
    this.cleanupMissingAttachments(jsonData, baseAtlas);

    // 7. 创建 SkeletonData
    const attachmentLoader = new AtlasAttachmentLoader(baseAtlas);
    const skeletonJson = new SkeletonJson(attachmentLoader);
    const skeletonData = skeletonJson.readSkeletonData(jsonData);

    // 8. 清除旧 Spine
    if (this.spine) {
      this.container.removeChild(this.spine);
      this.spine.destroy();
      this.spine = null;
    }

    // 9. 创建 Spine 实例
    this.spine = new Spine(skeletonData);
    this.spine.scale.set(AVATAR_SCALE);
    this.container.addChild(this.spine);
    console.log('[UserAvatar] Spine created, animations:', this.spine.skeleton.data.animations.map(a => a.name));
    // 检查 Body slot 的 attachment（slot 名是 "Body"，attachment 名是 "Base/Body"）
    const bodySlot = this.spine.skeleton.findSlot('Body');
    console.log('[UserAvatar] Body slot attachment:', (bodySlot as any)?.attachment?.name ?? 'null');
    // 打印前 10 个 slot 的 attachment，确认整体状态
    const slots = this.spine.skeleton.slots;
    const slotInfo = slots.slice(0, 10).map((s: any) => `${s.data.name}=${s.attachment?.name ?? 'null'}`);
    console.log('[UserAvatar] slots (first 10):', slotInfo);

    // 10. 设置 Y 轴向下（屏幕坐标系）
    // spine-pixi-v8 默认 Y 向下

    // 11. 应用颜色
    if (this.selection) {
      for (const [slotName, colorHex] of Object.entries(this.selection.colors)) {
        this.persistentSlotColors.set(slotName, colorHex);
      }
    }

    // 12. 播放默认动画
    const animations = this.spine.skeleton.data.animations;
    const idleAnim = animations.find(a => a.name.toLowerCase().includes('idle')) || animations[0];
    if (idleAnim) {
      this.spine.state.setAnimation(0, idleAnim.name, true);
    }

    // 13. 接入物理系统或定位到屏幕
    if (this.physicsSystem) {
      const startX = window.innerWidth * 0.15;
      const groundY = this.physicsSystem.getGroundTopScreenY();
      this.physicsBody = this.physicsSystem.createPetBody(startX, groundY - 80, 40 * AVATAR_SCALE);
      // 唤醒物理体，防止 enableSleeping 导致刚创建就睡眠
      Matter.Sleeping.set(this.physicsBody, false);
      this.app.ticker.add(this.tickPhysics);

      // 启动行为控制器（自由走动 + 随机动作 + 15 活动状态 + 气泡 + 昵称）
      if (this.spine && this.physicsBody) {
        this.behaviorController = new AvatarBehaviorController(
          this.spine, this.physicsSystem, this.physicsBody,
          this.gardenManager ?? undefined,
          this.container,
        );
        void this.behaviorController.start();
        this.app.ticker.add(this.tickBehavior);
        // 异步获取用户名设置到头顶昵称（金黄发光区别于访客）
        void this.loadNickname();
      }
    } else {
      this.setPosition(window.innerWidth * 0.15, window.innerHeight * 0.75);
    }

    // 14. 每帧应用持久化颜色
    this.app.ticker.add(this.tickColorApply);
  }

  /**
   * 合并 variant atlas 的 regions 到 base atlas（手动 fetch + 创建 TextureAtlas，绕过 PIXI.Assets.load）
   */
  private async mergeVariantAtlas(baseAtlas: TextureAtlas, partDef: PartDef, variantId: string): Promise<void> {
    let variantAtlasUrl: string;

    if (partDef.resourceType === 'image' && partDef.resourcePath) {
      // 单图模式：resourcePath 格式如 "/pet/heads"，取最后一段作为目录名
      const dir = partDef.resourcePath.split('/').filter(Boolean).pop() || partDef.partId;
      variantAtlasUrl = `${this.baseUrl}/${dir}/${variantId}.atlas`;
    } else {
      // 默认 atlas 模式
      variantAtlasUrl = `${this.baseUrl}/parts/${partDef.partId}/${variantId}/Characters.atlas`;
    }

    console.log(`[UserAvatar] mergeVariantAtlas: ${partDef.partId}/${variantId} → ${variantAtlasUrl}`);

    // 1. fetch atlas 文本
    const resp = await fetch(variantAtlasUrl);
    if (!resp.ok) {
      throw new Error(`fetch atlas HTTP ${resp.status}: ${variantAtlasUrl}`);
    }
    const atlasText = await resp.text();
    // 检测 HTML 响应（vite SPA fallback 返回 200 + HTML）
    const trimmed = atlasText.trimStart();
    if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<!DOCTYPE')) {
      throw new Error(`atlas URL returned HTML (file not found): ${variantAtlasUrl}`);
    }
    console.log(`[UserAvatar] atlas text loaded, length=${atlasText.length}`);

    // 2. 创建 TextureAtlas（解析 pages 和 regions）
    const variantAtlas = new TextureAtlas(atlasText);
    console.log(`[UserAvatar] parsed: pages=${variantAtlas.pages.length}, regions=${variantAtlas.regions.length}`);

    // 3. 加载每个 page 的 texture
    const baseDir = variantAtlasUrl.substring(0, variantAtlasUrl.lastIndexOf('/') + 1);
    for (const page of variantAtlas.pages) {
      const textureUrl = baseDir + encodeURIComponent(page.name);
      console.log(`[UserAvatar] loading page texture: ${textureUrl}`);
      const pixiTexture = await loadCrossOriginTexture(textureUrl);
      page.setTexture(SpineTexture.from(pixiTexture.source));
    }

    // 4. 用 variant atlas 的 region 替换 base atlas 的同名 region
    let replacedCount = 0;
    let addedCount = 0;
    for (const variantRegion of variantAtlas.regions) {
      if (!variantRegion.name) continue;
      const idx = baseAtlas.regions.findIndex(r => r.name === variantRegion.name);
      if (idx >= 0) {
        baseAtlas.regions[idx] = variantRegion;
        replacedCount++;
      } else {
        baseAtlas.regions.push(variantRegion);
        addedCount++;
      }
    }
    console.log(`[UserAvatar] merge done: replaced=${replacedCount}, added=${addedCount}`);
  }

  /**
   * 从 JSON 中清除指定 slot 的 attachment（隐藏部位）
   * 注意：config.json 的 slots 用全名（如 "Base/Cloth"），但 skeleton JSON 的 slot 名是短名（如 "Cloth"）。
   * 需要同时尝试全名和短名。
   */
  private hidePartAttachments(jsonData: any, slots: string[]): void {
    if (!jsonData.skins) return;

    for (const skin of Object.values(jsonData.skins) as any[]) {
      if (!skin.attachments) continue;
      for (const slotName of slots) {
        // 同时尝试全名和短名（skeleton JSON 的 slot 名是短名如 "Cloth"，不是 "Base/Cloth"）
        delete skin.attachments[slotName];
        const shortName = slotName.split('/').pop();
        if (shortName && shortName !== slotName) {
          delete skin.attachments[shortName];
        }
      }
    }

    // 清除动画 timeline 中对应 slot 的关键帧
    if (jsonData.animations) {
      for (const anim of Object.values(jsonData.animations) as any[]) {
        if (anim.slots) {
          for (const slotName of slots) {
            delete anim.slots[slotName];
          }
        }
      }
    }
  }

  /**
   * 清理 JSON 中引用了不存在 region 的 attachment
   */
  private cleanupMissingAttachments(jsonData: any, atlas: TextureAtlas): void {
    const regionNames = new Set(atlas.regions.map(r => r.name));

    if (!jsonData.skins) return;

    for (const skin of Object.values(jsonData.skins) as any[]) {
      if (!skin.attachments) continue;
      for (const attachments of Object.values(skin.attachments) as any[]) {
        if (!attachments || typeof attachments !== 'object') continue;
        for (const [attName, att] of Object.entries(attachments) as [string, any][]) {
          if (!att) continue;
          // 检查 region/attachment 名是否存在于 atlas
          const regionName = att.path || attName;
          if (!regionNames.has(regionName)) {
            delete attachments[attName];
          }
        }
      }
    }
  }

  /**
   * 每帧更新行为控制器
   */
  private tickBehavior = (): void => {
    this.behaviorController?.update();
  };

  /**
   * 每帧从物理体同步 Spine 位置
   * 物理体是圆形，position 是圆心。Spine root 不在脚部，
   * 需要 footOffset 校正让脚部对齐物理体圆底。
   * spine.y = 圆心底边 (screenPos.y + radius) + footOffset
   */
  private tickPhysics = (): void => {
    if (!this.spine || !this.physicsBody || !this.physicsSystem) return;
    const screenPos = this.physicsSystem.physicsToScreen(
      this.physicsBody.position.x,
      this.physicsBody.position.y
    );
    this.spine.x = screenPos.x;
    // 物理体圆心 + 半径 = 圆底 = 脚的位置
    const radius = (this.physicsBody as any).circleRadius || 40 * AVATAR_SCALE;
    // Spine root 不在脚部，需要 footOffset 校正（缩放后偏移也按比例缩小）
    const footOffset = 59 * AVATAR_SCALE;
    this.spine.y = screenPos.y + radius + footOffset;
  };

  /**
   * 每帧重新应用持久化 slot 颜色（防止被动画覆盖）
   */
  private tickColorApply = (): void => {
    if (!this.spine) return;
    for (const [slotName, colorHex] of this.persistentSlotColors) {
      // 全名 → 短名映射（skeleton slot 名是短名如 "Head"，不是 "Base/Head"）
      const resolvedName = this.slotNameMap.get(slotName) || slotName;
      const slot = this.spine.skeleton.findSlot(resolvedName);
      if (!slot) {
        // 只在第一次找不到时打印，避免每帧刷屏
        if (!this._loggedMissingSlots?.has(slotName)) {
          this._loggedMissingSlots = this._loggedMissingSlots || new Set();
          this._loggedMissingSlots.add(slotName);
          console.warn(`[UserAvatar] Slot "${slotName}" (resolved: "${resolvedName}") not found in skeleton. Available slots:`,
            this.spine.skeleton.slots.map((s: any) => s.data.name).slice(0, 20));
        }
        continue;
      }
      if (slot) {
        // spine-pixi-v8 4.2.95: 颜色存储在 slot.color（直接属性），渲染时 Spine.js 读 slot.color
        // 优先 slot.color(4.2.x),回退 slot.pose.color(4.3.x)
        const slotAny = slot as any;
        const colorObj = slotAny.color ?? slotAny.pose?.color;
        if (colorObj) {
          const { r, g, b } = this.hexToRgb(colorHex);
          colorObj.set(r, g, b, colorObj.a);
        }
      }
    }
  };

  /**
   * Hex 颜色转 RGB (0-1)
   */
  private hexToRgb(hex: string): { r: number; g: number; b: number } {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    return { r, g, b };
  }

  /**
   * 设置行为控制器头顶昵称
   * 使用 loadSelectionFromServer 顺带提取的 nickname（profile_update.ais 维护的字段）；
   * 未获取到时保持默认"我"。不再使用 username（账号登录名）。
   */
  private async loadNickname(): Promise<void> {
    if (this.nickname) {
      this.behaviorController?.setNickname(this.nickname);
    }
  }

  /**
   * 从服务端获取用户 avatar 配置
   *
   * 流程:
   * 1. 通过 tokenManager.getValidAccessToken() 获取有效 token
   *    - tokenManager 会自动检查 access token 是否过期
   *    - 过期则用 refresh token 调 /api/v1/auth/member/refresh 获取新 token
   *    - 解决"首次进入正常,刷新后 avatar_data 为 null"的问题
   *      (access token 15 分钟过期,underlay-ui 之前无 refresh 机制)
   * 2. 用有效 token 调 GET /ai00-s/api/ai/me 获取 profile
   *
   * @returns AvatarSelection 或 null（非 Tauri 环境 / token 缺失 / API 失败）
   */
  private async loadSelectionFromServer(): Promise<AvatarSelection | null> {
    try {
      // 1. 获取有效 token
      //   - Tauri 环境:先 restore_auth_from_vault 确保 vault token 在内存,
      //     再由 tokenManager 检查过期并自动 refresh
      //   - 非 Tauri 环境:降级到 storage
      let token: string | null = null;
      let tokenSource = 'none';
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // 先从 vault 恢复最新 token（loader-ui 登录后 token 存到 vault，desktop 需主动恢复）
        try {
          await invoke<boolean>('restore_auth_from_vault');
        } catch (e) {
          console.warn('[UserAvatar] restore_auth_from_vault failed:', e);
        }
        // tokenManager 会检查 access token 是否过期,过期则自动 refresh
        token = await tokenManager.getValidAccessToken();
        tokenSource = token ? 'tokenManager(valid)' : 'tokenManager(null)';
        console.log(`[UserAvatar] tokenManager.getValidAccessToken() → ${token ? `token=${token.substring(0, 16)}...` : 'null'}`);
      } catch (e) {
        tokenSource = `tokenManager-failed:${String(e).substring(0, 80)}`;
        console.warn('[UserAvatar] tokenManager failed, fallback to storage:', e);
        token = await storage.get('ai00_dev_token');
      }
      if (!token) {
        console.warn(`[UserAvatar] No token (source=${tokenSource}), cannot load from server`);
        return null;
      }

      // 2. 调用 /ai00-s/api/ai/me 获取 profile
      const meUrl = await getApiUrl('/ai00-s/api/ai/me');
      const resp = await fetch(meUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
      });
      console.log(`[UserAvatar] GET ${meUrl} → ${resp.status} ${resp.statusText} (token=${token.substring(0, 16)}...)`);
      if (!resp.ok) return null;
      const json = await resp.json();
      // 诊断:打印完整响应结构（code/message/data 是否存在）
      // me.ais 在 token 无效时返回 HTTP 200 + {code: 4002, message: "invalid token", data: null}
      console.log(`[UserAvatar] me response: code=${json?.code}, message=${json?.message}, dataIsNull=${json?.data === null}, dataType=${typeof json?.data}`);
      if (json?.code !== 0) {
        console.warn(`[UserAvatar] me API returned non-zero code: ${json?.code} (${json?.message}). Token may be invalid/expired.`);
        return null;
      }
      // me.ais 返回 { code:0, data: result }，result 是 ai.me 的返回值 { code:200, data:{ member:{ avatar_data, nickname } } }
      // 所以完整路径是 json.data.data.member.xxx
      const member = json?.data?.data?.member ?? json?.data?.member;
      const avatarDataStr = member?.avatar_data;
      // 顺带提取 nickname（profile_update.ais 维护的字段），供 loadNickname 使用
      if (member?.nickname && typeof member.nickname === 'string') {
        this.nickname = member.nickname;
        console.log('[UserAvatar] nickname from server:', this.nickname);
      }
      console.log('[UserAvatar] avatar_data:', avatarDataStr ? `${avatarDataStr.substring(0, 80)}...` : 'null');
      if (!avatarDataStr || typeof avatarDataStr !== 'string') return null;

      // 3. 解析 avatar_data JSON 字符串
      const parsed = JSON.parse(avatarDataStr) as AvatarSelection;
      if (!parsed || !parsed.parts || !parsed.colors) return null;
      console.log('[UserAvatar] Loaded selection from server profile ✓', parsed);
      console.log('[UserAvatar] colors detail:', JSON.stringify(parsed.colors));
      return parsed;
    } catch (e) {
      console.warn('[UserAvatar] loadSelectionFromServer failed:', e);
      return null;
    }
  }

  private async loadSelectionFromStorage(): Promise<AvatarSelection | null> {
    try {
      return await storage.getJson<AvatarSelection>('ai00-x-avatar');
    } catch { }
    return null;
  }

  /**
   * 设置化身位置（屏幕坐标）
   */
  setPosition(x: number, y: number): void {
    if (this.spine) {
      this.spine.x = x;
      this.spine.y = y;
    }
  }

  /**
   * 设置缩放
   */
  setScale(scale: number): void {
    if (this.spine) {
      this.spine.scale.set(scale);
    }
  }

  /** 行为控制器（供外部调用 walkToTarget / setActivity 等） */
  get behavior(): AvatarBehaviorController | null {
    return this.behaviorController;
  }

  /**
   * 播放动画
   */
  playAnimation(name: string, loop: boolean = true): void {
    if (this.spine) {
      this.spine.state.setAnimation(0, name, loop);
    }
  }

  /**
   * 获取可用动画列表
   */
  getAnimations(): string[] {
    if (!this.spine) return [];
    return this.spine.skeleton.data.animations.map(a => a.name);
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.app.ticker.remove(this.tickColorApply);
    this.app.ticker.remove(this.tickPhysics);
    this.app.ticker.remove(this.tickBehavior);
    if (this.behaviorController) {
      this.behaviorController.destroy();
      this.behaviorController = null;
    }
    if (this.physicsBody && this.physicsSystem) {
      this.physicsSystem.removeBody(this.physicsBody);
      this.physicsBody = null;
    }
    if (this.spine) {
      this.container.removeChild(this.spine);
      this.spine.destroy();
      this.spine = null;
    }
    this.app.stage.removeChild(this.container);
  }

  get spineObj(): Spine | null {
    return this.spine;
  }

  get containerObj(): PIXI.Container {
    return this.container;
  }
}
