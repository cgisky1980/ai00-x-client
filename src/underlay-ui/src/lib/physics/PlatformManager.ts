import type { PhysicsSystem, Platform } from './PhysicsSystem'
import type { GridItem, Category } from '@underlay/desktop/types'

/**
 * 平台数据管理器
 * 负责从桌面Grid系统提取平台信息，并同步到物理系统
 */
export class PlatformManager {
    private physicsSystem: PhysicsSystem
    private platforms: Map<string, Platform> = new Map()

    // GridStack单元格尺寸（像素）
    private cellWidth: number = 0
    private cellHeight: number = 0
    private cols: number = 24 // 默认值
    private rows: number = 12 // 默认值
    private topOffset: number = 0
    private leftOffset: number = 0
    private bottomOffset: number = 0
    private fixedCellHeight: number | null = null
    private insetTop: number = 0
    private insetSide: number = 0
    private insetBottom: number = 0

    constructor(physicsSystem: PhysicsSystem) {
        this.physicsSystem = physicsSystem
        this.updateCellSize()

        // 监听窗口大小变化
        window.addEventListener('resize', () => {
            this.updateCellSize()
            // 注意：这里我们无法自动重新计算平台，因为没有gridItems数据
            // 必须等待下一次updatePlatforms调用
            // 但我们可以清空现有平台，避免位置错误
            this.clear()
        })
    }

    /**
     * 更新单元格尺寸
     */
    private updateCellSize(): void {
        this.cellWidth = window.innerWidth / this.cols
        const availableHeight = Math.max(1, window.innerHeight - this.topOffset - this.bottomOffset)
        this.cellHeight = this.fixedCellHeight ?? (availableHeight / this.rows)
    }

    /**
     * 设置网格行列数
     */
    setGridDimensions(cols: number, rows: number): void {
        if (this.cols !== cols || this.rows !== rows) {
            this.cols = cols || 24
            this.rows = rows || 12
            this.updateCellSize()
            // 尺寸变化后，旧的平台位置可能不对，先清空
            this.clear()
        }
    }

    /**
     * 设置Grid单元格尺寸 (直接设置像素值，用于调试或特殊情况)
     */
    setCellSize(cellWidth: number, cellHeight: number): void {
        this.cellWidth = cellWidth
        this.cellHeight = cellHeight
    }

    setFixedCellHeight(px: number | null): void {
        this.fixedCellHeight = px ?? null
        this.updateCellSize()
    }

    setInset(top: number, side: number, bottom?: number): void {
        this.insetTop = Math.max(0, top || 0)
        this.insetSide = Math.max(0, side || 0)
        const b = bottom !== undefined ? bottom : top
        this.insetBottom = Math.max(0, b || 0)
    }

    /**
     * 设置屏幕偏移（用于Grid容器的顶部/左侧占位调整）
     */
    setOffsets(topOffset: number, leftOffset: number = 0, bottomOffset: number = 0): void {
        this.topOffset = topOffset || 0
        this.leftOffset = leftOffset || 0
        this.bottomOffset = bottomOffset || 0
        this.updateCellSize()
    }

    /**
     * 从GridItem提取平台信息
     * @param item GridItem
     * @returns Platform | null
     */
    private gridItemToPlatform(item: GridItem): Platform | null {
        // 确保尺寸有效
        if (this.cellWidth <= 0 || this.cellHeight <= 0) return null

        const w = item.w ?? 1
        const h = item.h ?? 1
        const xLeft = this.leftOffset + item.x * this.cellWidth + this.insetSide
        const yTop = this.topOffset + item.y * (this.fixedCellHeight ?? this.cellHeight) + this.insetTop
        const widthPx = Math.max(1, w * this.cellWidth - this.insetSide * 2)
        const heightPx = Math.max(1, h * (this.fixedCellHeight ?? this.cellHeight) - this.insetTop - this.insetBottom)

        return {
            id: item.path,
            x: xLeft + widthPx / 2,
            y: yTop,
            width: widthPx,
            height: heightPx,
            type: item.kind === 'category' ? 'category' : (item.kind === 'widget' ? 'widget' : 'shortcut')
        }
    }

    /**
     * 更新平台列表
     * @param gridItems 桌面Grid项列表
     * @param categories 分类列表 (unused but kept for interface compatibility if needed)
     */
    updatePlatforms(gridItems: GridItem[], _categories: Category[]): void {
        const newPlatforms = new Map<string, Platform>()

        // 从GridItems提取平台（包含category/shortcut）
        for (const item of gridItems) {
            const platform = this.gridItemToPlatform(item)
            if (platform) newPlatforms.set(platform.id, platform)
        }

        // 对比差异，更新物理系统
        // 1. 移除不存在的平台
        for (const [id, _] of this.platforms) {
            if (!newPlatforms.has(id)) {
                this.physicsSystem.removePlatform(id)
                this.platforms.delete(id)
            }
        }

        // 2. 添加或更新平台
        for (const [id, platform] of newPlatforms) {
            const existingPlatform = this.platforms.get(id)

            // 检查是否需要更新
            const needsUpdate = !existingPlatform ||
                existingPlatform.x !== platform.x ||
                existingPlatform.y !== platform.y ||
                existingPlatform.width !== platform.width ||
                existingPlatform.height !== platform.height

            if (needsUpdate) {
                this.physicsSystem.addOrUpdatePlatform(platform)
                this.platforms.set(id, platform)
            }
        }

        this.physicsSystem.wakePets()
    }

    /**
     * 获取所有平台
     */
    getPlatforms(): Platform[] {
        return Array.from(this.platforms.values())
    }

    getCellSize(): { width: number, height: number } {
        return { width: this.cellWidth, height: this.cellHeight }
    }

    /**
     * 根据ID获取平台
     * @param id 平台ID
     */
    getPlatform(id: string): Platform | undefined {
        return this.platforms.get(id)
    }

    /**
     * 清空所有平台
     */
    clear(): void {
        for (const id of this.platforms.keys()) {
            this.physicsSystem.removePlatform(id)
        }
        this.platforms.clear()
    }
}
