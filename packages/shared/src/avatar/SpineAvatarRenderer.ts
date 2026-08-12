import * as spine from '@esotericsoftware/spine-core';
import { AssetManager, SkeletonRenderer } from '@esotericsoftware/spine-canvas';
import type { AvatarSelection, PartDef } from '../avatar-config';

// Spine Y-axis default is up, Canvas Y-axis is down
spine.Skeleton.yDown = true;

/**
 * 精简版 SpineManager（从 pet-custom-system/src/modules/SpineManager.ts 提取）
 * 只保留头像预览所需功能：加载骨骼、整体/部件换装、上色、动画播放
 * 去掉编辑器相关 API（addSlot/removeSlot/previewAnimation/cloneAnimation/boneGizmo/timeline 等）
 *
 * 兼容 pet-custom-system 资源格式：
 * - loadSkeleton：基础加载（pet/{speciesId}/Characters.json + .atlas）
 * - loadSkeletonWithTemplate：with-head 模板继承加载（pet/with-head 模板 + {speciesId}/atlas）
 *
 * 唯一实现点：packages/shared/src/avatar/SpineAvatarRenderer.ts
 * loader-ui / web-ui 均从此处重导出，统一包含自适应缩放与核心部件 tint 逻辑。
 */
export class SpineAvatarRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private skeleton: spine.Skeleton | null = null;
  private animationState: spine.AnimationState | null = null;
  private currentSkin: string | null = null;
  private currentAnimName = '';
  private lastTime = 0;
  private animFrameId = 0;
  private generation = 0;
  private zoom = 1.0;
  // 持久化 tint color
  private persistentSlotColors: Map<string, string> = new Map();
  private originalImages: Map<string, HTMLImageElement | HTMLCanvasElement> = new Map();
  private tintedTextureCache: Map<string, Map<string, HTMLCanvasElement>> = new Map();
  // 保留本种族 atlas 引用（避免被回收，持有但不读取）
  private _speciesAtlasRef: unknown = null;
  // 保留 variant atlas 引用（避免被回收）
  private _variantAtlasRefs: unknown[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 canvas 上下文');
    this.ctx = ctx;
  }

  /**
   * 基础加载：skeletonPath 指向包含 Characters.json + Characters.atlas 的目录
   */
  async loadSkeleton(skeletonPath: string, defaultSkin?: string): Promise<void> {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    this.clearCanvas('加载中...');
    this.persistentSlotColors.clear();
    this.originalImages.clear();
    this.tintedTextureCache.clear();

    try {
      const assetManager = new AssetManager(skeletonPath + '/');
      assetManager.loadTextureAtlas('Characters.atlas');
      await assetManager.loadAll();
      const atlas = assetManager.get('Characters.atlas') as spine.TextureAtlas;

      const jsonResponse = await fetch(`${skeletonPath}/Characters.json`);
      const jsonData = await jsonResponse.json();

      this.initWithData(jsonData, atlas, defaultSkin);
    } catch (error) {
      console.error('Failed to load Spine animation:', error);
      this.clearCanvas(`加载失败: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * with-head 模板继承加载
   * templatePath 指向模板目录（含 Characters.json + Characters.atlas）
   * texturePath 指向本种族目录（含 Characters.atlas + base/*.png）
   */
  async loadSkeletonWithTemplate(
    templatePath: string,
    texturePath: string,
    defaultSkin?: string,
  ): Promise<void> {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    this.clearCanvas('加载中...');
    this.persistentSlotColors.clear();
    this.originalImages.clear();
    this.tintedTextureCache.clear();

    try {
      // 1. 从 texturePath 加载本种族的 atlas
      const assetManager = new AssetManager(texturePath + '/');
      assetManager.loadTextureAtlas('Characters.atlas');
      await assetManager.loadAll();
      const speciesAtlas = assetManager.get('Characters.atlas') as spine.TextureAtlas;

      // 2. 从 templatePath 加载骨骼+动作模板 JSON
      const jsonResp = await fetch(`${templatePath}/Characters.json`);
      const templateJson = await jsonResp.json();
      const jsonData = JSON.parse(JSON.stringify(templateJson));

      // 3. 有头模式：用本种族 atlas 中的 region 替换模板 atlas 中的同名 region
      const templateAssetManager = new AssetManager(templatePath + '/');
      templateAssetManager.loadTextureAtlas('Characters.atlas');
      await templateAssetManager.loadAll();
      const templateAtlas = templateAssetManager.get('Characters.atlas') as spine.TextureAtlas;

      let replacedCount = 0;
      for (const speciesRegion of speciesAtlas.regions) {
        if (!speciesRegion.name) continue;
        const idx = templateAtlas.regions.findIndex(r => r.name === speciesRegion.name);
        if (idx >= 0) {
          templateAtlas.regions[idx] = speciesRegion;
        } else {
          templateAtlas.regions.push(speciesRegion);
        }
        replacedCount++;
      }
      if (replacedCount > 0) {
        this._speciesAtlasRef = speciesAtlas;
      }

      // 4. 清理模板 JSON 中引用了合并后 atlas 不存在 region 的 attachment
      this.cleanupMissingAttachments(jsonData, templateAtlas);

      this.initWithData(jsonData, templateAtlas, defaultSkin);
    } catch (error) {
      console.error('Failed to load skeleton with template:', error);
      this.clearCanvas(`加载失败: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 部位导向加载（新架构）
   * skeletonPath 指向共享骨骼目录（含 Characters.json + Characters.atlas）
   * partsPath 指向部位资源根目录（{partsPath}/{partId}/{variantId}/Characters.atlas + 纹理）
   *
   * 支持两种资源模式：
   * - 默认 atlas 模式：从 {partsPath}/{partId}/{variantId}/Characters.atlas 加载
   * - 单图模式（partDef.resourceType === 'image'）：从 resolveResourcePath(partDef.resourcePath)/{variantId}.atlas 加载
   *
   * 支持隐藏部位（partDef.allowNone && variantId === 'none'）：从 JSON 清除对应 attachment
   *
   * @param resolveResourcePath 用于把 config 中的 resourcePath（如 '/pet/heads'）解析为可访问 URL
   */
  async loadSkeletonWithParts(
    selection: AvatarSelection,
    partDefs: PartDef[],
    skeletonPath: string,
    partsPath: string,
    defaultSkin?: string,
    resolveResourcePath?: (resourcePath: string) => string,
  ): Promise<void> {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    this.clearCanvas('加载中...');
    this.persistentSlotColors.clear();
    this.originalImages.clear();
    this.tintedTextureCache.clear();
    this._variantAtlasRefs = [];

    try {
      // 0. 容错归一化：持久化数据（avatar_data）中的旧 variantId 可能已不在 config 中，
      //    对无效值回退到该部位的有效变体（优先 'default'，否则第一个），避免 404。
      const safeParts: Record<string, string> = {};
      for (const partDef of partDefs) {
        const requested = selection.parts[partDef.partId];
        if (requested === undefined) continue;
        if (requested === 'none') {
          safeParts[partDef.partId] = 'none';
          continue;
        }
        if (partDef.variants.some(v => v.variantId === requested)) {
          safeParts[partDef.partId] = requested;
        } else {
          const fallback =
            partDef.variants.find(v => v.variantId === 'default') || partDef.variants[0];
          if (fallback) safeParts[partDef.partId] = fallback.variantId;
        }
      }

      // 1. 加载共享 atlas + json
      const baseAssetManager = new AssetManager(skeletonPath + '/');
      baseAssetManager.loadTextureAtlas('Characters.atlas');
      await baseAssetManager.loadAll();
      const baseAtlas = baseAssetManager.get('Characters.atlas') as spine.TextureAtlas;

      const jsonResp = await fetch(`${skeletonPath}/Characters.json`);
      const jsonData = await jsonResp.json();

      // 2. 对每个部位：加载 variant atlas，替换基础 atlas 的同名 region
      const variantAtlasRefs: spine.TextureAtlas[] = [];
      for (const partDef of partDefs) {
        const variantId = safeParts[partDef.partId];
        if (!variantId) continue;

        // "无"：隐藏该部位（清除 slot/skin/动画中对应的 attachment）
        if (variantId === 'none') {
          this.hidePartAttachments(jsonData, partDef.slots);
          continue;
        }

        try {
          let variantAtlas: spine.TextureAtlas;
          let variantPath: string;

          if (partDef.resourceType === 'image' && partDef.resourcePath) {
            // 单图模式：从 {resolvedResourcePath}/{variantId}.atlas 加载（atlas 引用同名 PNG）
            const basePath = resolveResourcePath
              ? resolveResourcePath(partDef.resourcePath)
              : partDef.resourcePath;
            variantPath = basePath;
            const atlasFileName = `${variantId}.atlas`;
            const variantAssetManager = new AssetManager(variantPath + '/');
            variantAssetManager.loadTextureAtlas(atlasFileName);
            await variantAssetManager.loadAll();
            variantAtlas = variantAssetManager.get(atlasFileName) as spine.TextureAtlas;
          } else {
            // 默认 atlas 模式：从 {partsPath}/{partId}/{variantId}/Characters.atlas 加载
            variantPath = `${partsPath}/${partDef.partId}/${variantId}`;
            const variantAssetManager = new AssetManager(variantPath + '/');
            variantAssetManager.loadTextureAtlas('Characters.atlas');
            await variantAssetManager.loadAll();
            variantAtlas = variantAssetManager.get('Characters.atlas') as spine.TextureAtlas;
          }
          variantAtlasRefs.push(variantAtlas);

          // 用 variant atlas 的 region 替换基础 atlas 的同名 region
          let replacedCount = 0;
          for (const variantRegion of variantAtlas.regions) {
            if (!variantRegion.name) continue;
            const idx = baseAtlas.regions.findIndex(r => r.name === variantRegion.name);
            if (idx >= 0) {
              baseAtlas.regions[idx] = variantRegion;
            } else {
              baseAtlas.regions.push(variantRegion);
            }
            replacedCount++;
          }
          if (replacedCount === 0) {
            console.warn(`[loadSkeletonWithParts] ${partDef.partId}/${variantId}: 未替换任何 region`);
          }
        } catch (e) {
          console.warn(`[loadSkeletonWithParts] 加载 ${partDef.partId}/${variantId} 失败:`, e);
        }
      }
      this._variantAtlasRefs = variantAtlasRefs;

      // 3. 清理 JSON 中引用了合并后 atlas 不存在 region 的 attachment
      this.cleanupMissingAttachments(jsonData, baseAtlas);

      // 4. 用合并后的 atlas + json 初始化
      this.initWithData(jsonData, baseAtlas, defaultSkin);

      // 5. 应用 colors（灰度部件 tint）
      for (const [slotName, colorHex] of Object.entries(selection.colors)) {
        this.persistentSlotColors.set(slotName, colorHex);
        this.setSlotColor(slotName, colorHex);
      }
    } catch (error) {
      console.error('Failed to load skeleton with parts:', error);
      this.clearCanvas(`加载失败: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 更新颜色（不重新加载 skeleton）
   */
  updateColors(colors: Record<string, string>): void {
    this.persistentSlotColors.clear();
    for (const [slotName, colorHex] of Object.entries(colors)) {
      this.persistentSlotColors.set(slotName, colorHex);
      this.setSlotColor(slotName, colorHex);
    }
  }

  private initWithData(jsonData: any, atlas: spine.TextureAtlas, defaultSkin?: string): void {
    this.generation++;
    const atlasLoader = new spine.AtlasAttachmentLoader(atlas);
    const skeletonJson = new spine.SkeletonJson(atlasLoader);
    const skeletonData = skeletonJson.readSkeletonData(jsonData);

    this.skeleton = new spine.Skeleton(skeletonData);
    const skinName = defaultSkin || 'default';
    this.skeleton.setSkin(skinName);
    this.currentSkin = skinName;
    this.skeleton.setupPose();
    this.storeOriginalImages();

    const animationStateData = new spine.AnimationStateData(skeletonData);
    animationStateData.defaultMix = 0.2;
    this.animationState = new spine.AnimationState(animationStateData);

    const animations = this.skeleton.data.animations.map((a: any) => a.name);
    const defaultAnim = animations.includes('Idle') ? 'Idle' : (animations[0] || 'idle');
    this.animationState.setAnimation(0, defaultAnim, true);
    this.currentAnimName = defaultAnim;

    this.skeleton.scaleX = this.skeleton.scaleY = this.zoom;
    this.centerSkeleton();

    this.lastTime = performance.now();
    this.animate();
  }

  /** 用 skeleton bounds 计算居中位置 + 自适应缩放，让角色视觉中心对齐 canvas 中心。
   *  getBounds 返回世界坐标（含 skeleton.x/y 和 scale 的影响），
   *  所以先归零 + updateWorldTransform，再取 bounds，最后反推偏移。
   *
   *  自适应缩放：根据 skeleton bounds 和 canvas 尺寸计算 fit zoom，
   *  让角色完整显示在 canvas 内（留 10% 边距），不放大只缩小。 */
  private centerSkeleton(): void {
    if (!this.skeleton) return;
    this.skeleton.x = 0;
    this.skeleton.y = 0;
    this.skeleton.scaleX = 1;
    this.skeleton.scaleY = 1;
    this.skeleton.updateWorldTransform(0);

    const offset = new spine.Vector2();
    const size = new spine.Vector2();
    this.skeleton.getBounds(offset, size);

    // 自适应缩放：让 skeleton 适配 canvas（留 10% 边距，不放大只缩小）
    const margin = 0.1;
    const sx = size.x > 0 ? this.canvas.width / (size.x * (1 + margin)) : 1;
    const sy = size.y > 0 ? this.canvas.height / (size.y * (1 + margin)) : 1;
    this.zoom = Math.min(sx, sy, 1.0);
    this.skeleton.scaleX = this.skeleton.scaleY = this.zoom;
    this.skeleton.updateWorldTransform(0);

    // 缩放后重新计算 bounds 并居中
    this.skeleton.getBounds(offset, size);
    const centerX = offset.x + size.x / 2;
    const centerY = offset.y + size.y / 2;
    this.skeleton.x = this.canvas.width / 2 - centerX;
    this.skeleton.y = this.canvas.height / 2 - centerY;
  }

  private animate = (): void => {
    if (!this.skeleton || !this.animationState) return;
    const myGeneration = this.generation;
    const now = performance.now();
    const delta = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (myGeneration !== this.generation) return;

    try {
      this.animationState.update(delta);
      this.animationState.apply(this.skeleton);
      this.applyPersistentColors();
    } catch (err) {
      console.error('Animation apply error:', err);
      this.animFrameId = requestAnimationFrame(this.animate);
      return;
    }

    this.skeleton.updateWorldTransform(0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const renderer = new SkeletonRenderer(this.ctx);
    renderer.draw(this.skeleton);

    this.animFrameId = requestAnimationFrame(this.animate);
  };

  /**
   * 调整 canvas 尺寸（响应式）：重新设置 canvas.width/height 并重新摆放 skeleton
   * zoom 保持固定值（与 initWithData 一致），避免 resize 时 skeleton 被放大
   */
  resize(width: number, height: number): void {
    if (width <= 0 || height <= 0) return;
    this.canvas.width = width;
    this.canvas.height = height;
    if (this.skeleton) {
      this.skeleton.scaleX = this.skeleton.scaleY = this.zoom;
      this.centerSkeleton();
    }
  }

  private clearCanvas(text: string): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (text) {
      this.ctx.fillStyle = text.startsWith('加载失败') ? '#ff6b6b' : 'var(--text-50, #888)';
      this.ctx.font = '14px Arial';
      this.ctx.textAlign = 'center';
      this.ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2);
    }
  }

  setSkin(skinName: string): void {
    if (!this.skeleton) return;
    this.skeleton.setSkin(skinName);
    this.skeleton.setupPoseSlots();
    this.currentSkin = skinName;
  }

  /**
   * 部件级换装：基础皮肤 + slot 覆盖（从其他皮肤提取 slot attachment）
   */
  setCompositeSkin(baseSkin: string, slotOverrides: Record<string, string>): void {
    if (!this.skeleton) return;
    const skeletonData = this.skeleton.data;
    const baseSkinData = skeletonData.findSkin(baseSkin);
    if (!baseSkinData) {
      console.error(`Base skin "${baseSkin}" not found`);
      return;
    }

    const compositeSkin = new spine.Skin(`composite_${baseSkin}`);
    compositeSkin.addSkin(baseSkinData);

    for (const [slotName, sourceSkinName] of Object.entries(slotOverrides)) {
      const slotIndex = this.skeleton!.data.slots.findIndex((s: any) => s.name === slotName);
      if (slotIndex === -1) continue;

      if (sourceSkinName === '__none__') {
        const baseEntries: spine.SkinEntry[] = [];
        baseSkinData.getAttachmentsForSlot(slotIndex, baseEntries);
        for (const entry of baseEntries) {
          compositeSkin.removeAttachment(slotIndex, entry.placeholder);
        }
        continue;
      }

      const sourceSkinData = skeletonData.findSkin(sourceSkinName);
      if (!sourceSkinData) continue;

      const sourceEntries: spine.SkinEntry[] = [];
      sourceSkinData.getAttachmentsForSlot(slotIndex, sourceEntries);
      const baseEntries: spine.SkinEntry[] = [];
      baseSkinData.getAttachmentsForSlot(slotIndex, baseEntries);
      for (const entry of baseEntries) {
        compositeSkin.removeAttachment(slotIndex, entry.placeholder);
      }
      for (const entry of sourceEntries) {
        compositeSkin.setAttachment(slotIndex, entry.placeholder, entry.attachment);
      }
    }

    compositeSkin.bones = baseSkinData.bones;
    compositeSkin.constraints = baseSkinData.constraints;

    const oldSkin = this.skeleton.skin;
    this.skeleton.setSkin(compositeSkin);
    if (oldSkin) compositeSkin.attachAll(this.skeleton, oldSkin);
    this.skeleton.setupPoseSlots();
    this.currentSkin = baseSkin;
  }

  setAnimation(name: string): void {
    if (!this.animationState) return;
    this.animationState.setAnimation(0, name, true);
    this.currentAnimName = name;
  }

  getAnimations(): string[] {
    if (!this.skeleton?.data) return [];
    return this.skeleton.data.animations.map((a: any) => a.name);
  }

  getSkins(): string[] {
    if (!this.skeleton?.data) return [];
    return this.skeleton.data.skins.map((s: any) => s.name);
  }

  getCurrentSkin(): string | null {
    return this.currentSkin;
  }

  getCurrentAnimation(): string {
    return this.currentAnimName;
  }

  getSlotNames(): string[] {
    if (!this.skeleton?.data) return [];
    return this.skeleton.data.slots.map((s: any) => s.name);
  }

  /**
   * 设置 slot 的 tint color（灰度模板上色）
   * 持久化：每帧动画 apply 后重新应用，避免被动画覆盖
   */
  setSlotColor(slotName: string, colorHex: string): void {
    if (!this.skeleton) return;
    this.persistentSlotColors.set(slotName, colorHex);
    this.applySlotColor(slotName, colorHex);
  }

  clearSlotColor(slotName: string): void {
    this.persistentSlotColors.delete(slotName);
  }

  private applySlotColor(slotName: string, colorHex: string): void {
    if (!this.skeleton) return;
    const slot = this.skeleton.findSlot(slotName) as any;
    if (!slot) return;
    const hex = colorHex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const pose = slot.appliedPose || slot.pose;
    if (pose && pose.color) {
      pose.color.set(r, g, b, 1);
    }
    this.applyTintToTexture(slotName, colorHex);
  }

  private applyPersistentColors(): void {
    if (!this.skeleton || this.persistentSlotColors.size === 0) return;
    for (const [slotName, colorHex] of this.persistentSlotColors) {
      this.applySlotColor(slotName, colorHex);
    }
  }

  // 核心部件后缀（只对这些部件应用 tint，非核心保持原色）
  private static readonly CORE_PART_SUFFIXES = new Set([
    'Body', 'Head', 'Tails',
    'Hand_F', 'Hand_B', 'Hand_B2',
    'Leg_F', 'Leg_B', 'Leg_F2',
    'Eye1', 'Eye2',
    'Ear_F', 'Ear_B',
  ]);

  private storeOriginalImages(): void {
    this.tintedTextureCache.clear();
    if (!this.skeleton) return;
    const slotNames = this.skeleton.data.slots.map((s: any) => s.name);
    for (const slotName of slotNames) {
      if (this.originalImages.has(slotName)) continue;
      const slot = this.skeleton.findSlot(slotName) as any;
      if (!slot) continue;
      const attachment = slot.appliedPose?.attachment;
      if (!attachment) continue;
      const sequence = attachment.sequence;
      if (!sequence || !sequence.regions || sequence.regions.length === 0) continue;
      const region = sequence.regions[0];
      const image = region.texture?.getImage?.();
      if (image) {
        this.originalImages.set(slotName, image);
      }
    }
  }

  private applyTintToTexture(slotName: string, colorHex: string): void {
    if (!this.skeleton) return;
    const slot = this.skeleton.findSlot(slotName) as any;
    if (!slot) return;
    const attachment = slot.appliedPose?.attachment;
    if (!attachment) return;

    // 非核心部件跳过 tint
    const attachmentPath = attachment.path || attachment.name;
    if (attachmentPath) {
      const suffix = attachmentPath.split('/').pop() || '';
      if (!SpineAvatarRenderer.CORE_PART_SUFFIXES.has(suffix)) {
        return;
      }
    }

    const sequence = attachment.sequence;
    if (!sequence || !sequence.regions || sequence.regions.length === 0) return;
    const region = sequence.regions[0];
    if (!region.texture) return;

    const originalImage = this.originalImages.get(slotName);
    if (!originalImage) return;

    let slotCache = this.tintedTextureCache.get(slotName);
    if (!slotCache) {
      slotCache = new Map();
      this.tintedTextureCache.set(slotName, slotCache);
    }
    let tintedCanvas = slotCache.get(colorHex);
    if (!tintedCanvas) {
      tintedCanvas = document.createElement('canvas');
      tintedCanvas.width = originalImage.width;
      tintedCanvas.height = originalImage.height;
      const ctx = tintedCanvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(originalImage, 0, 0);

      const hex = colorHex.replace('#', '');
      const cr = parseInt(hex.substring(0, 2), 16);
      const cg = parseInt(hex.substring(2, 4), 16);
      const cb = parseInt(hex.substring(4, 6), 16);

      const TINT_THRESHOLD = 128;
      const imageData = ctx.getImageData(0, 0, tintedCanvas.width, tintedCanvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a === 0) continue;
        const rOrig = a > 0 ? data[i] / (a / 255) : data[i];
        const gOrig = a > 0 ? data[i + 1] / (a / 255) : data[i + 1];
        const bOrig = a > 0 ? data[i + 2] / (a / 255) : data[i + 2];
        const brightness = (rOrig + gOrig + bOrig) / 3;
        if (brightness >= TINT_THRESHOLD) {
          data[i] = (data[i] * cr) / 255;
          data[i + 1] = (data[i + 1] * cg) / 255;
          data[i + 2] = (data[i + 2] * cb) / 255;
        }
      }
      ctx.putImageData(imageData, 0, 0);
      slotCache.set(colorHex, tintedCanvas);
    }

    (region.texture as any)._image = tintedCanvas;
  }

  /**
   * 隐藏指定部位：从 JSON 中清除对应的 slot attachment、skin attachment 和动画 timeline。
   * attachmentNames 为 part.slots（如 ['Base/Glasses']、['Base/Cloth']）。
   * 从 pet-custom-system SpineManager 移植。
   */
  private hidePartAttachments(jsonData: any, attachmentNames: string[]): void {
    const hideSet = new Set(attachmentNames);

    // 1. 清除 slots 的 attachment（setup pose 默认 attachment）
    if (jsonData.slots) {
      for (const slot of jsonData.slots) {
        if (slot.attachment && hideSet.has(slot.attachment)) {
          delete slot.attachment;
        }
      }
    }

    // 2. 清除 skins 的 attachment 定义
    if (jsonData.skins) {
      for (const skin of jsonData.skins) {
        if (!skin.attachments) continue;
        for (const slotName of Object.keys(skin.attachments)) {
          const slotAttachments = skin.attachments[slotName];
          for (const attName of Object.keys(slotAttachments)) {
            if (hideSet.has(attName)) {
              delete slotAttachments[attName];
            }
          }
        }
      }
    }

    // 3. 清除动画中的 attachment timeline 引用
    if (jsonData.animations) {
      for (const animName of Object.keys(jsonData.animations)) {
        const anim = jsonData.animations[animName];
        if (!anim.slots) continue;
        for (const slotName of Object.keys(anim.slots)) {
          const slotTimeline = anim.slots[slotName];
          if (!slotTimeline.attachment || !Array.isArray(slotTimeline.attachment)) continue;
          const filtered = slotTimeline.attachment.filter((item: any) => {
            if (item === null) return true; // null = 隐藏，保留
            if (typeof item === 'string') return !hideSet.has(item);
            if (item && typeof item === 'object') {
              if (item.name === null || item.name === undefined) return true;
              return !hideSet.has(item.name);
            }
            return true;
          });
          if (filtered.length === 0) {
            delete slotTimeline.attachment;
          } else {
            slotTimeline.attachment = filtered;
          }
        }
      }
    }
  }

  /**
   * 清理 JSON 中引用了 atlas 不存在 region 的 attachment（with-head 模式必需）
   */
  private cleanupMissingAttachments(jsonData: any, atlas: spine.TextureAtlas): void {
    const atlasRegionNames = new Set<string>();
    for (const region of atlas.regions) {
      if (region.name) atlasRegionNames.add(region.name);
    }

    if (jsonData.skins) {
      for (const skin of jsonData.skins) {
        if (!skin.attachments) continue;
        for (const slotName of Object.keys(skin.attachments)) {
          const slotAttachments = skin.attachments[slotName];
          const newSlotAttachments: Record<string, any> = {};
          for (const attName of Object.keys(slotAttachments)) {
            const att = slotAttachments[attName];
            const regionName = (att && att.path) ? att.path : attName;
            if (atlasRegionNames.has(regionName)) {
              newSlotAttachments[attName] = att;
            }
          }
          skin.attachments[slotName] = newSlotAttachments;
        }
      }
    }

    if (jsonData.slots) {
      for (const slot of jsonData.slots) {
        if (slot.attachment && !atlasRegionNames.has(slot.attachment)) {
          delete slot.attachment;
        }
      }
    }

    if (jsonData.animations) {
      for (const animName of Object.keys(jsonData.animations)) {
        const anim = jsonData.animations[animName];
        if (!anim.slots) continue;
        for (const slotName of Object.keys(anim.slots)) {
          const slotTimeline = anim.slots[slotName];
          if (!slotTimeline.attachment) continue;
          if (Array.isArray(slotTimeline.attachment)) {
            const filtered = slotTimeline.attachment.filter((item: any) => {
              if (item === null) return true;
              if (typeof item === 'string') return atlasRegionNames.has(item);
              if (item && typeof item === 'object') {
                if (item.name === null || item.name === undefined) return true;
                return atlasRegionNames.has(item.name);
              }
              return true;
            });
            if (filtered.length === 0) {
              delete slotTimeline.attachment;
            } else {
              slotTimeline.attachment = filtered;
            }
          }
        }
      }
    }
  }

  destroy(): void {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = 0;
    }
    this.skeleton = null;
    this.animationState = null;
    this.persistentSlotColors.clear();
    this.originalImages.clear();
    this.tintedTextureCache.clear();
    void this._speciesAtlasRef;
    this._speciesAtlasRef = null;
    void this._variantAtlasRefs;
    this._variantAtlasRefs = [];
  }
}