import React, { useEffect, useRef, useState, createContext, useContext } from 'react';
import * as PIXI from 'pixi.js';
import { useUnderlayDesktop } from '@underlay/desktop/UnderlayDesktopContext';
import { listen } from '@tauri-apps/api/event';
import { GroundSystem } from './landscape/GroundSystem';
import { GrassSystem } from './landscape/GrassSystem';
import { FlowerSystem } from './landscape/FlowerSystem';
import { SkySystem } from './landscape/SkySystem';
import { VineSystem } from './landscape/VineSystem';
import { PhysicsSystem } from '../lib/physics/PhysicsSystem';
import { PlatformManager } from '../lib/physics/PlatformManager';
import { UserAvatar } from '../lib/avatar/UserAvatar';
import { GardenManager, getGardenManager } from '../lib/world/GardenManager';
import { PlantSystem } from '../lib/world/PlantSystem';
import { PlantRenderer } from '../lib/world/PlantRenderer';
import { VisitorManager } from '../lib/world/VisitorManager';
import { storage } from '../lib/storage';
import { getBaseUrl } from '../lib/config';

interface GardenContextType {
    app: PIXI.Application | null;
    physicsSystem: PhysicsSystem | null;
    platformManager: PlatformManager | null;
    userAvatar: UserAvatar | null;
    gardenManager: GardenManager | null;
    plantSystem: PlantSystem | null;
    visitorManager: VisitorManager | null;
    season: 'spring' | 'summer' | 'autumn' | 'winter';
    setSeason: (season: 'spring' | 'summer' | 'autumn' | 'winter') => void;
    weather: 'sunny' | 'rainy' | 'snowy';
    setWeather: (weather: 'sunny' | 'rainy' | 'snowy') => void;
}

const GardenContext = createContext<GardenContextType | undefined>(undefined);

export const useGarden = () => {
    const context = useContext(GardenContext);
    if (!context) {
        throw new Error('useGarden must be used within a MicroGardenLayer');
    }
    return context;
};

export const MicroGardenLayer: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const appRef = useRef<PIXI.Application | null>(null);

    // Landscape System Refs
    const vineSystemRef = useRef<VineSystem | null>(null);
    const grassSystemRef = useRef<GrassSystem | null>(null);
    const flowerSystemRef = useRef<FlowerSystem | null>(null);
    const groundSystemRef = useRef<GroundSystem | null>(null);
    const skySystemRef = useRef<SkySystem | null>(null);

    // Physics Refs
    const physicsSystemRef = useRef<PhysicsSystem | null>(null);
    const platformManagerRef = useRef<PlatformManager | null>(null);

    // Avatar Ref
    const userAvatarRef = useRef<UserAvatar | null>(null);

    // Garden Manager Ref (local-first world state)
    const gardenManagerRef = useRef<GardenManager | null>(null);

    // Plant System Refs
    const plantSystemRef = useRef<PlantSystem | null>(null);
    const plantRendererRef = useRef<PlantRenderer | null>(null);

    // Visitor Manager Ref
    const visitorManagerRef = useRef<VisitorManager | null>(null);

    const { gridItems, categories } = useUnderlayDesktop();

    const [app, setApp] = useState<PIXI.Application | null>(null);
    const [physicsSystem, setPhysicsSystem] = useState<PhysicsSystem | null>(null);
    const [platformManager, setPlatformManager] = useState<PlatformManager | null>(null);
    const [userAvatar, setUserAvatar] = useState<UserAvatar | null>(null);
    const [gardenManager, setGardenManager] = useState<GardenManager | null>(null);
    const [plantSystem, setPlantSystem] = useState<PlantSystem | null>(null);
    const [visitorManager, setVisitorManager] = useState<VisitorManager | null>(null);

    const [physicsReady, setPhysicsReady] = useState(false);
    const [season, setSeason] = useState<'spring' | 'summer' | 'autumn' | 'winter'>('summer');
    const [weather, setWeather] = useState<'sunny' | 'rainy' | 'snowy'>('sunny');

    // 初始化：从 storage 异步加载环境配置（替代 localStorage 同步读取）
    useEffect(() => {
        storage.get('ai00.environment').then((raw) => {
            if (!raw) return;
            try {
                const p = JSON.parse(raw);
                if (p.season === 'spring' || p.season === 'summer' || p.season === 'autumn' || p.season === 'winter') {
                    setSeason(p.season);
                }
                if (p.weather === 'sunny' || p.weather === 'rainy' || p.weather === 'snowy') {
                    setWeather(p.weather);
                }
            } catch { }
        }).catch(() => {});
    }, []);

    // Environment event listener
    useEffect(() => {
        const handleEnvUpdate = (payload: any) => {
            const { season: newSeason, weather: newWeather } = payload;
            if (newSeason && (newSeason === 'spring' || newSeason === 'summer' || newSeason === 'autumn' || newSeason === 'winter')) {
                setSeason(newSeason);
            }
            if (newWeather && (newWeather === 'sunny' || newWeather === 'rainy' || newWeather === 'snowy')) {
                setWeather(newWeather);
            }
        };

        const unlisten = listen('change-environment', (event: any) => {
            handleEnvUpdate(event.payload);
        });

        // 监听 KV storage 变更（跨 webview 同步，替代 'storage' 事件）
        let unlistenKv: (() => void) | undefined;
        storage.onChanged((e) => {
            if (e.key === 'ai00.environment' && e.value) {
                try {
                    handleEnvUpdate(JSON.parse(e.value));
                } catch { }
            }
        }).then((fn) => {
            unlistenKv = fn;
        });

        return () => {
            unlisten.then(f => f());
            unlistenKv?.();
        }
    }, []);

    // React to season changes
    useEffect(() => {
        const updateSeason = async () => {
            if (vineSystemRef.current) {
                await vineSystemRef.current.setSeason(season);
                vineSystemRef.current.refresh();
            }
            if (grassSystemRef.current) await grassSystemRef.current.setSeason(season);
            if (flowerSystemRef.current) await flowerSystemRef.current.setSeason(season);
            if (groundSystemRef.current) await groundSystemRef.current.setSeason(season);
        };
        updateSeason();
    }, [season]);

    // React to weather changes
    useEffect(() => {
        if (skySystemRef.current) {
            skySystemRef.current.setWeather(weather);
        }
    }, [weather]);

    // Main PIXI initialization
    useEffect(() => {
        if (!containerRef.current) return;
        const app = new PIXI.Application();
        let mounted = true;
        (async () => {
            await app.init({
                resizeTo: window,
                backgroundAlpha: 0,
                resolution: window.devicePixelRatio || 1,
                autoDensity: true,
            });
            if (!mounted) return;
            containerRef.current?.appendChild(app.canvas);
            app.canvas.style.position = 'absolute';
            app.canvas.style.top = '0';
            app.canvas.style.left = '0';
            app.canvas.style.pointerEvents = 'none';
            appRef.current = app;
            setApp(app);

            // --- LANDSCAPE SYSTEMS ---
            const groundSystem = new GroundSystem();
            await groundSystem.setup(app);
            groundSystemRef.current = groundSystem;

            const grassSystem = new GrassSystem(groundSystem);
            await grassSystem.setup(app);
            grassSystemRef.current = grassSystem;

            const flowerSystem = new FlowerSystem(groundSystem);
            await flowerSystem.setup(app);
            flowerSystemRef.current = flowerSystem;

            const skySystem = new SkySystem();
            skySystem.setGroundSystem(groundSystem);
            await skySystem.setup(app);
            skySystemRef.current = skySystem;

            const vineSystem = new VineSystem();
            await vineSystem.setup(app);
            vineSystemRef.current = vineSystem;

            // Initial season and weather
            vineSystem.setSeason(season);
            grassSystem.setSeason(season);
            flowerSystem.setSeason(season);
            groundSystem.setSeason(season);
            skySystem.setWeather(weather);

            app.stage.sortableChildren = true;

            // --- PHYSICS SYSTEM ---
            const physics = new PhysicsSystem();
            physicsSystemRef.current = physics;
            setPhysicsSystem(physics);

            const platformMgr = new PlatformManager(physics);
            platformManagerRef.current = platformMgr;
            setPlatformManager(platformMgr);
            setPhysicsReady(true);

            // --- GARDEN MANAGER (local-first world state) ---
            // 即使 IndexedDB 失败也不阻断 avatar 加载，降级为无持久化
            let gardenMgr: GardenManager | null = null;
            try {
                gardenMgr = getGardenManager();
                await gardenMgr.init();
                gardenManagerRef.current = gardenMgr;
                setGardenManager(gardenMgr);
            } catch (e) {
                console.warn('[MicroGardenLayer] GardenManager init failed, continue without persistence:', e);
                gardenMgr = null;
            }

            // --- PLANT SYSTEM + RENDERER ---
            if (gardenMgr) {
                try {
                    const pSystem = new PlantSystem(gardenMgr);
                    pSystem.start();
                    plantSystemRef.current = pSystem;
                    setPlantSystem(pSystem);

                    const pRenderer = new PlantRenderer(app, gardenMgr);
                    pRenderer.start();
                    plantRendererRef.current = pRenderer;
                } catch (e) {
                    console.warn('[MicroGardenLayer] PlantSystem init failed:', e);
                }
            }

            // --- VISITOR MANAGER (NPC 访客轮询) ---
            if (gardenMgr) {
                try {
                    const vMgr = new VisitorManager(
                        app,
                        gardenMgr,
                        () => physicsSystemRef.current?.getGroundTopScreenY() ?? window.innerHeight - 100,
                    );
                    vMgr.start();
                    visitorManagerRef.current = vMgr;
                    setVisitorManager(vMgr);
                } catch (e) {
                    console.warn('[MicroGardenLayer] VisitorManager init failed:', e);
                }
            }

            // Sync ground terrain to physics
            const updatePhysicsGround = () => {
                const screenW = app.screen.width;
                const physicsPoints: { x: number, y: number }[] = [];
                const step = 5;
                const groundPhysicsPoints = groundSystem.physicsPoints;

                for (let x = 0; x <= screenW + step; x += step) {
                    const xTexture = x % GroundSystem.STRIP_WIDTH;
                    let yTexture = 25;
                    for (let j = 0; j < groundPhysicsPoints.length - 1; j++) {
                        if (xTexture >= groundPhysicsPoints[j].x && xTexture <= groundPhysicsPoints[j + 1].x) {
                            const p0 = groundPhysicsPoints[j];
                            const p1 = groundPhysicsPoints[j + 1];
                            const t = (xTexture - p0.x) / (p1.x - p0.x);
                            yTexture = p0.y + (p1.y - p0.y) * t;
                            break;
                        }
                    }
                    physicsPoints.push({
                        x: x,
                        y: groundSystem.getGroundY(app.screen.height) + yTexture
                    });
                }
                physics.updateGroundTerrain(physicsPoints);
            };
            updatePhysicsGround();

            // Animation loop
            let time = 0;
            app.ticker.add((ticker) => {
                time += ticker.deltaTime * 0.05;
                physics.update(ticker.deltaTime);
                grassSystem.update(time, app);
                flowerSystem.update(time);
                vineSystem.update(time);
                skySystem.update(app, ticker, time);
                gardenMgr?.update(ticker.deltaMS);
                plantSystemRef.current?.update();
                plantRendererRef.current?.update();
                visitorManagerRef.current?.update();
            });

            // Resize handler
            app.renderer.on('resize', () => {
                groundSystem.resize(app.screen.width, app.screen.height);
                grassSystem.resize(app.screen.width, app.screen.height);
                flowerSystem.resize(app);
                updatePhysicsGround();
            });

            // --- USER AVATAR ---
            try {
                // 测试：改回绝对 URL
                const baseUrl = `${await getBaseUrl()}/pet`;
                const avatar = new UserAvatar(app, baseUrl, physics, gardenMgr ?? undefined);
                await avatar.load();
                userAvatarRef.current = avatar;
                setUserAvatar(avatar);
                // DEBUG: 暴露到 window 便于诊断
                (window as any).__app = app;
                (window as any).__avatar = avatar;
            } catch (error) {
                console.error('[MicroGardenLayer] Failed to load user avatar:', error);
            }
        })();
        return () => {
            mounted = false;
            visitorManagerRef.current?.stop();
            visitorManagerRef.current = null;
            plantRendererRef.current?.stop();
            plantRendererRef.current = null;
            plantSystemRef.current?.stop();
            plantSystemRef.current = null;
            gardenManagerRef.current?.destroy();
            gardenManagerRef.current = null;
            appRef.current?.destroy(true);
        };
    }, []);

    // Sync platforms from desktop grid
    useEffect(() => {
        if (!platformManagerRef.current) return;
        const CELL_PX = 64;
        const TASKBAR_OFFSET = 60;
        const TOP_OFFSET = 60;
        const cols = Math.max(1, Math.floor(window.innerWidth / CELL_PX));
        const rows = Math.max(1, Math.floor((window.innerHeight - TASKBAR_OFFSET - TOP_OFFSET) / CELL_PX));
        platformManagerRef.current.setGridDimensions(cols, rows);
        platformManagerRef.current.setOffsets(0, 0, TASKBAR_OFFSET + 30);
        platformManagerRef.current.setFixedCellHeight(CELL_PX);
        platformManagerRef.current.setInset(6, 6, 4);
        platformManagerRef.current.updatePlatforms(gridItems, categories);

        if (vineSystemRef.current) {
            vineSystemRef.current.updatePlatforms(platformManagerRef.current.getPlatforms());
        }
        if (skySystemRef.current) {
            skySystemRef.current.updatePlatforms(platformManagerRef.current.getPlatforms());
        }
    }, [gridItems, categories, physicsReady]);

    return (
        <GardenContext.Provider value={{ app, physicsSystem, platformManager, userAvatar, gardenManager, plantSystem, visitorManager, season, setSeason, weather, setWeather }}>
            {children}
            <div
                ref={containerRef}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: '100%',
                    zIndex: 10,
                    pointerEvents: 'none',
                }}
            />
        </GardenContext.Provider>
    );
};
