import * as PIXI from 'pixi.js';
import { Platform } from '../../lib/physics/PhysicsSystem';
import { generateGrassSvg } from './GrassSystem';
import { generateFlowerSvg } from './FlowerSystem';

// Simple seeded random number generator
function sfc32(a: number, b: number, c: number, d: number) {
    return function() {
        a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0; 
        let t = (a + b) | 0;
        a = b ^ b >>> 9;
        b = c + (c << 3) | 0;
        c = (c << 21 | c >>> 11);
        d = d + 1 | 0;
        t = (t + d) | 0;
        c = (c + t) | 0;
        return (t >>> 0) / 4294967296;
    }
}

// Create a seeded RNG from a string ID
function createRng(str: string) {
    let h = 1779033703 ^ str.length;
    for(let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = h << 13 | h >>> 19;
    }
    const seed = function() {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        return (h ^= h >>> 16) >>> 0;
    }
    return sfc32(seed(), seed(), seed(), seed());
}

interface FlowerInstance {
    sprite: PIXI.Sprite;
    swaySpeed: number;
    swayOffset: number;
}

export class VineSystem {
    private container: PIXI.Container;
    private platformGraphics: Map<string, PIXI.Container> = new Map();
    private grassTexture: PIXI.Texture | null = null;
    private flowerTextures: PIXI.Texture[] = [];
    private currentSeason: 'spring' | 'summer' | 'autumn' | 'winter' = 'summer';
    private lastPlatforms: Platform[] = [];

    constructor() {
        this.container = new PIXI.Container();
        this.container.label = 'platform-grass';
        this.container.zIndex = 5; 
    }

    private getSeasonColors() {
        const seasonConfig = {
            spring: {
                grassColors: ['#a5d6a7', '#81c784', '#c8e6c9'],
                soilColor: 0x7cb342,
                flowerColors: ['#ffc0cb', '#ffb6c1', '#fff0f5', '#ffe4e1', '#ff69b4', '#ffffff', '#ffccd5'],
                hasGrass: true,
                hasFlowers: true
            },
            summer: {
                grassColors: ['#4ade80', '#22c55e', '#86efac'],
                soilColor: 0x5d7c3d,
                flowerColors: ['#fca5a5', '#fde047', '#e9d5ff', '#ffffff', '#93c5fd', '#ff6b6b', '#4ecdc4'],
                hasGrass: true,
                hasFlowers: true
            },
            autumn: {
                grassColors: ['#d4a574', '#c9956c', '#b8860b'],
                soilColor: 0x8b6914,
                flowerColors: ['#d2691e', '#cd853f', '#b8860b', '#daa520', '#8b4513', '#a0522d', '#d4a574'],
                hasGrass: true,
                hasFlowers: true
            },
            winter: {
                grassColors: [],
                soilColor: 0xffffff,
                flowerColors: [],
                hasGrass: false,
                hasFlowers: false
            }
        };
        return seasonConfig[this.currentSeason];
    }

    public async setup(app: PIXI.Application) {
        app.stage.addChild(this.container);
        await this.rebuildTextures();
    }

    private async rebuildTextures() {
        const config = this.getSeasonColors();
        
        if (config.hasGrass && config.grassColors.length > 0) {
            const svg = generateGrassSvg(512, 20, config.grassColors, 1.2);
            this.grassTexture = await PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${svg}`);
            if (this.grassTexture) {
                this.grassTexture.source.style.addressModeU = 'repeat';
                this.grassTexture.source.style.addressModeV = 'clamp-to-edge';
            }
        } else {
            this.grassTexture = null;
        }

        if (config.hasFlowers && config.flowerColors.length > 0) {
            const flowerGen = generateFlowerSvg();
            const promises: Promise<PIXI.Texture>[] = [];
            
            for (let i = 0; i < 16; i++) {
                const type = i % 8;
                const color = config.flowerColors[i % config.flowerColors.length];
                const flowerSvg = flowerGen(color, type);
                promises.push(PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${flowerSvg}`));
            }
            
            this.flowerTextures = await Promise.all(promises);
        } else {
            this.flowerTextures = [];
        }
    }

    public update(time: number) {
        // Wind animation
        const wind = Math.sin(time * 2) * 0.1; // Gentle sway
        for (const container of this.platformGraphics.values()) {
            const grass = container.getChildByLabel('grass') as PIXI.TilingSprite;
            if (grass) {
                grass.skew.x = wind;
            }

            // Animate flowers
            const flowers = (container as any).userData?.flowers as FlowerInstance[];
            if (flowers) {
                for (const flower of flowers) {
                    const flowerWind = Math.sin(time * flower.swaySpeed + flower.swayOffset);
                    flower.sprite.rotation = flowerWind * 0.1;
                }
            }
        }
    }

    public async setSeason(season: 'spring' | 'summer' | 'autumn' | 'winter') {
        if (this.currentSeason === season) return;
        this.currentSeason = season;
        await this.rebuildTextures();
    }
    
    public updatePlatforms(platforms: Platform[]) {
        this.lastPlatforms = platforms;
        const currentIds = new Set<string>();

        platforms.forEach(platform => {
            // Filter out icons (shortcuts) per user request
            if (platform.type === 'shortcut') return;

            currentIds.add(platform.id);
            
            if (!this.platformGraphics.has(platform.id)) {
                const graphic = this.createGrassForPlatform(platform);
                if (graphic) {
                    this.platformGraphics.set(platform.id, graphic);
                    this.container.addChild(graphic);
                }
            } else {
                const existing = this.platformGraphics.get(platform.id)!;
                // Redraw if dimensions changed OR if we forced a clear (though if we forced clear, it wouldn't be in the map)
                // We also need to check if the season changed, but setSeason handles that by clearing.
                const userData = (existing as any).userData;
                if (userData?.width !== platform.width || userData?.season !== this.currentSeason) {
                    this.container.removeChild(existing);
                    existing.destroy();
                    const graphic = this.createGrassForPlatform(platform);
                    if (graphic) {
                        this.platformGraphics.set(platform.id, graphic);
                        this.container.addChild(graphic);
                    }
                } else {
                    existing.position.set(platform.x, platform.y);
                }
            }
        });

        // Cleanup removed platforms
        for (const [id, graphic] of this.platformGraphics.entries()) {
            if (!currentIds.has(id)) {
                this.container.removeChild(graphic);
                graphic.destroy();
                this.platformGraphics.delete(id);
            }
        }
    }
    
    public refresh() {
        // Force re-update with last data
        if (this.lastPlatforms.length > 0) {
            // Mark all existing as needing update (e.g. by clearing map? or just let the check handle it)
            // The check `existing.userData?.season !== this.currentSeason` should handle it.
            this.updatePlatforms(this.lastPlatforms);
        }
    }

    private createGrassForPlatform(platform: Platform): PIXI.Container | null {
        const config = this.getSeasonColors();
        
        const container = new PIXI.Container();
        const flowers: FlowerInstance[] = [];
        (container as any).userData = { 
            width: platform.width, 
            height: platform.height,
            season: this.currentSeason,
            flowers
        };
        container.position.set(platform.x, platform.y);

        const w = platform.width;
        const halfW = w / 2;
        const rng = createRng(platform.id);

        const soilColor = config.soilColor;
        const soilTopY = -5; 
        
        const soil = new PIXI.Graphics();
        soil.beginPath();
        
        const cornerRadius = 10;
        soil.moveTo(-halfW, soilTopY + cornerRadius);
        soil.quadraticCurveTo(-halfW, soilTopY, -halfW + cornerRadius, soilTopY);
        soil.lineTo(halfW - cornerRadius, soilTopY);
        soil.quadraticCurveTo(halfW, soilTopY, halfW, soilTopY + cornerRadius);
        
        const segments = Math.ceil(w / 15); 
        const segmentWidth = w / segments;
        
        for (let i = 0; i <= segments; i++) {
            const x = halfW - i * segmentWidth;
            const noise = rng() * 8;
            const y = 8 + noise; 
            
            soil.lineTo(x, y);
        }
        
        soil.closePath();
        soil.fill({ color: soilColor });
        
        container.addChild(soil);

        if (config.hasGrass && this.grassTexture) {
            const grassHeight = 20;
            const grassY = soilTopY + 3; 
            
            const grass = new PIXI.TilingSprite({
                texture: this.grassTexture,
                width: w,
                height: grassHeight
            });
            grass.label = 'grass';
            grass.pivot.set(w / 2, grassHeight);
            grass.position.set(0, grassY);
            
            container.addChild(grass);
        }

        if (config.hasFlowers && this.flowerTextures.length > 0) {
            const numFlowers = Math.floor(w / 60);
            
            for (let i = 0; i < numFlowers; i++) {
                const flowerX = -halfW + (w / (numFlowers + 1)) * (i + 1) + (rng() * 20 - 10);
                
                const texIndex = Math.floor(rng() * this.flowerTextures.length);
                const texture = this.flowerTextures[texIndex];
                
                const sprite = new PIXI.Sprite(texture);
                sprite.anchor.set(0.5, 1);
                
                const scale = 0.6 + rng() * 0.4;
                sprite.scale.set(scale);
                
                sprite.x = flowerX;
                sprite.y = soilTopY + 5; 

                container.addChild(sprite);
                
                flowers.push({
                    sprite,
                    swaySpeed: 2 + rng() * 2,
                    swayOffset: rng() * Math.PI * 2
                });
            }
        }

        return container;
    }

    public resize() {
        // No-op
    }
}

