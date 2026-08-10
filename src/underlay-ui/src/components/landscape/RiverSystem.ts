import * as PIXI from 'pixi.js';
const FillGradient = PIXI.FillGradient;
import { GroundGeometry, GroundSystem } from './GroundSystem';

export interface WaterZone {
    x: number;
    y: number;
    width: number;
    height: number;
    flowSpeed: number;
    flowDirection: number;
}

const seasonWaterColors = {
    spring: {
        surfaceColor: 0x4fc3f7,
        deepColor: 0x0288d1,
        highlightColor: 0x81d4fa,
    },
    summer: {
        surfaceColor: 0x29b6f6,
        deepColor: 0x01579b,
        highlightColor: 0x4fc3f7,
    },
    autumn: {
        surfaceColor: 0x4db6ac,
        deepColor: 0x00695c,
        highlightColor: 0x80cbc4,
    },
    winter: {
        surfaceColor: 0xe3f2fd,
        deepColor: 0xbbdefb,
        highlightColor: 0xffffff,
    },
};

export class RiverSystem {
    public container: PIXI.Container;
    private waterGraphics: PIXI.Graphics | null = null;
    private geometry: GroundGeometry | null = null;
    private time: number = 0;
    private currentSeason: 'spring' | 'summer' | 'autumn' | 'winter' = 'summer';
    private isFrozen: boolean = false;
    private groundY: number = 0;

    public waterZones: WaterZone[] = [];

    constructor() {
        this.container = new PIXI.Container();
        this.container.zIndex = -5;
    }

    public setup(
        app: PIXI.Application,
        groundY: number,
        groundGeometry: GroundGeometry
    ): void {
        this.geometry = groundGeometry;
        this.groundY = groundY;

        this.createWaterGraphics(app, groundY);

        const waterStartX = groundGeometry.waterStartX ?? 0;
        const waterEndX = groundGeometry.waterEndX ?? 0;
        const waterDepth = groundGeometry.waterDepth ?? 30;

        this.waterZones = [
            {
                x: waterStartX,
                y: groundY,
                width: waterEndX - waterStartX,
                height: waterDepth + 30,
                flowSpeed: 0.3,
                flowDirection: 1,
            },
        ];

        app.stage.addChild(this.container);
    }

    private createWaterGraphics(_app: PIXI.Application, groundY: number): void {
        if (!this.geometry) return;

        this.waterGraphics = new PIXI.Graphics();
        this.container.addChild(this.waterGraphics);

        this.drawWater(groundY);
    }

    private drawWater(_groundY: number): void {
        if (!this.waterGraphics || !this.geometry) return;

        const waterStartX = this.geometry.waterStartX ?? 0;
        const waterEndX = this.geometry.waterEndX ?? 0;
        const { surfacePoints } = this.geometry;
        const colors = seasonWaterColors[this.currentSeason];

        this.waterGraphics.clear();

        if (this.isFrozen) {
            this.drawFrozenWater(colors);
            return;
        }

        const waveOffset = this.time * 0.3 * 1 * 25;
        const waveAmplitude = 3;
        const waveFrequency = 0.025;

        const waterSurfacePoints = surfacePoints.filter(p => p.x >= waterStartX && p.x <= waterEndX);

        if (waterSurfacePoints.length === 0) return;

        const leftPt = surfacePoints.find(p => p.x >= waterStartX) || surfacePoints[0];
        const rightPt = surfacePoints.find(p => p.x >= waterEndX) || surfacePoints[surfacePoints.length - 1];

        // 关键修复：所有 Y 坐标需要加上 groundY 偏移（从纹理坐标转换为屏幕坐标）
        const offsetY = this.groundY;

        this.waterGraphics.moveTo(leftPt.x, offsetY + leftPt.y);

        for (const p of waterSurfacePoints) {
            const waveY = offsetY + p.y + Math.sin((p.x + waveOffset) * waveFrequency) * waveAmplitude;
            this.waterGraphics.lineTo(p.x, waveY);
        }

        this.waterGraphics.lineTo(rightPt.x, offsetY + rightPt.y);
        this.waterGraphics.lineTo(rightPt.x, offsetY + rightPt.y + 50);
        this.waterGraphics.lineTo(leftPt.x, offsetY + leftPt.y + 50);
        this.waterGraphics.closePath();

        const gradient = new FillGradient({
            type: 'linear',
            start: { x: 0, y: 0 },
            end: { x: 0, y: 1 },
            colorStops: [
                { offset: 0, color: colors.surfaceColor },
                { offset: 0.6, color: colors.deepColor },
                { offset: 1, color: colors.deepColor },
            ],
        });

        this.waterGraphics.fill(gradient);

        const numHighlights = 8;
        for (let i = 0; i < numHighlights; i++) {
            const idx = Math.floor((i + 0.5) * (waterSurfacePoints.length / numHighlights));
            if (idx >= waterSurfacePoints.length) continue;

            const p = waterSurfacePoints[idx];
            const waveY = offsetY + p.y + Math.sin((p.x + waveOffset) * waveFrequency) * waveAmplitude;

            this.waterGraphics.circle(p.x, waveY - 2, 2 + Math.sin(this.time * 2 + i) * 1);
            this.waterGraphics.fill({
                color: colors.highlightColor,
                alpha: 0.35 + Math.sin(this.time * 3 + i) * 0.15,
            });
        }
    }

    private drawFrozenWater(colors: {
        surfaceColor: number;
        deepColor: number;
        highlightColor: number;
    }): void {
        if (!this.waterGraphics || !this.geometry) return;

        const waterStartX = this.geometry.waterStartX ?? 0;
        const waterEndX = this.geometry.waterEndX ?? 0;
        const { surfacePoints } = this.geometry;
        const waterSurfacePoints = surfacePoints.filter(p => p.x >= waterStartX && p.x <= waterEndX);

        if (waterSurfacePoints.length === 0) return;

        const leftPt = surfacePoints.find(p => p.x >= waterStartX) || surfacePoints[0];
        const rightPt = surfacePoints.find(p => p.x >= waterEndX) || surfacePoints[surfacePoints.length - 1];

        const offsetY = this.groundY;

        this.waterGraphics.moveTo(leftPt.x, offsetY + leftPt.y);

        for (const p of waterSurfacePoints) {
            this.waterGraphics.lineTo(p.x, offsetY + p.y);
        }

        this.waterGraphics.lineTo(rightPt.x, offsetY + rightPt.y);
        this.waterGraphics.lineTo(rightPt.x, offsetY + rightPt.y + 50);
        this.waterGraphics.lineTo(leftPt.x, offsetY + leftPt.y + 50);
        this.waterGraphics.closePath();

        this.waterGraphics.fill({
            color: colors.surfaceColor,
            alpha: 0.9,
        });

        this.drawIceCracks(colors);
    }

    private drawIceCracks(colors: {
        surfaceColor: number;
        deepColor: number;
        highlightColor: number;
    }): void {
        if (!this.waterGraphics || !this.geometry) return;

        const waterStartX = this.geometry.waterStartX ?? 0;
        const waterEndX = this.geometry.waterEndX ?? 0;
        const waterDepth = this.geometry.waterDepth ?? 30;
        const { surfacePoints } = this.geometry;
        const waterSurfacePoints = surfacePoints.filter(p => p.x >= waterStartX && p.x <= waterEndX);
        if (waterSurfacePoints.length === 0) return;

        // 找到水域中心点的水面 Y 坐标（屏幕坐标）
        const centerX = waterStartX + (waterEndX - waterStartX) / 2;
        const centerPt = surfacePoints.find(p => p.x >= centerX) || surfacePoints[0];
        const surfaceScreenY = this.groundY + (centerPt ? centerPt.y : 0);
        const centerY = surfaceScreenY + waterDepth / 2;

        const crackLines = [
            [{ x: centerX - 20, y: centerY - 10 }, { x: centerX + 10, y: centerY + 15 }],
            [{ x: centerX + 15, y: centerY - 5 }, { x: centerX - 5, y: centerY + 20 }],
            [{ x: centerX - 30, y: centerY + 5 }, { x: centerX - 10, y: centerY - 5 }],
        ];

        for (const line of crackLines) {
            this.waterGraphics.moveTo(line[0].x, line[0].y);
            this.waterGraphics.lineTo(line[1].x, line[1].y);
            this.waterGraphics.stroke({
                color: colors.deepColor,
                alpha: 0.3,
                width: 1,
            });
        }
    }

    public update(deltaTime: number): void {
        if (this.isFrozen) return;

        this.time += deltaTime;

        if (this.geometry && this.waterGraphics) {
            this.drawWater(this.groundY);
        }
    }

    public setSeason(season: 'spring' | 'summer' | 'autumn' | 'winter'): void {
        this.currentSeason = season;
        this.isFrozen = season === 'winter';

        if (this.geometry && this.waterGraphics) {
            this.drawWater(this.groundY);
        }
    }

    public getWaterZones(): WaterZone[] {
        return this.waterZones;
    }

    public isInWater(x: number, y: number): boolean {
        if (!this.geometry) return false;

        const waterStartX = this.geometry.waterStartX ?? 0;
        const waterEndX = this.geometry.waterEndX ?? 0;
        const waterDepth = this.geometry.waterDepth ?? 30;

        return x >= waterStartX && x <= waterEndX && y >= this.groundY && y <= this.groundY + waterDepth + 30;
    }

    public resize(_width: number, height: number): void {
        // 更新 groundY 以匹配 GroundSystem 的位置
        this.groundY = height - GroundSystem.SURFACE_OFFSET_FROM_BOTTOM - GroundSystem.SURFACE_START_Y_IN_TEXTURE;
        if (this.geometry && this.waterGraphics) {
            this.drawWater(this.groundY);
        }
    }
}
