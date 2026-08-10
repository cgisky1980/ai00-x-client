import * as PIXI from 'pixi.js';
import { Platform } from '../../lib/physics/PhysicsSystem';
import { GroundSystem } from './GroundSystem';

// --- CLOUD RENDERING START ---
const generateCloudSvg = () => {
    const width = 200;
    const height = 120;
    const viewBoxPadding = 40; // Extra padding to prevent clipping
    const totalW = width + viewBoxPadding * 2;
    const totalH = height + viewBoxPadding * 2;
    
    let circles = '';
    const numBlobs = 6 + Math.floor(Math.random() * 5); // 6-10 blobs
    
    // Main body - composed of several overlapping circles
    // Center cluster
    const cx = totalW / 2;
    const cy = totalH / 2;
    
    // Base cloud width/height variance
    const spreadX = 60 + Math.random() * 40;
    const spreadY = 20 + Math.random() * 20;
    
    for (let i = 0; i < numBlobs; i++) {
        // Random position within spread
        const x = cx + (Math.random() * spreadX - spreadX/2);
        const y = cy + (Math.random() * spreadY - spreadY/2);
        
        // Radius varies
        const r = 25 + Math.random() * 20;
        
        circles += `<circle cx='${x}' cy='${y}' r='${r}' />`;
    }
    
    // Add a flattened bottom? Or just more puffs at bottom?
    // User wanted "better shapes", usually means fluffy but maybe with a hint of flat bottom.
    // Let's add a few smaller puffs on top to make it look detailed.
    
    return encodeURIComponent(`
        <svg xmlns='http://www.w3.org/2000/svg' width='${totalW}' height='${totalH}' viewBox='0 0 ${totalW} ${totalH}'>
            <g fill='white'>
                ${circles}
            </g>
        </svg>
    `.trim().replace(/\n/g, '').replace(/\s+/g, ' '));
};

// Generate a set of cloud shapes
const cloudShapes = Array(20).fill(0).map(() => generateCloudSvg());

// --- BIRD RENDERING START ---
// Frame 1: Wings Up
const birdSvgFrame1 = encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='40' height='24' viewBox='0 0 40 24'>
    <!-- Body -->
    <path d='M2,12 Q8,8 18,10 L32,13 L36,15 L32,17 L18,16 Q8,20 2,12 Z' fill='black'/>
    <!-- Wing Up -->
    <path d='M14,11 L24,2 L28,5 L18,12 Z' fill='black'/>
</svg>`);

// Frame 2: Wings Down
const birdSvgFrame2 = encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='40' height='24' viewBox='0 0 40 24'>
    <!-- Body -->
    <path d='M2,12 Q8,8 18,10 L32,13 L36,15 L32,17 L18,16 Q8,20 2,12 Z' fill='black'/>
    <!-- Wing Down -->
    <path d='M14,13 L24,22 L28,19 L18,12 Z' fill='black'/>
</svg>`);

interface CloudInstance {
    sprite: PIXI.Sprite;
    speed: number;
}

interface BirdInstance {
    sprite: PIXI.Sprite;
    speed: number;
    flapTimer: number;
    flapState: number; // 0 or 1
    direction: number; // 1: Right, -1: Left
    initialY: number;
    flightPhase: number;
    bobSpeed: number;
    bobAmount: number;
}

export class SkySystem {
    public cloudContainer: PIXI.Container;
    public birdContainer: PIXI.Container;
    
    private clouds: CloudInstance[] = [];
    private birds: BirdInstance[] = [];
    
    private cloudTextures: PIXI.Texture[] = [];
    private birdTexture1: PIXI.Texture | null = null;
    private birdTexture2: PIXI.Texture | null = null;
    
    private cloudDirection: number = 1;
    
    private weather: 'sunny' | 'rainy' | 'snowy' = 'sunny';
    private weatherContainer: PIXI.Container;
    private rainDrops: PIXI.Graphics[] = [];
    private snowFlakes: PIXI.Graphics[] = [];
    private platforms: Platform[] = [];
    private groundSystem: GroundSystem | null = null;
    
    constructor() {
        this.cloudContainer = new PIXI.Container();
        this.cloudContainer.zIndex = -20;
        
        this.birdContainer = new PIXI.Container();
        this.birdContainer.zIndex = -18;
        
        this.weatherContainer = new PIXI.Container();
        this.weatherContainer.zIndex = 20; // In front of everything usually, or maybe behind pets?
        // Pets are usually zIndex 10+. Rain should probably be in front of landscape (5) but behind UI/Pets?
        // Actually rain usually falls *in front* of background elements but maybe behind the pets so they don't look weirdly overlayed?
        // Let's put it at zIndex 6 (in front of grass/vines) for now.
        this.weatherContainer.zIndex = 6;

        this.cloudDirection = Math.random() > 0.5 ? 1 : -1;
    }

    public async setup(app: PIXI.Application) {
        this.cloudTextures = await Promise.all(cloudShapes.map(svg => PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${svg}`)));
        this.birdTexture1 = await PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${birdSvgFrame1}`);
        this.birdTexture2 = await PIXI.Assets.load(`data:image/svg+xml;charset=utf-8,${birdSvgFrame2}`);

        app.stage.addChild(this.cloudContainer);
        app.stage.addChild(this.birdContainer);
        app.stage.addChild(this.weatherContainer);

        // Initial clouds
        for (let i = 0; i < 4; i++) {
            this.spawnCloud(app, Math.random() * app.screen.width);
        }
    }

    public updatePlatforms(platforms: Platform[]) {
        this.platforms = platforms;
    }

    public setGroundSystem(groundSystem: GroundSystem) {
        this.groundSystem = groundSystem;
    }

    public setWeather(weather: 'sunny' | 'rainy' | 'snowy') {
        if (this.weather === weather) return;
        this.weather = weather;
        
        // Clear existing weather particles
        this.weatherContainer.removeChildren().forEach(child => child.destroy());
        this.rainDrops = [];
        this.snowFlakes = [];

        // Update clouds tint
        const cloudColor = weather === 'rainy' ? 0x888888 : 0xffffff;
        for (const cloud of this.clouds) {
            cloud.sprite.tint = cloudColor;
        }
    }

    private spawnRain(app: PIXI.Application) {
        const drop = new PIXI.Graphics();
        drop.rect(0, 0, 2, 15);
        drop.fill({ color: 0xaaccff, alpha: 0.6 });
        drop.x = Math.random() * app.screen.width;
        drop.y = -20;
        this.weatherContainer.addChild(drop);
        this.rainDrops.push(drop);
    }

    private spawnSnow(app: PIXI.Application) {
        const flake = new PIXI.Graphics();
        flake.circle(0, 0, 2 + Math.random() * 2);
        flake.fill({ color: 0xffffff, alpha: 0.8 });
        flake.x = Math.random() * app.screen.width;
        flake.y = -10;
        this.weatherContainer.addChild(flake);
        this.snowFlakes.push(flake);
    }

    private spawnCloud(app: PIXI.Application, x?: number) {
        const texture = this.cloudTextures[Math.floor(Math.random() * this.cloudTextures.length)];
        const sprite = new PIXI.Sprite(texture);
        
        // Random scale
        const scale = 0.8 + Math.random() * 0.6;
        sprite.scale.set(scale);
        
        // Position
        const minY = app.screen.height - 470;
        const maxY = app.screen.height - 270;
        sprite.y = minY + Math.random() * (maxY - minY);
        
        // Start position: if x provided use it
        if (x !== undefined) {
            sprite.x = x;
        } else {
            // Start off-screen based on direction
            if (this.cloudDirection === 1) { // Moving Right
                sprite.x = -150;
            } else { // Moving Left
                sprite.x = app.screen.width + 50;
            }
        }
        
        // Alpha random
        sprite.alpha = 0.6 + Math.random() * 0.4;
        
        // Apply tint if rainy
        if (this.weather === 'rainy') {
            sprite.tint = 0x888888;
        } else {
            sprite.tint = 0xffffff;
        }

        this.cloudContainer.addChild(sprite);
        
        this.clouds.push({
            sprite,
            speed: 0.2 + Math.random() * 0.3 // Slow movement
        });
    }

    private spawnBird(app: PIXI.Application) {
        if (!this.birdTexture1) return;
        
        const sprite = new PIXI.Sprite(this.birdTexture1);
        
        // Scale: small silhouettes
        const scale = 0.5 + Math.random() * 0.5;
        sprite.anchor.set(0.5);

        // Position: Around cloud height
        const minY = app.screen.height - 520;
        const maxY = app.screen.height - 220;
        const startY = minY + Math.random() * (maxY - minY);
        sprite.y = startY;
        
        // Random Direction per bird (or group)
        const direction = Math.random() > 0.5 ? 1 : -1; 

        if (direction === 1) { // Fly Right
            sprite.x = -50; // Start Left
            sprite.scale.set(-scale, scale); // Flip X
        } else { // Fly Left
            sprite.x = app.screen.width + 50; // Start Right
            sprite.scale.set(scale, scale); // Normal
        }
        
        sprite.alpha = 0.8 + Math.random() * 0.2;

        this.birdContainer.addChild(sprite);
        
        this.birds.push({
            sprite,
            speed: 2 + Math.random() * 2,
            flapTimer: 0,
            flapState: 0,
            direction,
            initialY: startY,
            flightPhase: Math.random() * Math.PI * 2,
            bobSpeed: 0.05 + Math.random() * 0.05,
            bobAmount: 10 + Math.random() * 15
        });
    }

    public update(app: PIXI.Application, ticker: PIXI.Ticker, time: number) {
        // Update clouds
        for (let i = this.clouds.length - 1; i >= 0; i--) {
            const cloud = this.clouds[i];
            
            // Move based on direction
            if (this.cloudDirection === 1) {
                    cloud.sprite.x += cloud.speed * ticker.deltaTime * 2; 
            } else {
                    cloud.sprite.x -= cloud.speed * ticker.deltaTime * 2; 
            }
            
            // Remove if off screen
            if (this.cloudDirection === 1) {
                if (cloud.sprite.x > app.screen.width + 150) {
                    this.cloudContainer.removeChild(cloud.sprite);
                    this.clouds.splice(i, 1);
                }
            } else {
                if (cloud.sprite.x < -150) {
                    this.cloudContainer.removeChild(cloud.sprite);
                    this.clouds.splice(i, 1);
                }
            }
        }
        
        // Spawn new clouds
        if (this.clouds.length < 5 && Math.random() < 0.005) {
            this.spawnCloud(app);
        }

        // Update birds
        for (let i = this.birds.length - 1; i >= 0; i--) {
            const bird = this.birds[i];
            
            // Move X
            if (bird.direction === 1) {
                    bird.sprite.x += bird.speed * ticker.deltaTime; 
            } else {
                    bird.sprite.x -= bird.speed * ticker.deltaTime; 
            }

            // Move Y (Undulation)
            bird.flightPhase += bird.bobSpeed * ticker.deltaTime;
            bird.sprite.y = bird.initialY + Math.sin(bird.flightPhase) * bird.bobAmount;

            // Flap Wings
            bird.flapTimer += ticker.deltaTime;
            if (bird.flapTimer > 10) { // Flap every 10 ticks (approx 160ms)
                bird.flapTimer = 0;
                bird.flapState = bird.flapState === 0 ? 1 : 0;
                bird.sprite.texture = bird.flapState === 0 ? (this.birdTexture1!) : (this.birdTexture2!);
            }

            // Remove if off screen
             if (bird.direction === 1) {
                if (bird.sprite.x > app.screen.width + 50) {
                    this.birdContainer.removeChild(bird.sprite);
                    this.birds.splice(i, 1);
                }
            } else {
                if (bird.sprite.x < -50) {
                    this.birdContainer.removeChild(bird.sprite);
                    this.birds.splice(i, 1);
                }
            }
        }

        // Spawn birds
        // I need to add spawn logic if it was missing or implied
        if (this.birds.length < 3 && Math.random() < 0.005) {
             this.spawnBird(app);
        }

        // Weather Updates
        if (this.weather === 'rainy') {
            // Spawn rain
            // Increase density: spawn more frequently
            if (Math.random() < 0.8) { 
                this.spawnRain(app);
                if (Math.random() < 0.4) this.spawnRain(app); // Double spawn chance
            }
            
            // Ground Y reference
            const groundBaseY = this.groundSystem ? this.groundSystem.getGroundY(app.screen.height) : app.screen.height;
            const groundPoints = this.groundSystem ? this.groundSystem.physicsPoints : [];

            // Update rain
            for (let i = this.rainDrops.length - 1; i >= 0; i--) {
                const drop = this.rainDrops[i];
                drop.y += 15 * ticker.deltaTime; // Fast fall
                drop.x -= 2 * ticker.deltaTime; // Slight wind
                
                // Collision Check
                let hit = false;
                const dropX = drop.x;
                const dropY = drop.y + 15; // Tip of drop
                
                // 1. Platform Collision
                for (const p of this.platforms) {
                    // Platform: x is center, y is top
                    const halfW = p.width / 2;
                    // Check if drop is within platform horizontal bounds
                    if (dropX >= p.x - halfW && dropX <= p.x + halfW) {
                         // Check vertical: if it hit the top surface (with some tolerance for speed)
                         // Since drop moves 15px/frame approx, we check if it's within range
                         if (dropY >= p.y && dropY <= p.y + p.height) {
                             hit = true;
                             break;
                         }
                    }
                }

                // 2. Ground Collision
                if (!hit && this.groundSystem && groundPoints.length > 1) {
                    const tx = (dropX % GroundSystem.STRIP_WIDTH + GroundSystem.STRIP_WIDTH) % GroundSystem.STRIP_WIDTH;
                    // Linear search/interpolation for ground Y at this X
                    // Optimization: Since points are sorted by X (roughly), we could binary search but linear is okay for small N?
                    // physicsPoints count depends on width. STRIP_WIDTH is 4096. 
                    // Actually, geometry points are generated per segment. 
                    // Let's iterate. 
                    for (let j = 0; j < groundPoints.length - 1; j++) {
                        if (tx >= groundPoints[j].x && tx <= groundPoints[j+1].x) {
                             const p0 = groundPoints[j];
                             const p1 = groundPoints[j+1];
                             const t = (tx - p0.x) / (p1.x - p0.x);
                             const localY = p0.y + (p1.y - p0.y) * t;
                             const groundY = groundBaseY + localY;
                             
                             if (dropY >= groundY) {
                                 hit = true;
                             }
                             break;
                        }
                    }
                }

                if (hit || drop.y > app.screen.height) {
                    this.weatherContainer.removeChild(drop);
                    drop.destroy();
                    this.rainDrops.splice(i, 1);
                }
            }
        } else if (this.weather === 'snowy') {
             // Spawn snow
             if (Math.random() < 0.15) { // Slightly more snow too
                this.spawnSnow(app);
            }
            
            // Ground Y reference
            const groundBaseY = this.groundSystem ? this.groundSystem.getGroundY(app.screen.height) : app.screen.height;
            const groundPoints = this.groundSystem ? this.groundSystem.physicsPoints : [];

            // Update snow
            for (let i = this.snowFlakes.length - 1; i >= 0; i--) {
                const flake = this.snowFlakes[i];
                flake.y += 2 * ticker.deltaTime; // Slow fall
                flake.x += Math.sin(time * 0.05 + flake.y * 0.01) * 0.5 * ticker.deltaTime; // Sway
                
                // Collision Check
                let hit = false;
                const flakeX = flake.x;
                const flakeY = flake.y;

                // 1. Platform Collision
                for (const p of this.platforms) {
                    const halfW = p.width / 2;
                    if (flakeX >= p.x - halfW && flakeX <= p.x + halfW) {
                         if (flakeY >= p.y && flakeY <= p.y + p.height) {
                             hit = true;
                             break;
                         }
                    }
                }

                // 2. Ground Collision
                if (!hit && this.groundSystem && groundPoints.length > 1) {
                    const tx = (flakeX % GroundSystem.STRIP_WIDTH + GroundSystem.STRIP_WIDTH) % GroundSystem.STRIP_WIDTH;
                    for (let j = 0; j < groundPoints.length - 1; j++) {
                        if (tx >= groundPoints[j].x && tx <= groundPoints[j+1].x) {
                             const p0 = groundPoints[j];
                             const p1 = groundPoints[j+1];
                             const t = (tx - p0.x) / (p1.x - p0.x);
                             const localY = p0.y + (p1.y - p0.y) * t;
                             const groundY = groundBaseY + localY;
                             
                             if (flakeY >= groundY) {
                                 hit = true;
                             }
                             break;
                        }
                    }
                }

                if (hit || flake.y > app.screen.height) {
                    this.weatherContainer.removeChild(flake);
                    flake.destroy();
                    this.snowFlakes.splice(i, 1);
                }
            }
        }
    }
}
