// ========================================================================
// 名字标签组件（NameTag）
// ========================================================================
// 主角和访客共用的头顶名字标签。
// - 参数化样式：主角=金黄发光无国旗，访客=白色发光+国旗
// - 统一 Y 偏移：NAME_TAG_Y（相对 spine root），主角访客高度一致
// - 布局：[国旗?] [性别?] [名字] 居中排列，无背景框
// ========================================================================

import * as PIXI from 'pixi.js';

/** 名字标签相对 spine root 的 Y 偏移（统一主角和访客的头顶高度） */
export const NAME_TAG_Y = -170;

/** 国家 → ISO 3166-1 alpha-2 代码（用于 flag-icons SVG 加载） */
const COUNTRY_CODE: Record<string, string> = {
    Japan: 'jp', UK: 'gb', US: 'us', Italy: 'it',
    Korea: 'kr', Australia: 'au', France: 'fr', Brazil: 'br',
    UAE: 'ae', Germany: 'de', Norway: 'no', Canada: 'ca',
    China: 'cn', Spain: 'es', Mexico: 'mx', India: 'in',
    Russia: 'ru', Thailand: 'th', Vietnam: 'vn',
    Netherlands: 'nl', Sweden: 'se', Egypt: 'eg',
};

/** 国旗 emoji（SVG 加载失败时的 fallback） */
const COUNTRY_FLAG_EMOJI: Record<string, string> = {
    Japan: '🇯🇵', UK: '🇬🇧', US: '🇺🇸', Italy: '🇮🇹',
    Korea: '🇰🇷', Australia: '🇦🇺', France: '🇫🇷', Brazil: '🇧🇷',
    UAE: '🇦🇪', Germany: '🇩🇪', Norway: '🇳🇴', Canada: '🇨🇦',
    China: '🇨🇳', Spain: '🇪🇸', Mexico: '🇲🇽', India: '🇮🇳',
    Russia: '🇷🇺', Thailand: '🇹🇭', Vietnam: '🇻🇳',
    Netherlands: '🇳🇱', Sweden: '🇸🇪', Egypt: '🇪🇬',
};

/** 性别 → emoji 标签 */
const GENDER_EMOJI: Record<string, string> = {
    male: '🚹',
    female: '🚺',
};

export interface NameTagOptions {
    /** 显示的名字 */
    text: string;
    /** 名字文字填充色 */
    fillColor: number;
    /** 描边/发光颜色 */
    strokeColor: number;
    /** 字号 */
    fontSize: number;
    /** 是否显示国旗（访客=true，主角=false） */
    showFlag?: boolean;
    /** 国家名（showFlag=true 时用于查国旗代码） */
    country?: string;
    /** 性别（'male' | 'female'，显示 🚹/🚺 标签） */
    gender?: string;
}

export class NameTag {
    private container: PIXI.Container;
    private nameText: PIXI.Text;
    private flagContainer: PIXI.Container | null = null;
    private genderText: PIXI.Text | null = null;
    private isDestroyed = false;

    constructor(options: NameTagOptions) {
        this.container = new PIXI.Container();
        this.container.zIndex = 11;

        // 国旗容器（可选）
        if (options.showFlag) {
            this.flagContainer = new PIXI.Container();
            const flagEmoji = COUNTRY_FLAG_EMOJI[options.country ?? ''] ?? '🌍';
            const flagPlaceholder = new PIXI.Text({
                text: flagEmoji,
                style: {
                    fontFamily: 'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif',
                    fontSize: 16,
                    fill: 0xffffff,
                },
            });
            flagPlaceholder.anchor.set(0.5, 0.5);
            this.flagContainer.addChild(flagPlaceholder);

            // 异步加载 SVG 国旗替换 emoji 占位
            const code = COUNTRY_CODE[options.country ?? ''];
            if (code) {
                void this.loadFlagSvg(code, this.flagContainer, flagPlaceholder);
            }
            this.container.addChild(this.flagContainer);
        }

        // 性别标签（可选，🚹/🚺）
        const genderEmoji = GENDER_EMOJI[options.gender ?? ''];
        if (genderEmoji) {
            this.genderText = new PIXI.Text({
                text: genderEmoji,
                style: {
                    fontFamily: 'Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif',
                    fontSize: 14,
                    fill: 0xffffff,
                },
            });
            this.genderText.anchor.set(0.5, 0.5);
            this.container.addChild(this.genderText);
        }

        // 名字（黑字 + 指定颜色描边发光，适应各种背景色）
        this.nameText = new PIXI.Text({
            text: options.text,
            style: {
                fontFamily: 'sans-serif',
                fontSize: options.fontSize,
                fill: options.fillColor,
                fontWeight: 'bold',
                stroke: { color: options.strokeColor, width: 3, alpha: 0.9 },
                dropShadow: { color: options.strokeColor, alpha: 0.5, blur: 4, distance: 0, angle: 0 },
            },
        });
        this.container.addChild(this.nameText);

        this.relayout();
    }

    get view(): PIXI.Container {
        return this.container;
    }

    /** 设置锚点（相对父 container 的坐标，通常是 spine root 位置 + NAME_TAG_Y） */
    setAnchor(x: number, y: number): void {
        this.container.x = x;
        this.container.y = y;
    }

    /** 更新名字文本 */
    setText(text: string): void {
        this.nameText.text = text;
        this.relayout();
    }

    /** 重新布局：[国旗?] [性别?] [名字] 居中排列 */
    private relayout(): void {
        const gap = 4;
        const flagWidth = this.flagContainer ? 22 : 0;
        const genderWidth = this.genderText ? 16 : 0;
        // 各段之间的间隔数：国旗-性别、性别-名字（仅当对应段存在时计入）
        const segs = [
            this.flagContainer ? flagWidth : 0,
            this.genderText ? genderWidth : 0,
            this.nameText.width,
        ];
        const presentCount = segs.filter(w => w > 0).length;
        const totalGap = presentCount > 1 ? gap * (presentCount - 1) : 0;
        const totalWidth = segs.reduce((s, w) => s + w, 0) + totalGap;

        let cursor = -totalWidth / 2;
        if (this.flagContainer) {
            this.flagContainer.x = cursor + flagWidth / 2;
            this.flagContainer.y = 0;
            cursor += flagWidth + gap;
        }
        if (this.genderText) {
            this.genderText.x = cursor + genderWidth / 2;
            this.genderText.y = 0;
            cursor += genderWidth + gap;
        }
        this.nameText.anchor.set(0, 0.5);
        this.nameText.x = cursor;
        this.nameText.y = 0;
    }

    /** 异步加载 flag-icons 项目的 SVG 国旗，替换 emoji 占位
     *  flag-icons: https://github.com/lipis/flag-icons (MIT)
     *  via jsdelivr CDN: https://cdn.jsdelivr.net/gh/lipis/flag-icons/flags/4x3/{code}.svg
     *  用 Image + canvas 栅格化到 16px 高
     */
    private async loadFlagSvg(code: string, container: PIXI.Container, emojiFallback: PIXI.Text): Promise<void> {
        try {
            const url = `https://cdn.jsdelivr.net/gh/lipis/flag-icons/flags/4x3/${code}.svg`;
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = url;
            await new Promise<void>((resolve, reject) => {
                img.onload = () => resolve();
                img.onerror = () => reject(new Error('svg img load failed'));
            });
            if (this.isDestroyed) return;

            const targetH = 16;
            const targetW = Math.round(targetH * 4 / 3);
            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('canvas 2d context unavailable');
            ctx.drawImage(img, 0, 0, targetW, targetH);

            const texture = PIXI.Texture.from(canvas);
            const sprite = new PIXI.Sprite(texture);
            sprite.anchor.set(0.5, 0.5);
            container.removeChild(emojiFallback);
            emojiFallback.destroy();
            container.addChild(sprite);
            this.relayout();
        } catch (e) {
            console.warn('[NameTag] Failed to load flag SVG for', code, e);
        }
    }

    destroy(): void {
        this.isDestroyed = true;
        this.container.destroy({ children: true });
    }
}
