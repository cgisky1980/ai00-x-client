import * as PIXI from 'pixi.js';
import { GroundSystem } from './GroundSystem';

// Generate Flower SVG (White/Grayscale for tinting)
export const generateFlowerSvg = () => {
    return (color: string, typeIdx: number) => {
         let p = '';
         const endX = 20; // Center
         const endY = 80; // Bottom
         
         // We need a stem.
         const stemH = 15 + Math.random() * 40; // 15-55px stem
         const topY = endY - stemH;
         
         // Curve
         const curve = (Math.random() * 10 - 5);
         p += `<path d='M${endX} ${endY} Q ${endX + curve * 0.5} ${endY - stemH * 0.5} ${endX + curve} ${topY}' stroke='#166534' stroke-width='2' fill='none' />`;
         
         const flowerX = endX + curve;
         const flowerY = topY;
         
         // Flower Head
         switch (typeIdx % 8) {
            case 0: // Sunflower / Daisy
                p += `<circle cx='${flowerX}' cy='${flowerY}' r='${6 + Math.random() * 3}' fill='${color}'/>`;
                p += `<circle cx='${flowerX}' cy='${flowerY}' r='3' fill='#fffacd'/>`;
                break;
            case 1: // Lavender (Stack)
                p += `<rect x='${flowerX-2}' y='${flowerY-10}' width='4' height='15' rx='2' fill='${color}' transform='rotate(${curve * 2}, ${flowerX}, ${flowerY})'/>`;
                break;
            case 2: // Tulip
                p += `<path d='M${flowerX-4},${flowerY} Q${flowerX},${flowerY+8} ${flowerX+4},${flowerY} L${flowerX},${flowerY+8} Z' fill='${color}' transform='translate(0, -5)'/>`;
                break;
            case 3: // Poppy
                p += `<path d='M${flowerX-5},${flowerY} Q${flowerX},${flowerY+6} ${flowerX+5},${flowerY} Q${flowerX},${flowerY-3} ${flowerX-5},${flowerY} Z' fill='${color}'/>`;
                p += `<circle cx='${flowerX}' cy='${flowerY+1}' r='2' fill='#3e2723'/>`;
                break;
            case 4: // Cattail
                const catColor = '#5d4037';
                p += `<rect x='${flowerX-3}' y='${flowerY-5}' width='6' height='15' rx='3' fill='${catColor}' transform='rotate(${curve}, ${flowerX}, ${flowerY})'/>`;
                break;
            case 5: // Bluebell
                 p += `<path d='M${flowerX},${flowerY} Q${flowerX+4},${flowerY+3} ${flowerX+3},${flowerY+7} L${flowerX-3},${flowerY+7} Q${flowerX-4},${flowerY+3} ${flowerX},${flowerY} Z' fill='${color}' transform='rotate(160, ${flowerX}, ${flowerY})'/>`;
                break;
            case 6: // Allium
                p += `<circle cx='${flowerX}' cy='${flowerY}' r='4' fill='${color}' opacity='0.7'/>`;
                p += `<circle cx='${flowerX-2}' cy='${flowerY-2}' r='1.5' fill='${color}'/>`;
                p += `<circle cx='${flowerX+2}' cy='${flowerY+2}' r='1.5' fill='${color}'/>`;
                break;
            case 7: // Coneflower
                p += `<path d='M${flowerX},${flowerY} L${flowerX-4},${flowerY+8} M${flowerX},${flowerY} L${flowerX+4},${flowerY+8} M${flowerX},${flowerY} L${flowerX},${flowerY+9}' stroke='${color}' stroke-width='2'/>`;
                p += `<circle cx='${flowerX}' cy='${flowerY-2}' r='3' fill='#3e2723'/>`;
                break;
         }
         
         return encodeURIComponent(`
            <svg xmlns='http://www.w3.org/2000/svg' width='40' height='100' viewBox='0 0 40 100'>
                ${p}
            </svg>
        `.trim().replace(/\n/g, '').replace(/\s+/g, ' '));
    };
};

interface FlowerInstance {
    sprite: PIXI.Sprite;
    baseX: number; // Screen X (absolute)
    baseY: number; // Ground Y (relative to ground)
    swaySpeed: number;
    swayOffset: number;
    height: number;
    inFront: boolean; // true=角色前面(zIndex=15), false=角色后面(zIndex=9)
}

export class FlowerSystem {
    /** 后层容器（角色后面，zIndex=9 < 角色 zIndex=10） */
    public container: PIXI.Container;
    /** 前层容器（角色前面，zIndex=15 > 角色 zIndex=10） */
    public frontContainer: PIXI.Container;
    private flowers: FlowerInstance[] = [];
    private groundSystem: GroundSystem;
    private currentSeason: 'spring' | 'summer' | 'autumn' | 'winter' = 'summer';
    private app: PIXI.Application | null = null;

    constructor(groundSystem: GroundSystem) {
        this.groundSystem = groundSystem;
        // 后层：角色后面
        this.container = new PIXI.Container();
        this.container.zIndex = 9;
        // 前层：角色前面
        this.frontContainer = new PIXI.Container();
        this.frontContainer.zIndex = 15;
    }

    private getFlowerColorsForSeason(season: string): string[] {
        const seasonColors = {
            spring: ['#ffc0cb', '#ffb6c1', '#fff0f5', '#ffe4e1', '#ff69b4', '#ffffff', '#ffccd5'],
            summer: ['#fca5a5', '#fde047', '#e9d5ff', '#ffffff', '#93c5fd', '#ff6b6b', '#4ecdc4'],
            autumn: ['#d2691e', '#cd853f', '#b8860b', '#daa520', '#8b4513', '#a0522d', '#d4a574'],
            winter: []
        };
        return seasonColors[season as keyof typeof seasonColors] || seasonColors.summer;
    }

    public async setSeason(season: 'spring' | 'summer' | 'autumn' | 'winter') {
        if (this.currentSeason === season) return;
        this.currentSeason = season;
        
        if (this.app) {
            await this.spawnFlowers(this.app);
        }
    }

    public async setup(app: PIXI.Application) {
        this.app = app;
        app.stage.addChild(this.container);
        app.stage.addChild(this.frontContainer);
        await this.spawnFlowers(app);
    }

    public async spawnFlowers(app: PIXI.Application) {
        this.container.removeChildren();
        this.frontContainer.removeChildren();
        this.flowers = [];

        const flowerColors = this.getFlowerColorsForSeason(this.currentSeason);
        
        if (flowerColors.length === 0) {
            return;
        }

        const screenW = app.screen.width;
        const numFlowers = Math.floor(screenW / 40); 
        
        const flowerGen = generateFlowerSvg(); 

        // Pre-generate data for all flowers
        const flowerData = [];
        for (let i = 0; i < numFlowers; i++) {
             const x = Math.random() * screenW;
             
             const type = Math.floor(Math.random() * 8);
             const color = flowerColors[Math.floor(Math.random() * flowerColors.length)];
             const svg = flowerGen(color, type);
             flowerData.push({ x, type, color, svg });
        }

        // Load all textures in parallel
        const texturePromises = flowerData.map(d => PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${d.svg}`));
        const textures = await Promise.all(texturePromises);

        const groundSurfacePoints = this.groundSystem.surfacePoints;

        // Create Sprites
        flowerData.forEach((data, i) => {
            const texture = textures[i];
            const sprite = new PIXI.Sprite(texture);
            sprite.anchor.set(0.5, 1); // Bottom Center
            
            // Determine Ground Y at this X
            const xTexture = data.x % GroundSystem.STRIP_WIDTH;
            let groundY = 25;
            for (let j = 0; j < groundSurfacePoints.length - 1; j++) {
                if (xTexture >= groundSurfacePoints[j].x && xTexture <= groundSurfacePoints[j+1].x) {
                     const p0 = groundSurfacePoints[j];
                     const p1 = groundSurfacePoints[j+1];
                     const t = (xTexture - p0.x) / (p1.x - p0.x);
                     groundY = p0.y + (p1.y - p0.y) * t;
                     break;
                }
            }
            
            // Random scale/size variation
            const scale = 0.8 + Math.random() * 0.4;
            sprite.scale.set(scale);

            sprite.x = data.x;
            const y = this.groundSystem.getGroundY(app.screen.height) + groundY + 10;
            sprite.y = y;

            // 随机分配到角色前面或后面
            const inFront = Math.random() < 0.5;
            if (inFront) {
                this.frontContainer.addChild(sprite);
            } else {
                this.container.addChild(sprite);
            }

            this.flowers.push({
                sprite,
                baseX: data.x,
                baseY: groundY,
                swaySpeed: 2 + Math.random() * 2,
                swayOffset: Math.random() * Math.PI * 2,
                height: 80 * scale,
                inFront
            });
        });
    }

    public update(time: number) {
        for (const flower of this.flowers) {
            // Wind Sway
            const wind = Math.sin(time * flower.swaySpeed + flower.swayOffset);
            // Rotate around bottom anchor
            // Max rotation around 5-10 degrees (0.08 - 0.17 rad)
            flower.sprite.rotation = wind * 0.1;
        }
    }

    public resize(app: PIXI.Application) {
        // Re-spawn on resize (lazy way to handle distribution)
        this.spawnFlowers(app);
    }
}
