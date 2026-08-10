// ========================================================================
// 花园工具栏（GardenToolbar）
// ========================================================================
// 职责：
// - 提供底部浮动工具栏（HTML 浮层，非 PIXI）
// - "添加花盆"按钮：进入放置模式，下次点击屏幕任意位置放花盆
// - "收集册"按钮：打开收集册面板（Step 11 实现，此处占位）
// - "调试"按钮：清空所有数据（开发用）
// ========================================================================

import React, { useState, useCallback, useEffect } from 'react';
import { useGarden } from './MicroGardenLayer';
import { PotRenderer } from '../lib/world/PotRenderer';
import { ItemManager } from '../lib/world/ItemManager';
import { PLANT_CONFIGS } from '../lib/world/data/plants';
import type { PlantType } from '../lib/world/types';

interface PlaceMode {
    active: boolean;
    style: 'clay' | 'wood' | 'ceramic';
}

export const GardenToolbar: React.FC = () => {
    const { app, gardenManager, plantSystem, physicsSystem, userAvatar } = useGarden();
    const [placeMode, setPlaceMode] = useState<PlaceMode>({ active: false, style: 'clay' });
    const [showSeedPanel, setShowSeedPanel] = useState(false);
    const [selectedPotId, setSelectedPotId] = useState<string | null>(null);
    /** 种植面板定位锚点（花盆屏幕坐标） */
    const [panelAnchor, setPanelAnchor] = useState<{ x: number; y: number } | null>(null);
    const [itemManager, setItemManager] = useState<ItemManager | null>(null);
    const [potRenderer, setPotRenderer] = useState<PotRenderer | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    // 花盆点击处理（在 useEffect 之前定义，避免引用问题）
    const handlePotClick = useCallback(async (potId: string, screenX?: number, screenY?: number) => {
        if (!gardenManager || !plantSystem || !itemManager) return;
        const pot = gardenManager.getSnapshot().pots.find(p => p.id === potId);
        if (!pot) return;

        if (pot.plantId) {
            // 有植物：浇水或收获
            const plant = gardenManager.getSnapshot().plants.find(p => p.id === pot.plantId);
            if (!plant) return;

            const canHarvest = plant.stage === 'blooming' || plant.stage === 'fruiting';
            const canWater = plant.stage !== 'wilting' && !canHarvest;
            if (!canHarvest && !canWater) return;

            const behavior = userAvatar?.behavior;
            if (behavior) {
                // 走到花盆旁边再执行动作（偏移 50px，从主人当前位置决定站哪侧）
                const snap = gardenManager.getSnapshot();
                const offset = 50;
                const rawTarget = snap.avatar.x < pot.x ? pot.x - offset : pot.x + offset;
                const targetX = Math.max(40, Math.min(window.innerWidth - 40, rawTarget));
                behavior.walkToTarget(targetX, () => {
                    const activity = canHarvest ? 'harvesting' : 'watering';
                    const mood = canHarvest ? 'happy' : 'focused';
                    void behavior.setActivity(activity, mood, 3000);
                    const action = canHarvest
                        ? plantSystem.harvest(plant.id)
                        : plantSystem.water(plant.id);
                    void action.then(() => setRefreshKey(k => k + 1));
                });
            } else {
                // avatar 未加载，直接执行
                if (canHarvest) {
                    await plantSystem.harvest(plant.id);
                } else {
                    await plantSystem.water(plant.id);
                }
                setRefreshKey(k => k + 1);
            }
        } else {
            // 空花盆：打开种植面板，定位到花盆上方
            setSelectedPotId(potId);
            setPanelAnchor({ x: screenX ?? pot.x, y: screenY ?? pot.y });
            setShowSeedPanel(true);
        }
    }, [gardenManager, plantSystem, itemManager, userAvatar]);

    // 初始化 PotRenderer + ItemManager（useEffect 避免渲染期间 setState）
    useEffect(() => {
        if (!app || !gardenManager) return;
        const pr = new PotRenderer(app, gardenManager, physicsSystem);
        pr.start();
        setPotRenderer(pr);

        const im = new ItemManager(gardenManager);
        setItemManager(im);

        return () => {
            pr.stop();
        };
    }, [app, gardenManager, physicsSystem]);

    // 设置 potRenderer 回调（handlePotClick 变化时重新绑定）
    useEffect(() => {
        if (!potRenderer) return;
        potRenderer.onClick = (potId, _pot, screenX, screenY) => {
            void handlePotClick(potId, screenX, screenY);
        };
        potRenderer.onContext = (potId) => {
            if (confirm('删除这个花盆？连带植物一起删除。')) {
                void potRenderer.removePot(potId);
                setRefreshKey(k => k + 1);
            }
        };
    }, [potRenderer, handlePotClick]);

    // 放置模式：通过全屏 Overlay 捕获点击（见 JSX 中的条件渲染）
    // Overlay 的 pointerEvents:'auto' 确保浏览器和桌面嵌入模式都能收到 click

    // 非放置模式时，监听 window click 处理花盆交互（点击/右键）
    useEffect(() => {
        if (placeMode.active || !potRenderer) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('[data-garden-toolbar]')) return;
            if (target.closest('[data-planting-panel]')) return;
            // 拖动刚结束，忽略这次 click
            if (potRenderer.justDragged) return;

            const pot = potRenderer.getPotAt(e.clientX, e.clientY);
            if (pot) {
                e.preventDefault();
                e.stopPropagation();
                potRenderer.clearHighlight();
                potRenderer.highlightPot(pot.id);
                if (e.button === 2 || e.ctrlKey) {
                    // 右键 / Ctrl+点击：删除花盆
                    if (confirm('删除这个花盆？连带植物一起删除。')) {
                        void potRenderer.removePot(pot.id);
                        setRefreshKey(k => k + 1);
                    }
                } else {
                    // 左键：浇水/收获/种植
                    void handlePotClick(pot.id, e.clientX, e.clientY);
                }
            } else {
                potRenderer.clearHighlight();
            }
        };
        // 右键单独处理（contextmenu 事件）
        const contextHandler = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (target.closest('[data-garden-toolbar]')) return;
            const pot = potRenderer.getPotAt(e.clientX, e.clientY);
            if (pot) {
                e.preventDefault();
                e.stopPropagation();
                if (confirm('删除这个花盆？连带植物一起删除。')) {
                    void potRenderer.removePot(pot.id);
                    setRefreshKey(k => k + 1);
                }
            }
        };
        window.addEventListener('click', handler, true);
        window.addEventListener('contextmenu', contextHandler, true);
        return () => {
            window.removeEventListener('click', handler, true);
            window.removeEventListener('contextmenu', contextHandler, true);
        };
    }, [placeMode.active, potRenderer, handlePotClick]);

    const handlePlantSeed = async (type: PlantType) => {
        if (!plantSystem || !itemManager || !selectedPotId || !gardenManager) return;
        const pot = gardenManager.getSnapshot().pots.find(p => p.id === selectedPotId);
        if (!pot) return;

        const ok = await itemManager.consumeSeed(type);
        if (!ok) {
            alert(`没有${PLANT_CONFIGS[type].name}种子了！`);
            return;
        }
        // 先关闭面板，避免主角走动期间面板还浮在原地
        setShowSeedPanel(false);
        setSelectedPotId(null);
        setPanelAnchor(null);

        const behavior = userAvatar?.behavior;
        if (behavior) {
            // 走到花盆旁边再种植（偏移 50px，从主人当前位置决定站哪侧）
            const snap = gardenManager.getSnapshot();
            const offset = 50;
            const rawTarget = snap.avatar.x < pot.x ? pot.x - offset : pot.x + offset;
            const targetX = Math.max(40, Math.min(window.innerWidth - 40, rawTarget));
            behavior.walkToTarget(targetX, () => {
                void behavior.setActivity('planting', 'focused', 3000);
                void plantSystem.plantSeed(type, pot.id, 'self').then(() =>
                    setRefreshKey(k => k + 1),
                );
            });
        } else {
            // avatar 未加载，直接执行
            await plantSystem.plantSeed(type, pot.id, 'self');
            setRefreshKey(k => k + 1);
        }
    };

    // 获取种子库存（用于种植面板）
    const seedInventory = itemManager?.getSeeds() ?? [];

    // 调试：清空所有数据
    const handleClearAll = async () => {
        if (!gardenManager) return;
        if (!confirm('清空所有花园数据（植物/花盆/收集）？此操作不可撤销！')) return;
        await gardenManager.clearAll();
        // 重新加载页面以重置渲染
        window.location.reload();
    };

    // 调试：添加测试种子
    const handleAddTestSeeds = async () => {
        if (!gardenManager) {
            alert('花园管理器未初始化！');
            return;
        }
        const types: PlantType[] = ['sunflower', 'daisy', 'lavender', 'mimosa', 'cactus'];
        for (const t of types) {
            try {
                await gardenManager.addCollectionItem('seed', t, 'visitor', '测试种子', 3);
            } catch (e) {
                console.error('[GardenToolbar] Failed to add seed:', t, e);
            }
        }
        setRefreshKey(k => k + 1);
    };

    return (
        <>
            {/* 放置模式全屏 Overlay：捕获点击，pointerEvents:auto 确保浏览器+桌面模式都能收到 */}
            {placeMode.active && (
                <div
                    data-place-overlay
                    onClick={(e) => {
                        if (!potRenderer) return;
                        void potRenderer.addPotAt(e.clientX, e.clientY, placeMode.style);
                        setPlaceMode({ active: false, style: 'clay' });
                    }}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        setPlaceMode({ active: false, style: 'clay' });
                    }}
                    style={{
                        position: 'fixed',
                        top: 0,
                        left: 0,
                        width: '100%',
                        height: '100%',
                        zIndex: 999,
                        cursor: 'crosshair',
                        background: 'rgba(0,0,0,0.05)',
                        pointerEvents: 'auto',
                    }}
                />
            )}

            {/* 底部工具栏 */}
            <div data-garden-toolbar style={{
                position: 'fixed',
                bottom: 72,
                left: '50%',
                transform: 'translateX(-50%)',
                display: 'flex',
                gap: 8,
                padding: '8px 12px',
                background: 'rgba(255,255,255,0.92)',
                color: '#333',
                borderRadius: 12,
                boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
                zIndex: 1000,
                pointerEvents: 'auto',
            }}>
                <button
                    onClick={() => setPlaceMode({ active: true, style: 'clay' })}
                    disabled={placeMode.active}
                    style={btnStyle(placeMode.active)}
                    title="点击后在桌面任意位置放置花盆"
                >
                    {placeMode.active ? '点击桌面放置花盆...' : '🪣 添加花盆'}
                </button>
                <button
                    onClick={handleAddTestSeeds}
                    style={btnStyle(false)}
                    title="添加 5 种植物种子各 3 颗（调试用）"
                >
                    🌱 测试种子
                </button>
                <button
                    onClick={handleClearAll}
                    style={btnStyle(false)}
                    title="清空所有花园数据"
                >
                    🗑️ 清空
                </button>
            </div>

            {/* 种植面板（定位到花盆上方） */}
            {showSeedPanel && (() => {
                const PANEL_W = 320;
                const PANEL_GAP = 12; // 面板与花盆的间距
                const anchor = panelAnchor ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
                // 水平：居中于花盆，clamp 到视口内
                const left = Math.max(PANEL_W / 2 + 8, Math.min(window.innerWidth - PANEL_W / 2 - 8, anchor.x));
                // 垂直：优先在花盆上方显示；若太靠顶则改到下方
                const aboveY = anchor.y - PANEL_GAP;
                const showBelow = aboveY < 220; // 上方空间不足时显示在下方
                const top = showBelow ? anchor.y + PANEL_GAP + 40 : aboveY;
                const transform = showBelow
                    ? 'translate(-50%, 0)'
                    : 'translate(-50%, -100%)';
                return (
                    <div data-planting-panel style={{
                        position: 'fixed',
                        top,
                        left,
                        transform,
                        background: 'rgba(255,255,255,0.98)',
                        color: '#333',
                        borderRadius: 16,
                        padding: 20,
                        boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                        zIndex: 1001,
                        minWidth: PANEL_W,
                    }}>
                        <h3 style={{ margin: '0 0 16px', fontSize: 18 }}>选择种子种植</h3>
                        {seedInventory.length === 0 ? (
                            <p style={{ color: '#888' }}>暂无种子。点击"测试种子"按钮添加。</p>
                        ) : (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
                                {seedInventory.map(seed => {
                                    const config = PLANT_CONFIGS[seed.subType as PlantType];
                                    if (!config) return null;
                                    return (
                                        <button
                                            key={seed.subType}
                                            onClick={() => handlePlantSeed(seed.subType as PlantType)}
                                            style={{
                                                padding: '12px 8px',
                                                border: '1px solid #e0e0e0',
                                                borderRadius: 8,
                                                background: '#fafafa',
                                                color: '#333',
                                                cursor: 'pointer',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                alignItems: 'center',
                                                gap: 4,
                                            }}
                                        >
                                            <span style={{ fontSize: 28 }}>{config.stages.blooming.emoji}</span>
                                            <span style={{ fontSize: 13 }}>{config.name}</span>
                                            <span style={{ fontSize: 11, color: '#888' }}>×{seed.count}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                        <button
                            onClick={() => { setShowSeedPanel(false); setSelectedPotId(null); setPanelAnchor(null); }}
                            style={{ ...btnStyle(false), marginTop: 12, width: '100%' }}
                        >
                            取消
                        </button>
                    </div>
                );
            })()}

            {/* 隐藏的 refreshKey 触发器（强制 re-render） */}
            <span style={{ display: 'none' }} data-refresh={refreshKey} />
        </>
    );
};

function btnStyle(disabled: boolean): React.CSSProperties {
    return {
        padding: '6px 14px',
        border: '1px solid #d0d0d0',
        borderRadius: 8,
        background: disabled ? '#e0e0e0' : '#fff',
        color: '#333',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 13,
        opacity: disabled ? 0.6 : 1,
    };
}
