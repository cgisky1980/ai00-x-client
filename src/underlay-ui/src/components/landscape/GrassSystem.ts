import * as PIXI from 'pixi.js';
import { GroundSystem } from './GroundSystem';

export const generateGrassSvg = (width: number, height: number, colors: string[], density: number = 1) => {
    let paths = '';
    // Increase base density from width/3 to width/2.5
    const numBlades = Math.floor(width / 2.5 * density); 
    
    for (let i = 0; i < numBlades; i++) {
        const x = (i * 2.5) + (Math.random() * 4 - 2); 
        
        let h;
        if (height > 35) { // Front layer (approx 55)
                h = 10 + Math.random() * 20; // 10-30px grass
        } else { // Back layer (approx 22)
                h = height * (0.4 + Math.random() * 0.5);
        }
        
        // Curve scales with height for natural look
        const curveMax = h * 0.3; 
        const curve = (Math.random() * curveMax * 2 - curveMax); 
        const color = colors[Math.floor(Math.random() * colors.length)];
        
        // Dynamic startY based on height
        const startY = height; 
        const endX = x + curve;
        const endY = height - h;
        const ctrlX = x + curve * 0.3;
        const ctrlY = height - h * 0.5;

        paths += `<path d='M${x} ${startY} Q ${ctrlX} ${ctrlY} ${endX} ${endY}' stroke='${color}' stroke-width='${1 + Math.random()}' fill='none' stroke-linecap='round' />`;
    }
    return encodeURIComponent(`
        <svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>
            ${paths}
        </svg>
    `.trim().replace(/\n/g, '').replace(/\s+/g, ' '));
};

export class GrassSystem {
    public meshBack: PIXI.Mesh | null = null;
    public meshFront: PIXI.Mesh | null = null;
    
    private groundSystem: GroundSystem;
    private currentSeason: 'spring' | 'summer' | 'autumn' | 'winter' = 'summer';
    private app: PIXI.Application | null = null;

    constructor(groundSystem: GroundSystem) {
        this.groundSystem = groundSystem;
    }

    public async setSeason(season: 'spring' | 'summer' | 'autumn' | 'winter') {
        if (this.currentSeason === season) return;
        this.currentSeason = season;
        
        if (this.app) {
            await this.rebuildGrass(this.app);
        }
    }

    private getGrassColorsForSeason(season: string) {
        const seasonColors = {
            spring: {
                front: ['#a5d6a7', '#81c784', '#c8e6c9'],
                back: ['#4caf50', '#66bb6a', '#43a047']
            },
            summer: {
                front: ['#4ade80', '#22c55e', '#86efac'],
                back: ['#166534', '#15803d', '#14532d']
            },
            autumn: {
                front: ['#d4a574', '#c9956c', '#b8860b'],
                back: ['#8b6914', '#a0522d', '#cd853f']
            },
            winter: {
                front: ['#e8e8e8', '#d4d4d4', '#f0f0f0'],
                back: ['#b0b0b0', '#a0a0a0', '#c0c0c0']
            }
        };
        return seasonColors[season as keyof typeof seasonColors] || seasonColors.summer;
    }

    private async rebuildGrass(app: PIXI.Application) {
        const colors = this.getGrassColorsForSeason(this.currentSeason);
        const isWinter = this.currentSeason === 'winter';
        
        const grassSvgFront = generateGrassSvg(512, 55, colors.front, isWinter ? 0.6 : 1.5);
        const grassSvgBack = generateGrassSvg(512, 22, colors.back, isWinter ? 0.5 : 1.0);

        const grassTextureFront = await PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${grassSvgFront}`);
        const grassTextureBack = await PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${grassSvgBack}`);

        grassTextureFront.source.style.addressModeU = 'repeat';
        grassTextureFront.source.style.addressModeV = 'clamp-to-edge';
        grassTextureBack.source.style.addressModeU = 'repeat';
        grassTextureBack.source.style.addressModeV = 'clamp-to-edge';

        if (this.meshFront) {
            app.stage.removeChild(this.meshFront);
            this.meshFront.destroy();
        }
        if (this.meshBack) {
            app.stage.removeChild(this.meshBack);
            this.meshBack.destroy();
        }

        this.meshBack = this.createGrassMesh(app, grassTextureBack, -15, 22);
        this.meshFront = this.createGrassMesh(app, grassTextureFront, 20, 55);

        app.stage.addChild(this.meshBack);
        app.stage.addChild(this.meshFront);
    }

    private createGrassMesh(app: PIXI.Application, texture: PIXI.Texture, zIndex: number, height: number) {
        const segments = Math.ceil(app.screen.width / 40); // Segments for wind
        
        const geometry = new PIXI.PlaneGeometry({
            width: app.screen.width,
            height: height,
            verticesX: segments,
            verticesY: 2
        });
        
        const mesh = new PIXI.Mesh({
            geometry,
            texture
        });
        mesh.zIndex = zIndex;
        mesh.position.set(0, 0); 
        return mesh;
    }

    public async setup(app: PIXI.Application) {
        this.app = app;
        await this.rebuildGrass(app);
    }

    public update(time: number, app: PIXI.Application) {
        if (this.meshBack) this.updateGrassMesh(app, this.meshBack, time, 0.7, 3, 22);
        if (this.meshFront) this.updateGrassMesh(app, this.meshFront, time, 1.0, 5, 55);
    }

    private updateGrassMesh(app: PIXI.Application, mesh: PIXI.Mesh, time: number, speed: number, amp: number, fixedHeight: number) {
        const geometry = mesh.geometry;
        const verticesBuffer = geometry.getBuffer('aPosition');
        const uvsBuffer = geometry.getBuffer('aUV') || geometry.getBuffer('aTextureCoord');
        
        if (!verticesBuffer || !uvsBuffer) return;

        const vertices = verticesBuffer.data;
        const totalPoints = vertices.length / 2;
        const verticesX = totalPoints / 2;
        
        const w = app.screen.width;
        const segW = w / (verticesX - 1);
        
        for (let i = 0; i < verticesX; i++) {
            const xScreen = i * segW;
            
            const xTexture = xScreen % GroundSystem.STRIP_WIDTH;
            
            let groundY = 25;
            const groundSurfacePoints = this.groundSystem.surfacePoints;
            
            for (let j = 0; j < groundSurfacePoints.length - 1; j++) {
                if (xTexture >= groundSurfacePoints[j].x && xTexture <= groundSurfacePoints[j+1].x) {
                    const p0 = groundSurfacePoints[j];
                    const p1 = groundSurfacePoints[j+1];
                    const t = (xTexture - p0.x) / (p1.x - p0.x);
                    groundY = p0.y + (p1.y - p0.y) * t;
                    break;
                }
            }

            const wind = Math.sin(time * speed + i * 0.2) * amp;
            
            const surfaceScreenY = this.groundSystem.getGroundY(app.screen.height) + groundY;
            
            const bottomY = surfaceScreenY + 5;
            const topY = bottomY - fixedHeight;
            
            vertices[i * 2] = xScreen + wind;
            vertices[i * 2 + 1] = topY; 
            
            vertices[(i + verticesX) * 2] = xScreen;
            vertices[(i + verticesX) * 2 + 1] = bottomY;
        }
        verticesBuffer.update();

        // Update UVs for tiling
        const uvs = uvsBuffer.data;
        const textureW = 512; // Our generated SVG width
        const totalRatio = w / textureW;
        
        for (let i = 0; i < verticesX; i++) {
            const u = (i / (verticesX - 1)) * totalRatio;
            
            // Top UV
            uvs[i * 2] = u;
            uvs[i * 2 + 1] = 0;
            
            // Bottom UV
            uvs[(i + verticesX) * 2] = u;
            uvs[(i + verticesX) * 2 + 1] = 1;
        }
        uvsBuffer.update();
    }

    public resize(_width: number, _height: number) {
        // We just rely on update loop to fix positions based on screen width/height
    }
}
