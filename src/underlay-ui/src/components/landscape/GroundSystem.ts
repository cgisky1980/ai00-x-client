import * as PIXI from 'pixi.js';

export interface GroundGeometry {
    surfacePoints: { x: number, y: number }[];
    physicsPoints: { x: number, y: number }[];
    turfBottomPoints: { x: number, y: number }[];
    stoneConfig: { x: number, y: number, r: number, opacity: number, colorIndex: number }[];
    waterStartX?: number;
    waterEndX?: number;
    waterDepth?: number;
}

export const generateGroundGeometry = (width: number, height: number): GroundGeometry => {
    const surfacePoints: { x: number, y: number }[] = [];
    const physicsPoints: { x: number, y: number }[] = [];
    const startY = 25;
    const PHYSICS_OFFSET = 10;

    const SAMPLE_STEP = 20;
    const numSamples = Math.ceil(width / SAMPLE_STEP) + 1;

    for (let i = 0; i < numSamples; i++) {
        const x = Math.min(i * SAMPLE_STEP, width);
        
        const wave1 = Math.sin(x * 0.008) * 1.5;
        const wave2 = Math.sin(x * 0.023 + 1.7) * 0.8;
        const y = startY + wave1 + wave2;

        surfacePoints.push({ x, y });
        physicsPoints.push({ x, y: y - PHYSICS_OFFSET });
    }

    surfacePoints[0] = { x: 0, y: startY };
    surfacePoints[surfacePoints.length - 1] = { x: width, y: startY };
    physicsPoints[0] = { x: 0, y: startY - PHYSICS_OFFSET };
    physicsPoints[physicsPoints.length - 1] = { x: width, y: startY - PHYSICS_OFFSET };

    const turfBottomPoints: { x: number, y: number }[] = [];
    for (let i = surfacePoints.length - 1; i >= 0; i--) {
        const topPt = surfacePoints[i];
        const thickness = 22 + Math.sin(topPt.x * 0.01) * 5;
        turfBottomPoints.push({ x: topPt.x, y: topPt.y + thickness });
    }

    const stones = [];
    const numStones = Math.floor(width / 40);
    for (let i = 0; i < numStones; i++) {
        const sx = 20 + Math.random() * (width - 40);
        const sy = 55 + Math.random() * (height - 75);
        const r = 2 + Math.random() * 3;
        const opacity = 0.15 + Math.random() * 0.3;
        const colorIndex = Math.random() > 0.5 ? 0 : 1;
        stones.push({ x: sx, y: sy, r, opacity, colorIndex });
    }

    return {
        surfacePoints,
        physicsPoints,
        turfBottomPoints,
        stoneConfig: stones,
    };
};

export const renderGroundSvg = (width: number, height: number, geo: GroundGeometry, season: 'spring' | 'summer' | 'autumn' | 'winter'): string => {
    const { surfacePoints, turfBottomPoints, stoneConfig } = geo;
    const startY = 25;

    const seasonColors = {
        spring: {
            dirtColor: '#6d4c41',
            turfColor: '#7cb342',
            stoneColors: ['#5d4037', '#8d6e63']
        },
        summer: {
            dirtColor: '#5d4037',
            turfColor: '#3f6212',
            stoneColors: ['#3e2723', '#795548']
        },
        autumn: {
            dirtColor: '#5d4037',
            turfColor: '#bf6c35',
            stoneColors: ['#4e342e', '#6d4c41']
        },
        winter: {
            dirtColor: '#4e342e',
            turfColor: '#ffffff',
            stoneColors: ['#cfd8dc', '#b0bec5']
        }
    };

    const colors = seasonColors[season];
    const { dirtColor, turfColor, stoneColors } = colors;

    let dirtPath = `M 0 ${height} L 0 ${startY}`;
    for (let i = 0; i < surfacePoints.length - 1; i++) {
        const p0 = surfacePoints[i];
        const p1 = surfacePoints[i + 1];
        const cp1x = p0.x + (p1.x - p0.x) / 3;
        const cp2x = p1.x - (p1.x - p0.x) / 3;
        dirtPath += ` C ${cp1x} ${p0.y}, ${cp2x} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    dirtPath += ` L ${width} ${height} Z`;

    let turfPath = `M 0 ${surfacePoints[0].y}`;
    for (let i = 0; i < surfacePoints.length - 1; i++) {
        const p0 = surfacePoints[i];
        const p1 = surfacePoints[i + 1];
        const cp1x = p0.x + (p1.x - p0.x) / 3;
        const cp2x = p1.x - (p1.x - p0.x) / 3;
        turfPath += ` C ${cp1x} ${p0.y}, ${cp2x} ${p1.y}, ${p1.x} ${p1.y}`;
    }

    const lastSurface = surfacePoints[surfacePoints.length - 1];
    const turfThickness = 25;
    turfPath += ` L ${lastSurface.x} ${lastSurface.y + turfThickness}`;

    for (let i = 0; i < turfBottomPoints.length - 1; i++) {
        const p0 = turfBottomPoints[i];
        const p1 = turfBottomPoints[i + 1];
        const cp1x = p0.x + (p1.x - p0.x) / 3;
        const cp2x = p1.x - (p1.x - p0.x) / 3;
        turfPath += ` C ${cp1x} ${p0.y}, ${cp2x} ${p1.y}, ${p1.x} ${p1.y}`;
    }

    turfPath += ' Z';

    let stones = '';
    for (const s of stoneConfig) {
        stones += `<circle cx='${s.x}' cy='${s.y}' r='${s.r}' fill='${stoneColors[s.colorIndex]}' opacity='${s.opacity}'/>`;
    }

    return encodeURIComponent(`
        <svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>
            <path d='${dirtPath}' fill='${dirtColor}'/>
            ${stones}
            <path d='${turfPath}' fill='${turfColor}'/>
        </svg>
    `.trim().replace(/\n/g, '').replace(/\s+/g, ' '));
};

export class GroundSystem {
    public container: PIXI.Container;
    public surfacePoints: { x: number, y: number }[] = [];
    public physicsPoints: { x: number, y: number }[] = [];
    public groundSprite: PIXI.TilingSprite | null = null;
    public geometry: GroundGeometry | null = null;
    private currentSeason: 'spring' | 'summer' | 'autumn' | 'winter' = 'summer';

    public static readonly STRIP_WIDTH = 2048 * 2;
    public static readonly GROUND_TEXTURE_HEIGHT = 150;
    public static readonly SURFACE_OFFSET_FROM_BOTTOM = 150;
    public static readonly SURFACE_START_Y_IN_TEXTURE = 25;

    constructor() {
        this.container = new PIXI.Container();
        this.container.zIndex = -10;
    }

    public getGroundY(screenHeight: number): number {
        return screenHeight - GroundSystem.SURFACE_OFFSET_FROM_BOTTOM - GroundSystem.SURFACE_START_Y_IN_TEXTURE;
    }

    public async setup(app: PIXI.Application) {
        this.geometry = generateGroundGeometry(GroundSystem.STRIP_WIDTH, GroundSystem.GROUND_TEXTURE_HEIGHT);
        this.surfacePoints = this.geometry.surfacePoints;
        this.physicsPoints = this.geometry.physicsPoints;

        const svg = renderGroundSvg(GroundSystem.STRIP_WIDTH, GroundSystem.GROUND_TEXTURE_HEIGHT, this.geometry, this.currentSeason);
        const groundTexture = await PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${svg}`);

        this.groundSprite = new PIXI.TilingSprite({
            texture: groundTexture,
            width: app.screen.width,
            height: GroundSystem.GROUND_TEXTURE_HEIGHT
        });

        this.groundSprite.position.set(0, this.getGroundY(app.screen.height));
        this.container.addChild(this.groundSprite);
        app.stage.addChild(this.container);
    }

    public async setSeason(season: 'spring' | 'summer' | 'autumn' | 'winter') {
        if (this.currentSeason === season || !this.geometry || !this.groundSprite) return;
        this.currentSeason = season;

        const svg = renderGroundSvg(GroundSystem.STRIP_WIDTH, GroundSystem.GROUND_TEXTURE_HEIGHT, this.geometry, season);
        const newTexture = await PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${svg}`);

        this.groundSprite.texture = newTexture;
    }

    public resize(width: number, height: number) {
        if (this.groundSprite) {
            this.groundSprite.width = width;
            this.groundSprite.position.y = this.getGroundY(height);
        }
    }
}
