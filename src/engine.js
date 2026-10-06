import {beginTouchFlight,showTouchControls,isTouchControlActive,touchController,resetTouchControls} from './touchControls.js';
import { configureHudGlare } from './hudGlare.js';
import { GRAPHICS_LEVELS, GraphicsBudget } from './graphicsBudget.js';
import * as THREE from 'three';

// Use radial fog distance: view-space Z leaves the edges of a wide FPV image
// clearer than its centre at the same actual distance.
THREE.ShaderChunk.fog_vertex = `
#ifdef USE_FOG
    vFogDepth = length(mvPosition.xyz);
#endif
`;


import { initMap, checkCollision, routeRoadNetwork as roadNetwork, MAP, updateMapCulling, setMapGraphicsProfile, getTerrainHeight } from './map.js';
import { GREENERY_CONFIG } from './greenery.js';
import * as physics from './physics.js';
import * as cockpit from './cockpit.js';
import * as hud from './hud.js';
import * as audio from './audio.js';
import * as car from './car.js';
import * as heli from './heli.js';
import * as soldier from './soldier.js';
import * as bomber from './bomber.js';
import * as race from './race.js';
import * as controls from './controls.js';
import * as weather from './weather.js';
import { syncThermalWithBuild } from './weather.js';
import { renderStartMenu, loadParts, consumeRoundConfigChangedFlag, stopMenuDronePreview, initMenuDronePreview, setMenuMusicButtonVisible, startMenuMusic, applyAnalogGrade, getSavedGameMode } from './menu.js';
import { setPanelVisible as setAuthPanelVisible, reportFlightTime, reportFlightTimeBeacon, logFlightStart } from './auth.js';
import { initTabletMap, resetTabletMapView, isTabletMapOpen } from './tabletMap.js';
import * as stats from './stats.js';
import * as replay from './replay.js';
import { createNearFocus } from './nearFocus.js';
import { createTargetContacts } from './groundContact.js';
import { createLocalVegetation, updateVegetationWind } from './localVegetation.js';
import { createRotorWash } from './rotorWash.js';
import { getPickupMesh, isOverWater, isOverGrass, isOverField, isGrassBlocked, getWaterSurfaceHeight, getGroundColor } from './map.js';

const graphicsBudget = new GraphicsBudget();
let lastGraphicsFrameTime = null;
const graphicsVelocity = { x: 0, z: 0 };
function graphicsProfile() { return graphicsBudget.profile || GRAPHICS_LEVELS[GRAPHICS_LEVELS.length - 1]; }

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x87CEEB, 0.00025);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 8000);
const renderer = new THREE.WebGLRenderer({ stencil:true, canvas: document.getElementById('threeCanvas') });
configureHudGlare(renderer);
const nearFocus = createNearFocus(renderer);
let targetContacts = null;
let rotorWash = null;
let localVegetation = null;

function updateGroundEffects(dt, replaying = false) {
    if (MAP.indoor || !targetContacts || !rotorWash) return;
    const mode = physics.state.droneStats.gameMode;
    const targets = [{ id: 'pickup', mesh: getPickupMesh(), width: 2.5, length: 5.2 }];
    if (mode === 1) targets.push({ id: 'car', mesh: car.getCarTarget()?.active ? car.getCarTarget().mesh : null, width: 2.3, length: 4.4 });
    if (mode === 2) targets.push({ id: 'tank', mesh: bomber.getTankMesh(), width: 3.8, length: 6.8 });
    if (mode === 5) targets.push({ id: 'soldier', mesh: soldier.getSoldierTarget()?.active ? soldier.getSoldierTarget().mesh : null, width: 0.9, length: 1.1 });
    const wx = weather.weather;
    const thermal = wx.thermalEnabled && !controls.isPilotView();
    updateVegetationWind(dt, wx.windEnabled, wx.windDirectionDeg || 0, MAP.UNIT_TO_METERS);
    localVegetation?.update(dt, camera, physics.state.droneBody, {
        throttle: physics.state.motorThrottle, armed: physics.state.armed,
        crashed: physics.state.isCrashed, thermal, replay: replaying,
    });
    targetContacts.update(targets, !thermal);
    rotorWash.update(dt, camera, physics.state.droneBody, {
        throttle: physics.state.motorThrottle, armed: physics.state.armed,
        crashed: physics.state.isCrashed, rain: wx.rainEnabled, thermal, replay: replaying,
        wind: wx.windEnabled, windDegrees: wx.windDirectionDeg,
    });
}

const THERMAL_RESOLUTION_SCALE = 0.28;

function applyRendererResolution() {
    const w = window.innerWidth, h = window.innerHeight;
    const thermalVis = weather.weather.thermalEnabled && !document.body.classList.contains('fpv-pilot-on');
    if (thermalVis) {
        renderer.setSize(Math.round(w * THERMAL_RESOLUTION_SCALE), Math.round(h * THERMAL_RESOLUTION_SCALE), false);
    } else {
        renderer.setSize(w, h, false);
    }
}

applyRendererResolution();

const ambientLight = new THREE.AmbientLight(0xffffff, 1.4);
scene.add(ambientLight);

// Сонце — єдине джерело тіней (вдень та без дощу керується weather.js)
const light = new THREE.DirectionalLight(0xfff5e6, 1.55);
light.userData.sunOffset = new THREE.Vector3(0.36, 0.91, 0.22).multiplyScalar(800);
light.position.copy(light.userData.sunOffset);
light.castShadow = true;
light.shadow.mapSize.set(1024, 1024);
light.shadow.bias = -0.00015;
light.shadow.normalBias = 0.04;
scene.add(light);

const sunTarget = new THREE.Object3D();
sunTarget.position.set(0, 0, 0);
scene.add(sunTarget);
light.target = sunTarget;

renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

/** Силует коптера зверху: м’які промені, пропи без чіткого кола. */
function makeQuadShadowTexture(blurPx) {
    const s = 256;
    const src = document.createElement('canvas');
    src.width = src.height = s;
    const ctx = src.getContext('2d');
    ctx.translate(s / 2, s / 2);

    const arm = 74, propR = 34;
    for (const a of [45, 135, 225, 315]) {
        const rad = a * Math.PI / 180;
        ctx.save();
        ctx.rotate(rad);
        const armGrad = ctx.createLinearGradient(8, 0, arm + 6, 0);
        armGrad.addColorStop(0, 'rgba(0,0,0,0.55)');
        armGrad.addColorStop(1, 'rgba(0,0,0,0.18)');
        ctx.fillStyle = armGrad;
        ctx.fillRect(8, -4, arm, 8);
        const pg = ctx.createRadialGradient(arm + 6, 0, 2, arm + 6, 0, propR);
        pg.addColorStop(0, 'rgba(0,0,0,0.22)');
        pg.addColorStop(0.45, 'rgba(0,0,0,0.12)');
        pg.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = pg;
        ctx.beginPath();
        ctx.arc(arm + 6, 0, propR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    const body = ctx.createRadialGradient(0, 0, 4, 0, 0, 28);
    body.addColorStop(0, 'rgba(0,0,0,0.55)');
    body.addColorStop(0.7, 'rgba(0,0,0,0.28)');
    body.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, 18, 24, 0, 0, Math.PI * 2);
    ctx.fill();

    const out = document.createElement('canvas');
    out.width = out.height = s;
    const octx = out.getContext('2d');
    octx.filter = `blur(${blurPx}px)`;
    octx.drawImage(src, 0, 0);
    const tex = new THREE.CanvasTexture(out);
    tex.needsUpdate = true;
    return tex;
}

function makeShadowPlane(map, name) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        fog: true,
        alphaTest: 0.02,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    mesh.visible = false;
    mesh.name = name;
    scene.add(mesh);
    return mesh;
}

const droneGroundShadow = makeShadowPlane(makeQuadShadowTexture(5), 'droneGroundShadow');
const droneGroundShadowSoft = makeShadowPlane(makeQuadShadowTexture(22), 'droneGroundShadowSoft');

function updateDroneGroundShadow(droneBody, enabled) {
    if (!enabled || !droneBody) {
        droneGroundShadow.visible = false;
        droneGroundShadowSoft.visible = false;
        return;
    }
    const u = Math.max(MAP.UNIT_TO_METERS || 0.2, 1e-6);
    const p = droneBody.position;
    const groundUnder = getTerrainHeight(p.x, p.z);
    const altM = Math.max(0, (p.y - groundUnder) * u);
    if (altM > 10) {
        droneGroundShadow.visible = false;
        droneGroundShadowSoft.visible = false;
        return;
    }

    const sun = weather.SUN_DIR;
    const sy = Math.max(0.28, sun.y);
    const t = Math.max(0, (p.y - groundUnder) / sy);
    const sx = p.x - sun.x * t;
    const sz = p.z - sun.z * t;
    const gy = getTerrainHeight(sx, sz) + 0.08 / u;

    const yaw = droneBody.rotation.y;
    const stretch = 1 / sy;
    // з 2 м до 10 м: менша, сильніше розмита, зникає
    const lift = Math.max(0, Math.min(1, (altM - 2) / 8));
    const fade = Math.max(0, 1 - lift);
    const sizeNear = 1.7 / u;
    const sizeFar = 0.45 / u;
    const sizeU = sizeNear + (sizeFar - sizeNear) * lift;

    droneGroundShadow.position.set(sx, gy, sz);
    droneGroundShadow.rotation.set(0, yaw, 0);
    droneGroundShadow.scale.set(sizeU * stretch, 1, sizeU);
    droneGroundShadowSoft.position.copy(droneGroundShadow.position);
    droneGroundShadowSoft.rotation.copy(droneGroundShadow.rotation);
    droneGroundShadowSoft.scale.set(sizeU * (1.2 + 0.6 * lift) * stretch, 1, sizeU * (1.2 + 0.6 * lift));

    const baseOp = 0.34 * fade * fade;
    droneGroundShadow.material.opacity = baseOp * (1 - lift) * (1 - lift);
    droneGroundShadowSoft.material.opacity = baseOp * (0.15 + 0.85 * lift) * fade;
    droneGroundShadow.visible = droneGroundShadow.material.opacity > 0.02;
    droneGroundShadowSoft.visible = droneGroundShadowSoft.material.opacity > 0.02;
}

/**
 * Дальність тіней = near-LOD дерев (повний хрест + castShadow).
 * Далі дерева в far-LOD без тіней — немає сенсу тягнути shadow frustum.
 * Викликати після initMap, коли відомий MAP.UNIT_TO_METERS.
 */
function configureShadowFrustum() {
    const u = Math.max(MAP.UNIT_TO_METERS || 0.2, 1e-6);
    const radiusM = graphicsProfile().treeNearM;
    // невеликий запас за межу LOD, щоб край не обрізався
    const spanM = radiusM + ((GREENERY_CONFIG && GREENERY_CONFIG.lodNearHysteresisM) || 50);
    const span = spanM / u;

    light.shadow.camera.near = 10;
    // світло стоїть на sunOffset (~800 юнітів); far має діставати до землі + радіус
    light.shadow.camera.far = Math.max(1400, (spanM + 400) / u);
    light.shadow.camera.left = -span;
    light.shadow.camera.right = span;
    light.shadow.camera.top = span;
    light.shadow.camera.bottom = -span;
    light.shadow.camera.updateProjectionMatrix();
}

function applyGraphicsProfile() {
    const profile = graphicsProfile();
    setMapGraphicsProfile(profile);
    const enabled = !MAP.indoor && profile.shadowSize > 0;
    if (renderer.shadowMap.enabled !== enabled) {
        renderer.shadowMap.enabled = enabled;
        const materials = new Set();
        scene.traverse(object => {
            if (object.material) for (const material of (Array.isArray(object.material) ? object.material : [object.material])) materials.add(material);
        });
        materials.forEach(material => { material.needsUpdate = true; });
    }
    if (enabled && light.shadow.mapSize.x !== profile.shadowSize) {
        light.shadow.map?.dispose(); light.shadow.map = null;
        light.shadow.mapSize.set(profile.shadowSize, profile.shadowSize);
    }
    configureShadowFrustum();
}

// тимчасові значення до initMap
configureShadowFrustum();

weather.initWeather(scene, camera, ambientLight, light);

async function bootstrap() {
    await loadParts();
    await stats.fetchStats();
    await weather.syncThermalWithBuild();
    MAP.maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    await initMap(scene);
    if(MAP.indoor){light.visible=false;ambientLight.intensity=0;scene.fog=null;weather.weather.windEnabled=false;weather.weather.rainEnabled=false;weather.syncThermalVisual();}
    camera.far=6500/Math.max(MAP.UNIT_TO_METERS,1e-6);camera.updateProjectionMatrix();
    const groundEnvironment = { unit: MAP.UNIT_TO_METERS, height: getTerrainHeight, isWater: isOverWater, isGrass: isOverGrass };
    targetContacts = createTargetContacts(scene, groundEnvironment);
    rotorWash = createRotorWash(scene, groundEnvironment);
    localVegetation = createLocalVegetation(scene, {...groundEnvironment, blocked:isGrassBlocked, waterHeight:getWaterSurfaceHeight, groundColor:getGroundColor, isField:isOverField});
    applyGraphicsProfile();
    try { applyAnalogGrade(); } catch (_) {}
    window.addEventListener('fpv-base-service', () => {});
    window.addEventListener('fpv-thermal-changed', (e) => {
        if (graphicsBudget.setThermal(!!(e.detail && e.detail.enabled))) applyGraphicsProfile();
    });
    physics.initPhysics(scene, camera);
    hud.initHUD();
    if(!MAP.indoor)bomber.initBomber(scene);
    race.initRace(scene);
    replay.initReplay(scene, renderer.domElement);
    if (car.setCarViewCamera) car.setCarViewCamera(camera);

    const info = document.getElementById("info");
    controls.initControls(camera, info);
    initTabletMap();

    window.addEventListener('fpv-roads-ready', () => {
        if (physics.state.droneStats.gameMode === 1 && !car.getCarTarget()?.active) {
            car.spawnCarTarget(scene, roadNetwork);
        }
    });

    window.addEventListener('fpv-spawn-car', () => {
        if (physics.state.droneStats.gameMode === 1) car.spawnCarTarget(scene, roadNetwork);
    });

    window.addEventListener('fpv-spawn-heli', () => {
        if (physics.state.droneStats.gameMode === 4) heli.spawnHeliTarget(scene);
    });
    window.addEventListener('fpv-spawn-soldier', () => {
        if (physics.state.droneStats.gameMode === 5) soldier.spawnSoldierTarget(scene);
    });

    window.addEventListener('fpv-mode-0', () => {
        physics.state.droneStats.gameMode = 0;
        physics.state.droneStats.raceState = 'IDLE';
        physics.state.droneStats.destroyedTargets = 0;
        race.hideRaceTrack(scene);
        car.removeCarTarget(scene);
        bomber.hideTank(scene);
        heli.removeHeliTarget(scene);
        soldier.removeSoldierTarget(scene);
    });

    window.addEventListener('fpv-mode-1', () => {
        if(MAP.indoor)return;
        physics.state.droneStats.gameMode = 1;
        physics.state.droneStats.raceState = 'IDLE';
        physics.state.droneStats.destroyedTargets = 0;
        race.hideRaceTrack(scene);
        bomber.hideTank(scene);
        heli.removeHeliTarget(scene);
        soldier.removeSoldierTarget(scene);
        car.spawnCarTarget(scene, roadNetwork);
    });

    window.addEventListener('fpv-toggle-daynight', () => weather.toggleDayNight());
    window.addEventListener('fpv-toggle-wind', () => weather.toggleWind());
    window.addEventListener('fpv-toggle-rain', () => weather.toggleRain());
    window.addEventListener('fpv-toggle-thermal', () => weather.toggleThermal());
    window.addEventListener('fpv-thermal-changed', () => applyRendererResolution());
    window.addEventListener('fpv-thermal-visual', () => applyRendererResolution());
    window.addEventListener('fpv-build-changed', () => {
        weather.syncThermalWithBuild();
    });

    window.addEventListener('fpv-mode-2', () => {
        if(MAP.indoor)return;
        physics.state.droneStats.gameMode = 2;
        physics.state.droneStats.raceState = 'IDLE';
        physics.state.droneStats.destroyedTargets = 0;
        race.hideRaceTrack(scene);
        car.removeCarTarget(scene);
        heli.removeHeliTarget(scene);
        soldier.removeSoldierTarget(scene);
        bomber.spawnTank();
    });

    window.addEventListener('fpv-mode-3', () => {
        if(!MAP.indoor)return;
        physics.state.droneStats.gameMode = 3;
        physics.state.droneStats.raceState = 'COUNTDOWN';
        physics.state.droneStats.raceCountdown = 3.0;
        physics.state.droneStats.raceTime = 0;
        physics.state.droneStats.currentGate = 0;
        physics.state.droneStats.totalGates = 20;

        car.removeCarTarget(scene);
        bomber.hideTank(scene);
        heli.removeHeliTarget(scene);
        soldier.removeSoldierTarget(scene);
        race.generateRaceTrack(scene);
        physics.resetDrone(controls.getFlightController());
        resetTabletMapView();
        cockpit.resetCockpitProps();
    });

    window.addEventListener('fpv-mode-4', () => {
        if(MAP.indoor)return;
        physics.state.droneStats.gameMode = 4;
        physics.state.droneStats.raceState = 'IDLE';
        physics.state.droneStats.destroyedTargets = 0;
        race.hideRaceTrack(scene);
        bomber.hideTank(scene);
        car.removeCarTarget(scene);
        soldier.removeSoldierTarget(scene);
        heli.spawnHeliTarget(scene);
    });

    window.addEventListener('fpv-mode-5', () => {
        if(MAP.indoor)return;
        physics.state.droneStats.gameMode = 5;
        physics.state.droneStats.raceState = 'IDLE';
        physics.state.droneStats.destroyedTargets = 0;
        race.hideRaceTrack(scene);
        bomber.hideTank(scene);
        car.removeCarTarget(scene);
        heli.removeHeliTarget(scene);
        soldier.spawnSoldierTarget(scene);
    });

    window.addEventListener('fpv-drop-bomb', () => {
        if (physics.state.droneStats.gameMode === 2) {
            bomber.dropBomb();
        }
    });

    window.addEventListener('fpv-replay-continue', () => {
        replay.continueAfterReplay(camera, physics.state.droneBody);
        window.dispatchEvent(new CustomEvent('fpv-respawn'));
    });

    window.addEventListener('fpv-replay-impact', () => {
        if (pendingSoldierExplode) {
            pendingSoldierExplode = false;
            soldier.explodeSoldierOnCollision(scene, { respawn: false });
        }
        if (pendingCarExplode) {
            pendingCarExplode = false;
            car.explodeCarOnCollision(scene, { deferRemove: true });
        }
    });

    window.addEventListener('fpv-replay-end', () => {
        if (pendingSoldierExplode) {
            pendingSoldierExplode = false;
            soldier.explodeSoldierOnCollision(scene, { respawn: false });
        }
        if (physics.state.droneStats.gameMode === 5) soldier.resumeSoldierAfterReplay();
        if (pendingCarExplode) {
            pendingCarExplode = false;
            car.explodeCarOnCollision(scene, { deferRemove: true });
        }
        if (car.finalizeCarRemoval) car.finalizeCarRemoval(scene);
    });

    window.addEventListener('fpv-respawn', () => {
        rotorWash?.clear();
        localVegetation?.clear();
        nearFocus.resetExposure?.();
        pendingCarExplode = false;
        pendingSoldierExplode = false;
        replay.cancelReplay(camera, physics.state.droneBody);
        replay.clearDroneTrack();
        replay.clearCarTrack();
        physics.state.droneStats.destroyedTargets = 0;
        physics.resetDrone(controls.getFlightController());
        resetTabletMapView();
        cockpit.resetCockpitProps();
        audio.playStartupSound();
        try {
            logFlightStart({
                mode: physics.state.droneStats.gameMode,
                lat: MAP.spawnLat,
                lon: MAP.spawnLon,
            });
        } catch (_) {}

        const mode = physics.state.droneStats.gameMode;
        if (mode === 1) {
            car.removeCarTarget(scene);
            car.spawnCarTarget(scene, roadNetwork);
        } else if (mode === 2) {
            bomber.hideTank(scene);
            bomber.spawnTank();
        } else if (mode === 3) {
            race.restartRace(scene);
        } else if (mode === 4) {
            heli.removeHeliTarget(scene);
            heli.spawnHeliTarget(scene);
        } else if (mode === 5) {
            soldier.removeSoldierTarget(scene);
            soldier.spawnSoldierTarget(scene);
        }
    });

    let isEngineRunning = false;
    let hasEverStarted = false;
    let crashKillReported = false;
    let pendingCarExplode = false;
    let pendingSoldierExplode = false;
    let lastFrameTime = performance.now();

    // Наліт пілота: тільки реальний час у повітрі (isAirborne), не земля / краш / реплей.
    // Шлемо дельтою кожні ~20с + при паузі/закритті вкладки.
    let flightTimeAccum = 0;
    const FLIGHT_TIME_REPORT_INTERVAL_S = 20;

    function flushFlightTime(useBeacon = false) {
        if (flightTimeAccum <= 0) return;
        const toSend = flightTimeAccum;
        flightTimeAccum = 0;
        if (useBeacon) {
            reportFlightTimeBeacon(toSend);
        } else {
            reportFlightTime(toSend);
        }
    }

    let fps = 60;
    let frameCount = 0;
    let lastFpsUpdate = performance.now();

    function attachStartButtonHandler() {
        const startBtn = document.getElementById('startBtn');
        if (!startBtn) {
            isEngineRunning = true;
            return;
        }
        startBtn.addEventListener('click', () => {
            beginTouchFlight();
            // Спочатку сховати auth, потім destroy menu (releaseAuth не має його показати)
            setAuthPanelVisible(false);
            stopMenuDronePreview();
            setMenuMusicButtonVisible(false);
            const startScreen = document.getElementById('startScreen');
            if (startScreen) startScreen.style.display = 'none';

            const configChanged = consumeRoundConfigChangedFlag();
            if (configChanged || (MAP.indoor && physics.state.droneStats.raceState==='FINISHED')) {
                window.dispatchEvent(new CustomEvent(`fpv-mode-${physics.state.droneStats.gameMode}`));
                physics.resetDrone(controls.getFlightController());
                resetTabletMapView();
                cockpit.resetCockpitProps();
            }

            if (configChanged || !hasEverStarted) {
                audio.playStartupSound();
            }
            hasEverStarted = true;
            try {
                logFlightStart({
                    mode: physics.state.droneStats.gameMode,
                    lat: MAP.spawnLat,
                    lon: MAP.spawnLon,
                });
            } catch (_) {}

            audio.initEngineAudio();
            audio.resumeAudio();
            isEngineRunning = true;
            lastFrameTime = performance.now();
            weather.syncThermalWithBuild();
            // resize після старту — auth лишається hidden (syncAuthPlacement це поважає)
            setTimeout(() => {
                setAuthPanelVisible(false);
                window.dispatchEvent(new Event('resize'));
            }, 100);
        });
    }
    attachStartButtonHandler();

    function setPilotHudVisible(show) {
        const hudEl = document.getElementById('interface');
        if (hudEl) hudEl.style.display = '';
        const gpEl = document.querySelector('.gamepad-info');
        if (gpEl) gpEl.style.display = '';
        if (show && hudEl) {
            /* FPV — повний HUD малює drawHUD */
        }
    }

    function togglePilotView() {
        if (!isEngineRunning) return;
        if (replay.isReplayActive && replay.isReplayActive()) return;
        if (controls.isPilotView()) {
            controls.exitPilotView(physics.state.droneBody);
            setPilotHudVisible(true);
        } else {
            if (controls.enterPilotView(scene, physics.state.droneBody)) setPilotHudVisible(false);
        }
    }

    window.addEventListener('fpv-toggle-pilot-view', togglePilotView);

    window.addEventListener('wheel', (e) => {
        if (!isEngineRunning) return;
        if (replay.isReplayActive && replay.isReplayActive()) return;
        e.preventDefault();
        if (e.deltaY > 0) {
            if (!controls.isPilotView()) {
                if (controls.enterPilotView(scene, physics.state.droneBody)) setPilotHudVisible(false);
            }
        } else if (controls.isPilotView()) {
            controls.exitPilotView(physics.state.droneBody);
            setPilotHudVisible(true);
        }
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
        if (e.code !== 'Escape' || !isEngineRunning) return;

        isEngineRunning = false;
        flushFlightTime();
        if (controls.isPilotView()) {
            controls.exitPilotView(physics.state.droneBody);
            setPilotHudVisible(true);
        }
        replay.cancelReplay(camera, physics.state.droneBody);
        setAuthPanelVisible(true);
        audio.updateEngineSound({ throttle: 0, pitch: 0, roll: 0, yaw: 0 }, 0, false);

        const startScreen = document.getElementById('startScreen');
        if (startScreen) {
            startScreen.innerHTML = renderStartMenu();
            startScreen.style.display = '';
            // renderStartMenu → initMenuDronePreview + музика
        }
        setMenuMusicButtonVisible(true);
        startMenuMusic();
        attachStartButtonHandler();
    });

    // Наліт: закриття вкладки/перехід зі сторінки — fetch() у цей момент
    // може не встигнути піти (браузер обриває мережу при unload), тому
    // тут саме sendBeacon-варіант. visibilitychange='hidden' — той самий
    // сценарій на мобільних (там beforeunload часто взагалі не спрацьовує).
    window.addEventListener('beforeunload', () => {
        if (isEngineRunning) flushFlightTime(true);
    });
    document.addEventListener('visibilitychange', () => {
        lastGraphicsFrameTime = null;
        if (document.visibilityState === 'hidden' && isEngineRunning) {
            flushFlightTime(true);
        }
    });

    function animate() {
        requestAnimationFrame(animate);
        controls.pollGamepadConnect(info);
        const graphicsNow = performance.now();
        const graphicsActive = isEngineRunning && !document.hidden && !replay.isReplayActive();
        const graphicsDt = lastGraphicsFrameTime === null ? 0 : (graphicsNow - lastGraphicsFrameTime) / 1000;
        lastGraphicsFrameTime = graphicsActive ? graphicsNow : null;
        if (graphicsBudget.sample(graphicsDt, graphicsActive)) applyGraphicsProfile();

        if (physics.state.droneBody) {
            // Convert existing simulation velocity to scene units/second only for prefetch.
            graphicsVelocity.x = isEngineRunning ? physics.state.velocity.x * 60 : 0;
            graphicsVelocity.z = isEngineRunning ? physics.state.velocity.z * 60 : 0;
            updateMapCulling(physics.state.droneBody.position, camera, graphicsVelocity);
        }

        if (physics.state.droneBody) {
            const p = physics.state.droneBody.position;
            const off = light.userData.sunOffset || new THREE.Vector3(0.36, 0.91, 0.22).multiplyScalar(800);
            sunTarget.position.set(p.x, p.y, p.z);
            light.position.set(p.x + off.x, p.y + off.y, p.z + off.z);
            light.target.updateMatrixWorld();
        }

        showTouchControls(isEngineRunning && !replay.isReplayActive() && !isTabletMapOpen() && physics.state.droneStats.raceState!=='FINISHED');
        if (!isEngineRunning) {
            updateGroundEffects(0);
            updateDroneGroundShadow(null, false);
            renderer.render(scene, camera);
            return;
        }

        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
        lastFrameTime = now;

        const inRealFlight = !!(
            physics.state.isAirborne
            && !physics.state.isCrashed
            && !replay.isReplayActive()
        );
        if (inRealFlight) {
            flightTimeAccum += dt;
            if (flightTimeAccum >= FLIGHT_TIME_REPORT_INTERVAL_S) {
                flushFlightTime();
            }
        }

        frameCount++;
        if (now - lastFpsUpdate >= 500) {
            fps = Math.round((frameCount * 1000) / (now - lastFpsUpdate));
            frameCount = 0;
            lastFpsUpdate = now;
        }

        if(!MAP.indoor)weather.updateWeather(dt, physics.state.droneBody ? physics.state.droneBody.position : null);

        if (!replay.isReplayActive()) {
            if (physics.state.droneStats.gameMode === 1) {
                car.updateCar(dt, scene);
            }
            if (physics.state.droneStats.gameMode === 2) {
                bomber.updateBomber(dt);
            }
            if (physics.state.droneStats.gameMode === 4) {
                heli.updateHeli(dt, scene);
                car.updateCarEffects(dt, scene);
            }
            if (physics.state.droneStats.gameMode === 5) {
                car.updateCarEffects(dt, scene);
                const shot = soldier.updateSoldier(dt, scene, physics.state.droneBody);
                if (shot && shot.shotHit && !physics.state.isCrashed) {
                    physics.state.isCrashed = true;
                    physics.state.crashTime = performance.now();
                }
            }
        } else if (physics.state.droneStats.gameMode === 2) {
            bomber.updateBomber(dt);
        }

        // Запис треків дрона та цілі для Погоні й Полювання.
        {
            const mode = physics.state.droneStats.gameMode;
            if ((mode === 1 || mode === 5) && physics.state.droneBody && !physics.state.isCrashed) {
                const target = mode === 5 ? soldier.getSoldierTarget() : car.getCarTarget();
                const mesh = target?.active ? target.mesh : null;
                replay.recordFrame(dt, physics.state.droneBody, mesh,
                    mode === 5 ? soldier.captureSoldierReplayPose() : null);
            }
        }

        if (replay.isReplayActive()) {
            if (controls.isPilotView()) {
                controls.exitPilotView(physics.state.droneBody);
                setPilotHudVisible(true);
            }
            if (car.setCarViewCamera) car.setCarViewCamera(camera);

            if (!replay.isWaitingContinue()) {
                replay.updateReplay(dt, camera, physics.state.droneBody);
                if ([1, 5].includes(physics.state.droneStats.gameMode) && car.updateCarEffects) {
                    car.updateCarEffects(dt, scene);
                }
            } else {
                const gpHold = controls.getActiveGamepad();
                if (replay.pollContinueFromGamepad && replay.pollContinueFromGamepad(gpHold, dt)) {
                    window.dispatchEvent(new CustomEvent('fpv-replay-continue'));
                }
            }

            const rt = replay.getReplayMotorThrottle ? replay.getReplayMotorThrottle() : 0;
            if (rt > 0.01) {
                audio.updateEngineSound({ throttle: rt, pitch: 0, roll: 0, yaw: 0 }, rt, false, false, 0.35);
            } else {
                audio.updateEngineSound({ throttle: 0, pitch: 0, roll: 0, yaw: 0 }, 0, false, false, 0);
            }
            updateDroneGroundShadow(null, false);
            updateGroundEffects(0, true);
            renderer.render(scene, camera);
            hud.drawHUD({
                droneBody: physics.state.droneBody,
                velocity: physics.state.velocity,
                isCrashed: physics.state.isCrashed,
                crashTime: physics.state.crashTime,
            crashBlackout: physics.state.crashBlackout,
                droneStats: physics.state.droneStats,
                cameraAngleDeg: controls.settings.cameraAngleDeg,
                cameraFov: controls.settings.cameraFov,
                flightMode: controls.settings.flightMode,
                centerLat: MAP.centerLat,
                centerLon: MAP.centerLon,
                unitToMeters: MAP.UNIT_TO_METERS,
                audioActive: audio.isAudioActive(),
                bombStatus: bomber.bombStatus,
                homeAltitude: physics.state.homeAltitude,
                fps: fps,
                isReplay: true,
                isReplayHold: replay.isWaitingContinue && replay.isWaitingContinue(),
                replayTelemetry: replay.getReplayTelemetry
                    ? replay.getReplayTelemetry(MAP, physics.state.homeAltitude)
                    : null,
                droneStatsLive: physics.state.droneStats,
            });
            if (replay.captureReplayFrame) replay.captureReplayFrame();
            return;
        }

        const gp = controls.getActiveGamepad();
        const touch = isTouchControlActive() && !gp;
        const flightController = touch ? touchController : controls.getFlightController();

        if ((gp || touch) && flightController && !(MAP.indoor && physics.state.droneStats.raceState==='FINISHED')) {
            const inputs = flightController.update(gp, dt);
            if (gp) controls.updateGamepadButtons(gp);
            const targetForJammer = physics.state.droneStats.gameMode === 1 ? car.getCarTarget() : null;
            const targetHeli = physics.state.droneStats.gameMode === 4 ? heli.getHeliTarget() : null;
            const targetSoldier = physics.state.droneStats.gameMode === 5 ? soldier.getSoldierTarget() : null;

            const result = physics.updateFlight(
                dt, inputs, controls.settings.flightMode, checkCollision, targetForJammer, flightController, targetHeli, targetSoldier
            );

            // Автореспавн після краху відбувається ВСЕРЕДИНІ physics.js
            // (через 3с після crashTime), а не тут — тому саме тут, а не
            // тільки в fpv-respawn/mode-change, треба скидати пропи.
            if (result.justRespawned) {
                resetTouchControls();
                resetTabletMapView();
                cockpit.resetCockpitProps();
            }

            if (physics.state.droneStats.gameMode === 3) {
                race.updateRace(dt);
            }

            if (result.carHit && physics.state.droneStats.gameMode === 1) {
                physics.state.detonated = true;
                physics.state.droneStats.destroyedTargets++;
                stats.reportKill('car');
                pendingCarExplode = true;
                const carT = car.getCarTarget && car.getCarTarget();
                const carMesh = (carT && carT.mesh) ? carT.mesh : null;
                const pos = carMesh
                    ? carMesh.position.clone()
                    : physics.state.droneBody.position.clone();
                replay.forceSample(physics.state.droneBody, carMesh);
                car.clearDustTrail(scene);
                const ok = replay.startDroneReplay(camera, physics.state.droneBody, pos, carMesh);
                if (!ok) {
                    pendingCarExplode = false;
                    car.explodeCarOnCollision(scene);
                }
            } else if (result.heliHit && physics.state.droneStats.gameMode === 4) {
                physics.state.detonated = true;
                physics.state.droneStats.destroyedTargets++;
                stats.reportKill('heli');
                heli.explodeHeliOnCollision(scene);
            } else if (result.soldierHit && physics.state.droneStats.gameMode === 5) {
                physics.state.detonated = true;
                physics.state.droneStats.destroyedTargets++;
                stats.reportKill('soldier');
                const target = soldier.getSoldierTarget();
                const mesh = target?.mesh;
                const pos = mesh ? mesh.position.clone() : physics.state.droneBody.position.clone();
                pendingSoldierExplode = true;
                soldier.prepareSoldierReplay(scene);
                const ok = replay.startDroneReplay(camera, physics.state.droneBody, pos, mesh, {
                    vehicleDust: false,
                    restoreAtEnd: true,
                    pose: soldier.captureSoldierReplayPose(),
                    applyPose: soldier.applySoldierReplayPose,
                });
                if (!ok) {
                    pendingSoldierExplode = false;
                    soldier.explodeSoldierOnCollision(scene);
                }
            }

            const motorsLive = !!physics.state.armed && !physics.state.isCrashed;
            let soundVol = 1;
            if (controls.isPilotView() && physics.state.droneBody) {
                const distM = controls.pilotToDroneMeters(physics.state.droneBody);
                if (distM > 300) {
                    controls.exitPilotView(physics.state.droneBody);
                    setPilotHudVisible(true);
                } else {
                    soundVol = Math.max(0.04, 1 - distM / 300);
                }
            }
            const soundInputs = motorsLive ? {
                throttle: inputs.throttle * (result.thrustModifier !== undefined ? result.thrustModifier : 1.0),
                pitch: inputs.pitch,
                roll: inputs.roll,
                yaw: inputs.yaw
            } : { throttle: 0, pitch: 0, roll: 0, yaw: 0 };
            audio.updateEngineSound(
                soundInputs,
                motorsLive ? result.throttle : 0,
                physics.state.isCrashed,
                false,
                soundVol,
                {
                    armed: motorsLive,
                    propwashDirty: result.propwashDirty,
                    soundPitchBias: result.soundPitchBias,
                    soundRoughness: result.soundRoughness,
                    linkQuality: physics.state.droneStats.linkQuality,
                }
            );

            // Пропи + MORKOVKA (зі стіками)
            cockpit.updateCockpit(
                dt,
                physics.state.motorThrottle,
                physics.state.droneStats.gameMode,
                physics.state.isCrashed,
                !!(replay.isReplayActive && replay.isReplayActive()),
                inputs,
                physics.state.currentRates,
                physics.state.motors,
                !!physics.state.armed,
                controls.isPilotView(),
                !!physics.state.detonated
            );

            if (physics.state.isCrashed) {
                if (!crashKillReported) {
                    crashKillReported = true;
                    stats.reportKill('drone');
                }
            } else {
                crashKillReported = false;
            }
        } else {
            // Немає геймпада — все одно показуємо раму / MORKOVKA за режимом
            cockpit.updateCockpit(
                dt,
                physics.state.motorThrottle,
                physics.state.droneStats.gameMode,
                physics.state.isCrashed,
                !!(replay.isReplayActive && replay.isReplayActive()),
                { pitch: 0, roll: 0, yaw: 0, throttle: 0 },
                physics.state.currentRates,
                physics.state.motors,
                !!physics.state.armed,
                controls.isPilotView(),
                !!physics.state.detonated
            );
        }

        // Target hits have already marked detonation (and may defer it for replay).
        // Other crashes, including enemy shots, detonate once at the drone position.
        if (physics.state.isCrashed && !physics.state.detonated &&
            cockpit.hasKamikazePayload(physics.state.droneStats.gameMode)) {
            physics.state.detonated = true;
            physics.state.crashBlackout = true;
            cockpit.setCockpitVisible(false);
            car.createEpicExplosion(physics.state.droneBody.position.clone(), scene);
        }

        if (controls.isPilotView()) {
            if (!controls.canEnterPilotView(physics.state.droneBody)) {
                controls.exitPilotView(physics.state.droneBody);
                setPilotHudVisible(true);
            } else {
                controls.updatePilotView(physics.state.droneBody);
            }
        }

        {
            const wx = weather.weather;
            const thermalVis = wx.thermalEnabled && !controls.isPilotView();
            const allow = !MAP.indoor && wx && !wx.isNight && !wx.rainEnabled && !thermalVis;
            updateDroneGroundShadow(physics.state.droneBody, allow);
        }

        updateGroundEffects(dt);
        nearFocus.render(scene, camera, MAP.UNIT_TO_METERS,
            !controls.isPilotView() && !weather.weather.thermalEnabled && !physics.state.isCrashed, dt);

        hud.drawHUD({
            droneBody: physics.state.droneBody,
            velocity: physics.state.velocity,
            isIndoor: !!MAP.indoor,
            isCrashed: physics.state.isCrashed,
            crashTime: physics.state.crashTime,
            crashBlackout: physics.state.crashBlackout,
            droneStats: physics.state.droneStats,
            cameraAngleDeg: controls.settings.cameraAngleDeg,
            cameraFov: controls.settings.cameraFov,
            flightMode: controls.settings.flightMode,
            armed: !!physics.state.armed,
            centerLat: MAP.centerLat,
            centerLon: MAP.centerLon,
            unitToMeters: MAP.UNIT_TO_METERS,
            audioActive: audio.isAudioActive(),
            bombStatus: bomber.bombStatus,
            homeAltitude: physics.state.homeAltitude,
            fps: fps,
            isPilotView: controls.isPilotView(),
            serviceHoldS: physics.state.serviceHoldS || 0,
            videoLost: !!physics.state.videoLost,
            rcFailsafe: !!physics.state.rcFailsafe,
            videoDropout: physics.state.videoDropout || 0
        });
    }

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        applyRendererResolution();
        hud.resizeHUD();
    });

    const savedMode = getSavedGameMode();
    window.dispatchEvent(new CustomEvent(`fpv-mode-${savedMode}`));
    animate();
}
bootstrap();
