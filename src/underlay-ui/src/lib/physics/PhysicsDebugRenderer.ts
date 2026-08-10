import * as PIXI from 'pixi.js'
import Matter from 'matter-js'
import type { PhysicsSystem } from './PhysicsSystem'

/**
 * 物理系统调试渲染器
 * 在PixiJS中绘制Matter.js的物理刚体边界
 */
export class PhysicsDebugRenderer {
    private container: PIXI.Container
    private graphics: PIXI.Graphics
    private physicsSystem: PhysicsSystem
    private isActive: boolean = false

    constructor(container: PIXI.Container, physicsSystem: PhysicsSystem) {
        this.container = container
        this.physicsSystem = physicsSystem
        this.graphics = new PIXI.Graphics()
        this.graphics.zIndex = 9999 // 确保在最上层
        this.container.addChild(this.graphics)
    }

    /**
     * 启用/禁用调试显示
     */
    setActive(active: boolean): void {
        this.isActive = active
        this.graphics.visible = active
        if (!active) {
            this.graphics.clear()
        }
    }

    /**
     * 更新调试渲染
     */
    update(): void {
        if (!this.isActive) return

        this.graphics.clear()

        // 获取所有刚体
        const bodies = Matter.Composite.allBodies(this.physicsSystem.getWorld())

        // 绘制刚体
        for (const body of bodies) {
            this.drawBody(body)
        }

        // 绘制VRM腿部边界
        const vrmLegsBounds = this.physicsSystem.getVRMLegsBounds()
        if (vrmLegsBounds) {
            this.graphics.beginPath()
            this.graphics.strokeStyle = { width: 2, color: 0xFF00FF, alpha: 0.8 } // 紫色VRM区域
            // 注意：vrmLegsBounds 是屏幕坐标
            // 绘制矩形 (直接使用屏幕坐标，不需要转换，因为graphics是在Pixi容器中，通常对应屏幕坐标)
            // 等等，drawBody 里用了 physicsToScreen。
            // 说明 this.graphics 是在屏幕坐标系下的。
            // vrmLegsBounds 已经是屏幕坐标了。
            
            this.graphics.rect(
                vrmLegsBounds.minX, 
                vrmLegsBounds.minY, 
                vrmLegsBounds.maxX - vrmLegsBounds.minX, 
                vrmLegsBounds.maxY - vrmLegsBounds.minY
            )
            this.graphics.stroke()
            this.graphics.closePath()
        }
    }

    /**
     * 绘制单个刚体
     */
    private drawBody(body: Matter.Body): void {
        // 如果是复合刚体（如地面），绘制其组成部分
        if (body.parts && body.parts.length > 1) {
            // parts[0] 通常是刚体本身（hull），我们跳过它，只画子部分
            for (let i = 1; i < body.parts.length; i++) {
                this.drawVertices(body.parts[i].vertices, body.label)
            }
            // 同时也画一下hull以便调试（用虚线或不同颜色？算了，只画parts更清晰）
            return
        }

        this.drawVertices(body.vertices, body.label)
    }

    private drawVertices(vertices: Matter.Vector[], label: string): void {
        if (!vertices || vertices.length === 0) return

        this.graphics.beginPath()

        // 设置样式
        if (label === 'ground') {
            this.graphics.strokeStyle = { width: 2, color: 0x00FF00, alpha: 0.8 } // 绿色地面
        } else if (label && label.startsWith('platform')) {
            this.graphics.strokeStyle = { width: 2, color: 0x0000FF, alpha: 0.8 } // 蓝色平台
        } else if (label === 'pet') {
            this.graphics.strokeStyle = { width: 2, color: 0xFF0000, alpha: 0.8 } // 红色宠物
        } else {
            this.graphics.strokeStyle = { width: 1, color: 0xFFFFFF, alpha: 0.5 } // 其他
        }

        // 绘制多边形
        const startPoint = this.physicsSystem.physicsToScreen(vertices[0].x, vertices[0].y)
        this.graphics.moveTo(startPoint.x, startPoint.y)

        for (let i = 1; i < vertices.length; i++) {
            const point = this.physicsSystem.physicsToScreen(vertices[i].x, vertices[i].y)
            this.graphics.lineTo(point.x, point.y)
        }

        this.graphics.lineTo(startPoint.x, startPoint.y)
        this.graphics.stroke()
        this.graphics.closePath()
    }

    /**
     * 销毁
     */
    destroy(): void {
        this.container.removeChild(this.graphics)
        this.graphics.destroy()
    }
}
