/* ====================================================================
           TOYOTA T-CONNECT NAVIGATION & ADVANCED ENGINE
           ==================================================================== */
        // GitHub Pages版: ここに自分のGemini APIキーを直接貼り付けてください
        // (取得先: https://aistudio.google.com/app/apikey)。
        // ⚠️ 静的サイトなので、このキーは誰でもブラウザの「ページのソースを表示」で読めてしまいます。
        const GEMINI_API_KEY = 'ここにGemini APIキーを貼り付け';
        // NOTE: the boot-splash failsafe (uncaught-error handler, auto-hide timer, and the
        // manual "tap to continue" skip-button timer) now lives in a tiny dependency-free
        // <script> at the very top of index.html's <head>, ahead of every external resource,
        // so it can never be delayed by a slow/unreachable stylesheet or script elsewhere on
        // the page. See that block if you need to adjust the timing.
        let map, carMarker, routePolyline;
        let currentPos = [35.6762, 139.7650]; // Default: Tokyo Ginza
        let originPos = null;
        let destinationPos = null;
        let currentDestName = '';
        let viaPoint = null;       // NEW FEATURE: optional single waypoint ("経由地")
        let viaPointName = '';
        let currentHeading = 0; // Direction bearing in degrees
        let headingMode = 'north';
        let guidanceOff = false;
        let splitScreenOpen = true;
        let currentAudioSource = 'applemusic';

        // NEW FEATURE & UPDATED STATES
        let driveMode = 'NORMAL'; 
        let isWeatherRainActive = false;
        let dashcamRecording = true;
        let enable3DJunction = true; // 3D Junction Enable/Disable toggle
        let simSpeedMultiplier = 1; // Simulation speed multipliers: 1x, 2x, 5x, 10x, 0x (Pause)

        // Climate Settings State
        let driverTemp = 25.0;
        let passengerTemp = 25.0;
        let fanSpeed = 3;
        let ventMode = 0;
        let isAC = true;
        let isDual = true;

        // Three.js Dynamic Procedural 3D Scene State
        let threeScene, threeCamera, threeRenderer;
        let roadGroup, buildingGroup, gantryMesh;
        let camera3DViewMode = 'OVERHEAD';
        // Real-world 3D junction data: cache of OpenStreetMap building footprints already
        // fetched (keyed by rounded lat/lng), and a request token used to discard stale
        // async responses if the driver moves past the junction before a fetch resolves.
        let jctBuildingCache = new Map();
        let jctRequestToken = 0;
        let simCoords = [];
        let simSteps = [];
        let routeTotalDistanceM = 0;
        let routeTotalDurationS = 0;
        let etaUpdateCounter = 0;

        // Real-world distance-and-time based simulation engine state (replaces the old
        // fixed "progress-per-frame" approach that ignored actual segment length, which is
        // why straight OSRM segments with few far-apart points used to fly by unrealistically)
        let simCumDistM = [];      // cumulative meters along simCoords, parallel array
        let simStepCumDistM = [];  // cumulative meters at the START of each simSteps[] entry
        let simTraveledM = 0;      // how far along the route we've driven, in meters
        let simCurrentSpeedMps = 0; // smoothed current simulated vehicle speed (m/s)
        let simLastFrameTime = null;
        let mapFollowMode = true;  // false once the user drags the map, so guidance doesn't fight their pan
        let lastAnnouncedStepIdx = { far: -1, mid: -1, near: -1, now: -1 };
        let lastLongStraightAnnounceIdx = -1;

        // NEW FEATURE: live ETA / remaining-distance readout, recalculated from the current
        // wall-clock time as the drive progresses (remainingFraction: 1 = just departed, 0 = arrived)
        function updateEtaDisplay(remainingFraction) {
            if (!routeTotalDistanceM) return;
            const remDistM = routeTotalDistanceM * remainingFraction;
            const remDurS = routeTotalDurationS * remainingFraction;

            const distEl = document.getElementById('eta-dist');
            if (distEl) distEl.innerText = remDistM >= 1000 ? `${(remDistM / 1000).toFixed(1)} km` : `${Math.round(remDistM)} m`;

            const etaDate = new Date(Date.now() + remDurS * 1000);
            const hh = String(etaDate.getHours()).padStart(2, '0');
            const mm = String(etaDate.getMinutes()).padStart(2, '0');
            const timeEl = document.getElementById('eta-time');
            if (timeEl) timeEl.innerText = `${hh}:${mm}`;
        }
        let animFrameId = null;
        let simIndex = 0;

        // ---- Geo helpers for the distance-based driving simulation ----
        function haversineM(lat1, lon1, lat2, lon2) {
            const R = 6371000;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }

        function buildRouteDistanceTables() {
            simCumDistM = [0];
            for (let i = 1; i < simCoords.length; i++) {
                const d = haversineM(simCoords[i - 1][0], simCoords[i - 1][1], simCoords[i][0], simCoords[i][1]);
                simCumDistM.push(simCumDistM[i - 1] + d);
            }
            simStepCumDistM = [0];
            for (let i = 0; i < simSteps.length; i++) {
                simStepCumDistM.push(simStepCumDistM[i] + (simSteps[i].distance || 0));
            }
        }

        // Returns {lat, lon, index} for a given traveled distance along simCoords, by
        // interpolating between the two nearest points (so movement is smooth regardless
        // of how far apart OSRM's own geometry points happen to be on that stretch of road).
        function getPointAtDistance(distM) {
            if (simCumDistM.length < 2) return { lat: currentPos[0], lon: currentPos[1], index: 0 };
            const total = simCumDistM[simCumDistM.length - 1];
            const d = Math.max(0, Math.min(distM, total));
            let lo = 0, hi = simCumDistM.length - 1;
            while (lo < hi - 1) {
                const mid = (lo + hi) >> 1;
                if (simCumDistM[mid] <= d) lo = mid; else hi = mid;
            }
            const segLen = simCumDistM[hi] - simCumDistM[lo];
            const f = segLen > 0 ? (d - simCumDistM[lo]) / segLen : 0;
            const p1 = simCoords[lo], p2 = simCoords[hi];
            return {
                lat: p1[0] + (p2[0] - p1[0]) * f,
                lon: p1[1] + (p2[1] - p1[1]) * f,
                index: lo
            };
        }

        function getHeadingAtDistance(distM) {
            const a = getPointAtDistance(distM);
            const b = getPointAtDistance(Math.min(distM + 8, simCumDistM[simCumDistM.length - 1] || 0));
            return calculateBearing(a.lat, a.lon, b.lat, b.lon);
        }

        // Target cruising speed derived from how sharply the road curves just ahead, plus a
        // slowdown as the next turn/maneuver approaches — replaces the old fixed "40〜44
        // repeating" placeholder with something that actually reacts to the route shape.
        function computeTargetSpeedKmh(atDistM) {
            const total = simCumDistM[simCumDistM.length - 1] || 0;
            const hNow = getHeadingAtDistance(atDistM);
            const hAhead = getHeadingAtDistance(Math.min(atDistM + 70, total));
            let diff = Math.abs(((hAhead - hNow + 540) % 360) - 180);

            let target;
            if (diff < 6) target = 56;
            else if (diff < 18) target = 42;
            else if (diff < 45) target = 28;
            else target = 16;

            // NEW: wet-road conditions bring the natural cruising speed down, same as a real driver easing off
            if (isWeatherRainActive) target = Math.round(target * 0.8);

            const { distToNextManeuverM } = getDistanceToNextManeuver();
            if (isFinite(distToNextManeuverM)) {
                if (distToNextManeuverM < 35) target = Math.min(target, 14);
                else if (distToNextManeuverM < 90) target = Math.min(target, 26);
            }
            return target;
        }

        // Audio Synth
        let audioCtx = null;
        let volumeLevel = 5;

        function initAudio() {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }

        function playBeep(type = 'click') {
            try {
                initAudio();
                const now = audioCtx.currentTime;
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();

                osc.type = 'sine';
                osc.frequency.setValueAtTime(type === 'click' ? 880 : 1200, now);
                gain.gain.setValueAtTime(0.12 * (volumeLevel / 5), now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(now);
                osc.stop(now + 0.04);
            } catch (e) {}
        }

        function speakGuidance(text) {
            playBeep('click');
            if (guidanceOff || volumeLevel === 0) return;
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'ja-JP';
                utterance.rate = 1.05;
                utterance.volume = Math.min(1, volumeLevel / 5);
                window.speechSynthesis.speak(utterance);
            }
        }

        /* Calculate Bearing Angle for Smooth Arrow Rotation */
        function calculateBearing(lat1, lon1, lat2, lon2) {
            const radLat1 = (lat1 * Math.PI) / 180;
            const radLat2 = (lat2 * Math.PI) / 180;
            const diffLon = ((lon2 - lon1) * Math.PI) / 180;

            const y = Math.sin(diffLon) * Math.cos(radLat2);
            const x = Math.cos(radLat1) * Math.sin(radLat2) - Math.sin(radLat1) * Math.cos(radLat2) * Math.cos(diffLon);
            const brng = (Math.atan2(y, x) * 180) / Math.PI;
            return (brng + 360) % 360;
        }

        // NEW: switched from window.onload (waits for every external resource — fonts, map
        // tiles, cdnjs scripts — before running ANY app code) to DOMContentLoaded, which fires
        // as soon as the HTML itself is parsed. This is far less likely to stall on a slow or
        // partially-blocked network, which was almost certainly why the app could get stuck
        // sitting on the boot splash and never proceed to the dashboard.
        // NEW: don't rely solely on the DOMContentLoaded event. If any deferred external
        // script (Leaflet, Three.js) never resolves on a very restrictive network, some
        // browsers can delay that event indefinitely, which would leave the whole app
        // uninitialized — map, buttons, everything — even after the boot splash itself
        // has been force-dismissed by the earlier failsafe. appInitOnce() below is guarded
        // so it only ever runs a single time, however it ends up getting triggered.
        var appInitRan = false;
        function appInitOnce() {
            if (appInitRan) return;
            appInitRan = true;
            initApp();
        }
        if (document.readyState !== 'loading') {
            // DOMContentLoaded may have already fired before this script ran. Still defer to
            // the next tick (rather than calling appInitOnce() synchronously here) so the rest
            // of this script — all the `let`/`const` declared further down the file — has
            // finished executing first; calling it immediately-synchronously at this point
            // would throw a "Cannot access before initialization" error on any of them.
            setTimeout(appInitOnce, 0);
        } else {
            document.addEventListener('DOMContentLoaded', appInitOnce);
        }
        // Hard fallback: guarantees the app initializes within 4s no matter what, even if the
        // DOMContentLoaded event itself never fires at all.
        setTimeout(appInitOnce, 4000);

        function initApp() {
            // playBootAnimation() runs first and unconditionally, so even if something below
            // throws, the splash-hide timer is already scheduled and the 6s failsafe above
            // still applies — the user is never left staring at a frozen logo.
            playBootAnimation();
            setInterval(updateClock, 1000);
            updateClock();
            applyMapTheme();

            try {
                // Leaflet Map Init
                map = L.map('map', {
                    center: currentPos,
                    zoom: 16,
                    zoomControl: false,
                    attributionControl: false
                });

                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

                // NEW FEATURE: let the driver freely pan/zoom the map during route guidance.
                // Only a real user drag disengages "follow" mode (map.panTo() from the simulation
                // itself never fires 'dragstart'), and a floating button lets them snap back.
                map.on('dragstart', () => {
                    if (mapFollowMode) {
                    mapFollowMode = false;
                    const btn = document.getElementById('btn-recenter-map');
                    if (btn) btn.classList.remove('hidden');
                }
            });

            // Car Marker Element with Smooth Dynamic Rotation Support
            const carIcon = L.divIcon({
                className: 'car-marker-container',
                html: `
                    <div id="car-arrow-element" class="car-arrow-3d" style="width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; transition: transform 0.2s ease-out;">
                        <svg viewBox="0 0 100 100" width="48" height="48">
                            <defs>
                                <linearGradient id="carGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                                    <stop offset="0%" style="stop-color:#60a5fa;" />
                                    <stop offset="50%" style="stop-color:#2563eb;" />
                                    <stop offset="100%" style="stop-color:#1d4ed8;" />
                                </linearGradient>
                            </defs>
                            <circle cx="50" cy="50" r="44" fill="rgba(37, 99, 235, 0.25)" stroke="#60a5fa" stroke-width="2" />
                            <path d="M 50,10 L 84,84 L 50,66 L 16,84 Z" fill="url(#carGrad)" stroke="#ffffff" stroke-width="3" />
                        </svg>
                    </div>
                `,
                iconSize: [48, 48],
                iconAnchor: [24, 24]
            });

            carMarker = L.marker(currentPos, { icon: carIcon }).addTo(map);

            initThreeJSJunction();
            getCurrentLocation(false);
            } catch (err) {
                // The dashboard still needs to be usable even if the map/3D engine failed to
                // load (e.g. a blocked CDN script) — log it, but don't leave the user stuck.
                console.error('Initialization error (app still usable, some features may be degraded):', err);
            }
        }

        // NEW FEATURE: Toyota-style boot/startup splash animation (replicates factory startup screen)
        function playBootAnimation() {
            const splash = document.getElementById('boot-splash');
            if (!splash) return;
            // restart CSS animations if replayed after first boot
            const logo = document.getElementById('boot-logo');
            const caption = document.getElementById('boot-caution');
            const sheen = document.querySelector('.boot-sheen');
            splash.classList.remove('boot-hidden');
            [logo, caption, sheen].forEach(el => {
                if (!el) return;
                el.style.animation = 'none';
                void el.offsetWidth; // force reflow to restart animation
                el.style.animation = '';
            });
            clearTimeout(splash._hideTimer);
            splash._hideTimer = setTimeout(() => {
                splash.classList.add('boot-hidden');
            }, 3200);

            // NEW: visible progress bar so the splash reads as "loading" rather than "frozen"
            const bar = document.getElementById('boot-progress-bar');
            if (bar) {
                bar.style.transition = 'none';
                bar.style.width = '0%';
                void bar.offsetWidth;
                bar.style.transition = 'width 3s linear';
                bar.style.width = '100%';
            }
        }

        // NEW FEATURE: show/hide the climate control panel to widen the map view
        function toggleClimatePanel(show) {
            playBeep();
            const panel = document.getElementById('split-climate-panel');
            const reopenBtn = document.getElementById('btn-climate-reopen');
            if (!panel) return;
            if (show) {
                panel.classList.remove('climate-collapsed');
                if (reopenBtn) reopenBtn.classList.add('hidden');
            } else {
                panel.classList.add('climate-collapsed');
                if (reopenBtn) reopenBtn.classList.remove('hidden');
            }
        }

        function updateClock() {
            const d = new Date();
            const h = String(d.getHours()).padStart(2, '0');
            const m = String(d.getMinutes()).padStart(2, '0');
            document.getElementById('top-clock').innerText = `${h}:${m}`;
            document.getElementById('vics-time').innerText = `${h}:${m}`;
            if (mapThemeMode === 'auto') applyMapTheme();
        }

        function getCurrentLocation(speak = true) {
            playBeep();
            mapFollowMode = true;
            const recenterBtn = document.getElementById('btn-recenter-map');
            if (recenterBtn) recenterBtn.classList.add('hidden');
            if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        currentPos = [pos.coords.latitude, pos.coords.longitude];
                        map.panTo(currentPos, { animate: true });
                        carMarker.setLatLng(currentPos);
                        if (speak) speakGuidance('現在地を取得しました。');
                    },
                    () => {
                        if (speak) alertModal('位置情報通知', '既定の位置（東京・銀座）を表示しています。目的地ボタンより変更可能です。');
                    }
                );
            }
        }

        // NEW FEATURE: snap the map back to the (simulated) car position and resume
        // auto-follow, without doing a real GPS lookup — used by the floating button that
        // appears once the driver has panned the map away during route guidance.
        function reCenterMap() {
            playBeep();
            mapFollowMode = true;
            const recenterBtn = document.getElementById('btn-recenter-map');
            if (recenterBtn) recenterBtn.classList.add('hidden');
            map.panTo(currentPos, { animate: true });
        }

        function zoomIn() { playBeep(); map.zoomIn(); updateScaleText(); }
        function zoomOut() { playBeep(); map.zoomOut(); updateScaleText(); }

        function updateScaleText() {
            const z = map.getZoom();
            const scales = { 19: '25m', 18: '50m', 17: '100m', 16: '200m', 15: '500m', 14: '1km' };
            document.getElementById('scale-text').innerText = scales[z] || '2km';
        }

        function toggleHeadingMode() {
            playBeep();
            const arrow = document.getElementById('compass-arrow');
            if (headingMode === 'north') {
                headingMode = 'heading';
                arrow.style.transform = `rotate(${currentHeading}deg)`;
                speakGuidance('ヘディングアップ表示に変更しました。');
            } else {
                headingMode = 'north';
                arrow.style.transform = 'rotate(0deg)';
                speakGuidance('ノースアップ表示に変更しました。');
            }
        }

        function toggle3DJunctionEnable(forcedState = null) {
            playBeep();
            if (forcedState !== null) {
                enable3DJunction = forcedState;
            } else {
                enable3DJunction = !enable3DJunction;
            }

            const label = document.getElementById('label-3d-toggle');
            const jctBox = document.getElementById('junction-3d-container');

            if (enable3DJunction) {
                if (label) label.innerText = '3D案内: ON';
                speakGuidance('3Dジャンクションガイドを有効にしました。');
            } else {
                if (label) label.innerText = '3D案内: OFF';
                if (jctBox) jctBox.classList.add('hidden');
                speakGuidance('3Dジャンクションガイドをオフにしました。');
            }
        }

        function cycleSimSpeed() {
            playBeep();
            const speeds = [1, 2, 5, 10, 0];
            const currentIndex = speeds.indexOf(simSpeedMultiplier);
            simSpeedMultiplier = speeds[(currentIndex + 1) % speeds.length];

            const speedText = document.getElementById('speed-text');
            if (speedText) {
                speedText.innerText = simSpeedMultiplier === 0 ? '一時停止' : `${simSpeedMultiplier}x 速度`;
            }

            if (simSpeedMultiplier > 0) {
                speakGuidance(`走行速度を ${simSpeedMultiplier} 倍に変更しました。`);
            } else {
                speakGuidance('走行を一時停止しました。');
            }
        }

        function toggleGuidanceOff() {
            playBeep();
            guidanceOff = !guidanceOff;
            const label = document.getElementById('label-guidance');
            if (guidanceOff) {
                label.innerText = '≪On';
                label.classList.add('text-red-400');
            } else {
                label.innerText = '≪Off';
                label.classList.remove('text-red-400');
                speakGuidance('音声案内を開始します。');
            }
        }

        /* ====================================================================
           THREE.JS ADVANCED DYNAMIC PROCEDURAL 3D JUNCTION ENGINE
           (Generates actual route curves, highway elevation, and 3D buildings)
           ==================================================================== */
        function initThreeJSJunction() {
            const container = document.getElementById('three-jct-canvas-container');
            if (!container) return;

            try {
                threeScene = new THREE.Scene();
                threeScene.background = new THREE.Color(0x070a12);
                threeScene.fog = new THREE.FogExp2(0x070a12, 0.012);

                const width = container.clientWidth || 300;
                const height = container.clientHeight || 250;

                threeCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
                update3DCameraPosition();

                threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
                threeRenderer.setSize(width, height);
                threeRenderer.shadowMap.enabled = true;
                container.appendChild(threeRenderer.domElement);

                // Lighting
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
                threeScene.add(ambientLight);

                const dirLight = new THREE.DirectionalLight(0x60a5fa, 1.4);
                dirLight.position.set(30, 60, 40);
                threeScene.add(dirLight);

                // Group Containers for Route-following Objects
                roadGroup = new THREE.Group();
                buildingGroup = new THREE.Group();
                threeScene.add(roadGroup);
                threeScene.add(buildingGroup);

                // Sky / ambient fill so buildings read correctly from every angle
                const hemiLight = new THREE.HemisphereLight(0x3b82f6, 0x0b0f17, 0.6);
                threeScene.add(hemiLight);

                // Asphalt Ground Plane (replaces the old abstract wireframe-only grid)
                const groundGeo = new THREE.PlaneGeometry(400, 400);
                const groundMat = new THREE.MeshStandardMaterial({ color: 0x11161f, roughness: 0.95 });
                const ground = new THREE.Mesh(groundGeo, groundMat);
                ground.rotation.x = -Math.PI / 2;
                ground.position.y = -0.05;
                threeScene.add(ground);

                // Faint reference grid on top of the asphalt for depth perception
                const gridHelper = new THREE.GridHelper(400, 80, 0x1e293b, 0x141a24);
                gridHelper.position.y = -0.02;
                threeScene.add(gridHelper);

                // Build Overhead Expressway Sign Gantry
                createOverheadGantry();

                animateThreeJS();
            } catch (err) {
                console.log("WebGL 3D fallback active:", err);
            }
        }

        /* Convert a real-world lat/lng into local 3D scene meters, anchored at the
           junction point and rotated so the vehicle's current bearing always points
           toward -Z ("ahead"), matching a heading-up driver's view. This is what lets
           the 3D scene follow the *actual* road geometry and building footprints
           instead of an invented shape. */
        function projectToLocalXZ(lat, lng, anchorLat, anchorLng, bearingDeg) {
            const metersPerDegLat = 111320;
            const metersPerDegLng = 111320 * Math.cos(anchorLat * Math.PI / 180);
            const dE = (lng - anchorLng) * metersPerDegLng;
            const dN = (lat - anchorLat) * metersPerDegLat;
            const theta = bearingDeg * Math.PI / 180;
            const ahead = dE * Math.sin(theta) + dN * Math.cos(theta);
            const right = dE * Math.cos(theta) - dN * Math.sin(theta);
            return { x: right, z: -ahead };
        }

        /* Build the 3D road directly from the real OSRM route geometry (the same
           coordinates that drive the 2D map), instead of a synthetic curve, so the
           junction's shape actually matches the road being driven. */
        function buildRealRoadFromRoute(stepIdx, anchorLat, anchorLng, bearingDeg) {
            const lookBehind = 6, lookAhead = 26;
            const start = Math.max(0, stepIdx - lookBehind);
            const end = Math.min(simCoords.length - 1, stepIdx + lookAhead);
            if (end - start < 2) return;

            const pts = [];
            for (let i = start; i <= end; i++) {
                const [lat, lng] = simCoords[i];
                const { x, z } = projectToLocalXZ(lat, lng, anchorLat, anchorLng, bearingDeg);
                // OSRM's route geometry has no elevation data, so a gentle stylized rise
                // further down the road is added to read as an expressway flyover/ramp.
                const ahead = Math.max(0, -z);
                const y = Math.min(6, ahead * 0.035);
                pts.push(new THREE.Vector3(x, y, z));
            }

            const curve = new THREE.CatmullRomCurve3(pts);
            const segments = Math.max(24, pts.length * 3);

            const roadGeo = new THREE.TubeGeometry(curve, segments, 3.6, 8, false);
            const roadMat = new THREE.MeshStandardMaterial({ color: 0x242e3c, roughness: 0.85, metalness: 0.05 });
            roadGroup.add(new THREE.Mesh(roadGeo, roadMat));

            // Highlighted guidance centerline (the path to follow)
            const lineGeo = new THREE.TubeGeometry(curve, segments, 0.35, 6, false);
            const lineMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
            const lineMesh = new THREE.Mesh(lineGeo, lineMat);
            lineMesh.position.y += 0.12;
            roadGroup.add(lineMesh);

            // Dashed lane-edge markings sampled along the real curve
            const dashCount = Math.max(12, Math.floor(pts.length * 1.4));
            for (let i = 0; i < dashCount; i += 2) {
                const t = i / dashCount;
                const p = curve.getPointAt(t);
                const tangent = curve.getTangentAt(t);
                const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
                [-3.3, 3.3].forEach(offset => {
                    const dashGeo = new THREE.BoxGeometry(0.15, 0.05, 1.1);
                    const dashMat = new THREE.MeshBasicMaterial({ color: 0xf1f5f9 });
                    const dash = new THREE.Mesh(dashGeo, dashMat);
                    dash.position.copy(p).addScaledVector(normal, offset);
                    dash.position.y += 0.05;
                    dash.lookAt(p.clone().add(tangent));
                    roadGroup.add(dash);
                });
            }
        }

        /* Fetch real building footprints from OpenStreetMap (via the public Overpass API)
           around the junction, so the 3D city blocks are the actual buildings standing
           there rather than random boxes. Cached per ~100m grid cell and time-boxed so a
           slow/offline network never blocks the navigation UI. */
        async function fetchRealBuildingsNear(lat, lng) {
            const cacheKey = lat.toFixed(3) + ',' + lng.toFixed(3);
            if (jctBuildingCache.has(cacheKey)) return jctBuildingCache.get(cacheKey);

            const radius = 150;
            const dLat = radius / 111320;
            const dLng = radius / (111320 * Math.cos(lat * Math.PI / 180));
            const south = lat - dLat, north = lat + dLat, west = lng - dLng, east = lng + dLng;
            const query = `[out:json][timeout:5];(way["building"](${south},${west},${north},${east}););out geom;`;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            try {
                const res = await fetch('https://overpass-api.de/api/interpreter', {
                    method: 'POST',
                    body: 'data=' + encodeURIComponent(query),
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
                const data = await res.json();
                const buildings = (data.elements || [])
                    .filter(el => el.type === 'way' && el.geometry && el.geometry.length >= 3)
                    .map(el => ({ geometry: el.geometry, tags: el.tags || {} }));
                jctBuildingCache.set(cacheKey, buildings);
                return buildings;
            } catch (err) {
                clearTimeout(timeoutId);
                console.log('Real building data unavailable, using fallback city blocks:', err);
                return null;
            }
        }

        function estimateBuildingHeight(tags) {
            if (tags.height) {
                const h = parseFloat(tags.height);
                if (!isNaN(h) && h > 0) return h;
            }
            if (tags['building:levels']) {
                const lv = parseFloat(tags['building:levels']);
                if (!isNaN(lv) && lv > 0) return lv * 3.2;
            }
            return 6 + Math.random() * 14; // typical low/mid-rise, used only when OSM has no height data
        }

        function renderRealBuildings(buildings, anchorLat, anchorLng, bearingDeg) {
            let rendered = 0;
            for (const b of buildings) {
                if (rendered >= 40) break;
                const shapePts = [];
                let withinRange = false;
                for (const node of b.geometry) {
                    const { x, z } = projectToLocalXZ(node.lat, node.lon, anchorLat, anchorLng, bearingDeg);
                    if (Math.abs(x) < 90 && z > -170 && z < 60) withinRange = true;
                    shapePts.push({ x, y: -z });
                }
                if (!withinRange || shapePts.length < 3) continue;
                if (shapePts.every(p => Math.abs(p.x) < 5.5)) continue; // sits on the road itself

                const shape = new THREE.Shape();
                shape.moveTo(shapePts[0].x, shapePts[0].y);
                for (let i = 1; i < shapePts.length; i++) shape.lineTo(shapePts[i].x, shapePts[i].y);
                shape.closePath();

                const height = estimateBuildingHeight(b.tags);
                const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
                const isResidential = (b.tags.building === 'house' || b.tags.building === 'residential');
                const mat = new THREE.MeshStandardMaterial({
                    color: isResidential ? 0x1e2a3f : (rendered % 2 === 0 ? 0x0f172a : 0x1a1f36),
                    roughness: 0.55,
                    metalness: 0.1
                });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.rotation.x = -Math.PI / 2;
                buildingGroup.add(mesh);

                // Faint edge highlight, evoking lit window lines on the real facade
                const edges = new THREE.EdgesGeometry(geo);
                const edgeLines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.25 }));
                edgeLines.rotation.x = -Math.PI / 2;
                buildingGroup.add(edgeLines);

                rendered++;
            }
            if (rendered === 0) renderProceduralFallbackBuildings();
        }

        /* Used only when real OpenStreetMap building data can't be fetched (offline, or the
           Overpass API is unreachable) so the junction view still has some city context. */
        function renderProceduralFallbackBuildings() {
            for (let i = -3; i <= 3; i++) {
                if (i === 0) continue;
                const h = 15 + Math.abs(i) * 10 + Math.random() * 15;
                const bGeo = new THREE.BoxGeometry(10, h, 10);
                const bMat = new THREE.MeshStandardMaterial({
                    color: i % 2 === 0 ? 0x0f172a : 0x1e1b4b,
                    roughness: 0.3
                });
                const bMesh = new THREE.Mesh(bGeo, bMat);
                bMesh.position.set(i * 22, h / 2, -10 - Math.abs(i) * 15);
                buildingGroup.add(bMesh);
            }
        }

        /* Rebuild the 3D junction scene for the given point along the real route:
           road + lane markings come straight from the OSRM geometry already being
           driven, and buildings are fetched from live OpenStreetMap data so the scene
           reflects the actual terrain around that junction rather than an invented one. */
        async function updateJunction3DScene(stepIdx, stepName) {
            if (!roadGroup || !buildingGroup || !simCoords || simCoords.length === 0) return;

            const requestToken = ++jctRequestToken;
            const [anchorLat, anchorLng] = simCoords[stepIdx];
            const p2 = simCoords[Math.min(stepIdx + 3, simCoords.length - 1)];
            const bearingDeg = calculateBearing(anchorLat, anchorLng, p2[0], p2[1]);

            while (roadGroup.children.length > 0) roadGroup.remove(roadGroup.children[0]);
            buildRealRoadFromRoute(stepIdx, anchorLat, anchorLng, bearingDeg);

            while (buildingGroup.children.length > 0) buildingGroup.remove(buildingGroup.children[0]);
            renderProceduralFallbackBuildings(); // instant placeholder while the real data loads

            const buildings = await fetchRealBuildingsNear(anchorLat, anchorLng);
            if (requestToken !== jctRequestToken) return; // driver has moved on to a different junction

            while (buildingGroup.children.length > 0) buildingGroup.remove(buildingGroup.children[0]);
            if (buildings && buildings.length > 0) {
                renderRealBuildings(buildings, anchorLat, anchorLng, bearingDeg);
            } else {
                renderProceduralFallbackBuildings();
            }

            const signTextElem = document.getElementById('jct-sign-text');
            if (signTextElem) signTextElem.innerText = stepName;
        }

        function createOverheadGantry() {
            const gantryGroup = new THREE.Group();
            const poleGeo = new THREE.CylinderGeometry(0.3, 0.3, 12);
            const poleMat = new THREE.MeshStandardMaterial({ color: 0x64748b });

            const leftPole = new THREE.Mesh(poleGeo, poleMat);
            leftPole.position.set(-10, 6, 0);

            const rightPole = new THREE.Mesh(poleGeo, poleMat);
            rightPole.position.set(10, 6, 0);

            const beamGeo = new THREE.BoxGeometry(22, 0.6, 0.6);
            const beam = new THREE.Mesh(beamGeo, poleMat);
            beam.position.set(0, 11.5, 0);

            gantryGroup.add(leftPole);
            gantryGroup.add(rightPole);
            gantryGroup.add(beam);
            gantryGroup.position.set(0, 0, -15);
            threeScene.add(gantryGroup);
        }

        function resizeJunction3D() {
            const container = document.getElementById('three-jct-canvas-container');
            if (container && threeRenderer && threeCamera) {
                const w = container.clientWidth || 300;
                const h = container.clientHeight || 250;
                threeCamera.aspect = w / h;
                threeCamera.updateProjectionMatrix();
                threeRenderer.setSize(w, h);
            }
        }

        function update3DCameraPosition() {
            const viewName = document.getElementById('camera-view-name');
            if (camera3DViewMode === 'OVERHEAD') {
                threeCamera.position.set(0, 22, 38);
                threeCamera.lookAt(0, 2, -25);
                if (viewName) viewName.innerText = 'ドローン視点';
            } else {
                threeCamera.position.set(0, 3.5, 18);
                threeCamera.lookAt(0, 4, -30);
                if (viewName) viewName.innerText = 'ドライバー視点';
            }
        }

        function toggle3DCameraView() {
            playBeep();
            camera3DViewMode = camera3DViewMode === 'OVERHEAD' ? 'DRIVER' : 'OVERHEAD';
            update3DCameraPosition();
        }

        function animateThreeJS() {
            requestAnimationFrame(animateThreeJS);
            if (threeRenderer && threeScene && threeCamera) {
                threeRenderer.render(threeScene, threeCamera);
            }
        }

        /* Check junction approach and update realistic 3D Graphics based on route geometry */
        // NEW: turn OSRM's maneuver type/modifier into a natural Japanese instruction
        function maneuverToText(step) {
            if (!step || !step.maneuver) return '直進';
            const { type, modifier } = step.maneuver;
            const modifierText = {
                'left': '左折', 'right': '右折',
                'slight left': '斜め左方向', 'slight right': '斜め右方向',
                'sharp left': '鋭角に左折', 'sharp right': '鋭角に右折',
                'uturn': 'Uターン', 'straight': '直進'
            }[modifier] || '直進';

            if (type === 'arrive') return '目的地に到着';
            if (type === 'depart') return '出発';
            if (type === 'roundabout' || type === 'rotary') return 'ラウンドアバウトを通過';
            if (type === 'merge') return `${modifierText}して本線に合流`;
            if (type === 'on ramp') return 'ランプウェイに進入';
            if (type === 'off ramp') return 'ランプウェイで出口へ';
            if (type === 'fork') return `${modifierText}方向へ分岐`;
            if (type === 'end of road') return `道路の突き当りを${modifierText}`;
            if (type === 'continue' || type === 'new name') return '直進';
            return modifierText;
        }

        // NEW: how far (meters) until the upcoming maneuver, based on real route distances
        // rather than array-index heuristics. Returns the step describing that maneuver too.
        function getDistanceToNextManeuver() {
            if (!simSteps.length || simStepCumDistM.length < 2) {
                return { distToNextManeuverM: Infinity, upcomingStepIdx: -1, upcomingStep: null };
            }
            let idx = 0;
            while (idx < simStepCumDistM.length - 2 && simStepCumDistM[idx + 1] <= simTraveledM) idx++;
            const nextBoundaryM = simStepCumDistM[idx + 1];
            const upcomingStepIdx = idx + 1;
            return {
                distToNextManeuverM: Math.max(0, nextBoundaryM - simTraveledM),
                upcomingStepIdx,
                upcomingStep: simSteps[upcomingStepIdx] || null
            };
        }

        // NEW: cache of reverse-geocoded landmark/intersection names near each maneuver point,
        // keyed by step index, so we only hit Nominatim once per maneuver rather than every frame.
        const jctLandmarkCache = {};
        function fetchJunctionLandmarkName(stepIdx, lat, lon) {
            if (jctLandmarkCache[stepIdx] !== undefined) return; // already fetched (or in flight)
            jctLandmarkCache[stepIdx] = null; // mark in-flight so we don't fire duplicate requests
            fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=17&addressdetails=1`)
                .then(res => res.json())
                .then(data => {
                    const addr = data.address || {};
                    // Prefer a human landmark-ish name over raw house numbers
                    const landmark = addr.neighbourhood || addr.suburb || addr.road || data.name || null;
                    jctLandmarkCache[stepIdx] = landmark;
                    // If we're still approaching this exact maneuver, refresh the banner now that we have a name
                    if (upcomingLandmarkStepIdx === stepIdx) {
                        const titleEl = document.getElementById('jct-title');
                        if (titleEl && landmark) titleEl.innerText = `${landmark} を${lastJctInstructionText || ''}`;
                    }
                })
                .catch(() => { jctLandmarkCache[stepIdx] = null; });
        }
        let upcomingLandmarkStepIdx = -1;
        let lastJctInstructionText = '';

        function checkJunctionApproach() {
            const jctBox = document.getElementById('junction-3d-container');
            const jctDistEl = document.getElementById('jct-distance');
            const bannerNextTurn = document.getElementById('banner-next-turn');
            const { distToNextManeuverM, upcomingStepIdx, upcomingStep } = getDistanceToNextManeuver();

            const instructionText = upcomingStep ? maneuverToText(upcomingStep) : '直進';
            const roadName = (upcomingStep && upcomingStep.name) ? upcomingStep.name : '道なり';
            const isHighway = !!(upcomingStep && upcomingStep.ref);

            // Top banner: always show the real upcoming instruction + real remaining distance
            if (bannerNextTurn) {
                bannerNextTurn.innerText = isFinite(distToNextManeuverM)
                    ? `${distToNextManeuverM >= 1000 ? (distToNextManeuverM / 1000).toFixed(1) + 'km' : Math.round(distToNextManeuverM) + 'm'} 先 ${instructionText}${roadName !== '道なり' ? ' (' + roadName + ')' : ''}`
                    : roadName;
            }

            // NEW: realistic multi-stage voice guidance — real car nav systems announce a maneuver
            // several times as you approach (further out on highways/main roads, closer on local
            // streets), not just once. Each stage fires exactly once per maneuver.
            if (upcomingStepIdx >= 0 && upcomingStep) {
                if (upcomingStepIdx !== lastAnnouncedStepIdx.far && isHighway && distToNextManeuverM <= 1000 && distToNextManeuverM > 500) {
                    speakGuidance(`この先1キロメートルで、${roadName !== '道なり' ? roadName + '、' : ''}${instructionText}です。`);
                    lastAnnouncedStepIdx.far = upcomingStepIdx;
                } else if (upcomingStepIdx !== lastAnnouncedStepIdx.mid && distToNextManeuverM <= (isHighway ? 500 : 300) && distToNextManeuverM > 150) {
                    const distText = distToNextManeuverM >= 1000 ? `${(distToNextManeuverM / 1000).toFixed(1)}キロメートル` : `${Math.round(distToNextManeuverM / 10) * 10}メートル`;
                    speakGuidance(`およそ${distText}先、${instructionText}です。`);
                    lastAnnouncedStepIdx.mid = upcomingStepIdx;
                } else if (upcomingStepIdx !== lastAnnouncedStepIdx.near && distToNextManeuverM <= 150 && distToNextManeuverM > 40) {
                    speakGuidance(`まもなく${instructionText}です。`);
                    lastAnnouncedStepIdx.near = upcomingStepIdx;
                } else if (upcomingStepIdx !== lastAnnouncedStepIdx.now && distToNextManeuverM <= 40) {
                    speakGuidance(`${instructionText}です。`);
                    lastAnnouncedStepIdx.now = upcomingStepIdx;
                }
            }

            // NEW: once we've just passed a maneuver and the next one is far away, give the
            // "you're clear for a while" confirmation real nav systems give on long straight stretches
            if (upcomingStepIdx >= 0 && upcomingStepIdx !== lastLongStraightAnnounceIdx &&
                distToNextManeuverM > 1500 && upcomingStepIdx !== lastAnnouncedStepIdx.far &&
                upcomingStepIdx !== lastAnnouncedStepIdx.mid) {
                const distText = distToNextManeuverM >= 1000 ? `約${(distToNextManeuverM / 1000).toFixed(1)}キロメートル` : `${Math.round(distToNextManeuverM)}メートル`;
                speakGuidance(`しばらく道なりです。${distText}先、${instructionText}の予定です。`);
                lastLongStraightAnnounceIdx = upcomingStepIdx;
            }

            if (!enable3DJunction || !jctBox) return;

            if (isFinite(distToNextManeuverM) && distToNextManeuverM < 220 && distToNextManeuverM > 0) {
                if (jctDistEl) jctDistEl.innerText = `あと ${Math.round(distToNextManeuverM)}m (実地形追従3D)`;
                lastJctInstructionText = instructionText;
                upcomingLandmarkStepIdx = upcomingStepIdx;
                if (jctBox.classList.contains('hidden')) {
                    jctBox.classList.remove('hidden');
                    setTimeout(resizeJunction3D, 50);
                    updateJunction3DScene(simIndex, roadName);
                    // NEW: try to show a real, reverse-geocoded landmark/intersection name (like a
                    // genuine car nav's junction sign) instead of just the OSM road name; falls back
                    // to the road name immediately while the lookup is in flight.
                    document.getElementById('jct-title').innerText = `${roadName} を${instructionText}`;
                    if (upcomingStep && simCoords[simIndex]) {
                        const [lat, lon] = simCoords[simIndex];
                        const cached = jctLandmarkCache[upcomingStepIdx];
                        if (cached) {
                            document.getElementById('jct-title').innerText = `${cached} を${instructionText}`;
                        } else if (cached === undefined) {
                            fetchJunctionLandmarkName(upcomingStepIdx, lat, lon);
                        }
                    }
                }
            } else {
                jctBox.classList.add('hidden');
            }
        }

        /* ====================================================================
           APPLE MUSIC & MULTI-AUDIO PLAYER INTEGRATION ENGINE
           ==================================================================== */
        function openCarPlayAudio(source = 'applemusic') {
            playBeep();
            closeTConnectMenu();
            switchAudioSource(source);
            document.getElementById('carplay-overlay').classList.remove('hidden');
        }

        function closeCarPlayOverlay() {
            playBeep();
            document.getElementById('carplay-overlay').classList.add('hidden');
        }

        function switchAudioSource(source) {
            playBeep();
            currentAudioSource = source;
            const trackText = document.getElementById('top-audio-track');
            const icon = document.getElementById('mini-audio-icon');
            const urlDisplay = document.getElementById('player-current-url');

            // Reset App Button Styles
            ['applemusic', 'radio'].forEach(s => {
                const btn = document.getElementById(`app-btn-${s}`);
                if (btn) btn.className = 'w-full p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left text-xs font-bold text-slate-300 flex items-center gap-2';
            });

            if (source === 'applemusic') {
                // NOTE: a normal music.apple.com page refuses to be shown inside an <iframe> (it sends
                // X-Frame-Options / CSP headers that block framing), which is why Apple Music used to show
                // a blank page here. Apple's official "embed.music.apple.com" player is built specifically
                // to be embedded, so that's what we load by default.
                const targetUrl = appleMusicCurrentEmbedUrl || DEFAULT_APPLE_MUSIC_EMBED;
                const realUrl = appleMusicCurrentRealUrl || DEFAULT_APPLE_MUSIC_REAL;
                setAudioFallbackContent({
                    icon: 'error',
                    color: 'text-pink-400',
                    text: 'ネットワーク環境によりApple Musicの埋め込みプレーヤーを表示できません。下のボタンから直接お楽しみください。',
                    linkHref: 'https://music.apple.com/jp/new',
                    linkText: '別タブでApple Musicを開く',
                    linkBg: 'bg-pink-600 hover:bg-pink-500'
                });
                loadEmbeddedPlayer(targetUrl, realUrl);
                trackText.innerText = "Apple Music - " + (appleMusicCurrentLabel || "ドライブソング: J-Pop ヒッツ");
                icon.className = "fa-brands fa-apple text-pink-400";
                if (urlDisplay) urlDisplay.innerText = targetUrl;
                document.getElementById('audio-external-link').href = realUrl;
                document.getElementById('audio-external-link-text').innerText = '別タブでApple Musicを開く';
                document.getElementById('app-btn-applemusic').className = 'w-full p-2.5 rounded-xl bg-pink-950/80 border border-pink-500 text-left text-xs font-bold text-pink-200 flex items-center gap-2 shadow';
            } else if (source === 'radio') {
                // NOTE: TuneIn's "/embed/player/" URLs are their OFFICIAL embeddable widget product
                // (this is literally what their own "Share → Embed" feature generates), so unlike a
                // normal station website, it's actually designed to work inside an <iframe> — this is
                // why we switched to it. Streaming: NHK FM (Tokyo), via TuneIn.
                const targetUrl = "https://tunein.com/embed/player/s135065/";
                const realUrl = "https://tunein.com/radio/NHK-FM-825-s135065/";
                setAudioFallbackContent({
                    icon: 'radio',
                    color: 'text-red-400',
                    text: 'ネットワーク環境によりラジオの埋め込みプレーヤーを表示できません。下のボタンから直接お楽しみください。',
                    linkHref: realUrl,
                    linkText: '別タブでラジオを開いて再生',
                    linkBg: 'bg-red-600 hover:bg-red-500'
                });
                loadEmbeddedPlayer(targetUrl, realUrl);
                trackText.innerText = "ラジオ (NHK FM) - 再生中";
                icon.className = "material-symbols-filled text-red-400";
                icon.innerText = "radio";
                if (urlDisplay) urlDisplay.innerText = realUrl;
                document.getElementById('audio-external-link').href = realUrl;
                document.getElementById('audio-external-link-text').innerText = '別タブでラジオを開く';
                document.getElementById('app-btn-radio').className = 'w-full p-2.5 rounded-xl bg-red-950/80 border border-red-500 text-left text-xs font-bold text-red-200 flex items-center gap-2 shadow';
            }
        }

        // NEW: fills in the generic fallback panel (icon/message/external link) for whichever
        // audio source is currently active, so the same panel works for Apple Music and the radio.
        function setAudioFallbackContent({ icon, color, text, linkHref, linkText, linkBg }) {
            const iconEl = document.getElementById('audio-fallback-icon');
            const textEl = document.getElementById('audio-fallback-text');
            const linkEl = document.getElementById('audio-fallback-link');
            const linkTextEl = document.getElementById('audio-fallback-link-text');
            if (iconEl) { iconEl.innerText = icon; iconEl.className = `material-symbols-filled text-5xl ${color}`; }
            if (textEl) textEl.innerText = text;
            if (linkEl) { linkEl.href = linkHref; linkEl.className = `mt-1 py-2 px-4 ${linkBg} rounded-xl font-bold text-xs text-white flex items-center gap-2 shadow`; }
            if (linkTextEl) linkTextEl.innerText = linkText;
        }

        /* ---- Apple Music embed helpers ----
           embed.music.apple.com is Apple's own embeddable player domain (unlike a normal
           music.apple.com page, it is designed to be shown inside an <iframe> and does not
           block framing), so it's what powers the in-app "Apple Music" screen. */
        const DEFAULT_APPLE_MUSIC_EMBED = "https://embed.music.apple.com/jp/playlist/%E3%83%89%E3%83%A9%E3%82%A4%E3%83%96%E3%82%BD%E3%83%B3%E3%82%B0-j-pop-%E3%83%92%E3%83%83%E3%83%84/pl.d9ad642a094348a1af7c70185c4892bd";
        const DEFAULT_APPLE_MUSIC_REAL = "https://music.apple.com/jp/playlist/%E3%83%89%E3%83%A9%E3%82%A4%E3%83%96%E3%82%BD%E3%83%B3%E3%82%B0-j-pop-%E3%83%92%E3%83%83%E3%83%84/pl.d9ad642a094348a1af7c70185c4892bd";
        let appleMusicCurrentEmbedUrl = DEFAULT_APPLE_MUSIC_EMBED;
        let appleMusicCurrentRealUrl = DEFAULT_APPLE_MUSIC_REAL;
        let appleMusicCurrentLabel = "ドライブソング: J-Pop ヒッツ";
        let appleMusicLoadTimer = null;

        // Generic embedded-player loader used by both Apple Music and the radio stream. Some sites (like it
        // in particular) are very likely to block framing outright via X-Frame-Options/CSP, so
        // `assumeBlocked` skips the wait-and-hope timeout and shows the (fully working) external-
        // link fallback immediately, while still trying the iframe in the background at no cost.
        function loadEmbeddedPlayer(embedUrl, realUrl, { assumeBlocked = false } = {}) {
            const iframe = document.getElementById('audio-player-iframe');
            if (!iframe) return;

            const extLink = document.getElementById('audio-external-link');
            if (extLink && realUrl) extLink.href = realUrl;

            if (appleMusicLoadTimer) clearTimeout(appleMusicLoadTimer);

            if (assumeBlocked) {
                showAudioEmbedFallback();
                iframe.onload = null;
                iframe.onerror = null;
                iframe.src = embedUrl;
                return;
            }

            hideAudioEmbedFallback();
            iframe.onload = () => { if (appleMusicLoadTimer) clearTimeout(appleMusicLoadTimer); };
            iframe.onerror = () => showAudioEmbedFallback();
            iframe.src = embedUrl;

            // Belt-and-braces: if the embed hasn't loaded within a few seconds
            // (offline, blocked network, etc.), fall back to a direct link instead
            // of leaving a permanently blank player.
            appleMusicLoadTimer = setTimeout(() => {
                try {
                    if (!iframe.contentWindow) showAudioEmbedFallback();
                } catch (e) { /* cross-origin access is expected & fine, embed loaded */ }
            }, 6000);
        }

        function showAudioEmbedFallback() {
            const fb = document.getElementById('audio-embed-fallback');
            if (fb) fb.classList.remove('hidden');
        }
        function hideAudioEmbedFallback() {
            const fb = document.getElementById('audio-embed-fallback');
            if (fb) fb.classList.add('hidden');
        }

        // NEW FEATURE: Playlist favorites management
        let myPlaylists = [];
        function togglePlaylistFavorite(label, embedUrl, realUrl, btn) {
            playBeep();
            const idx = myPlaylists.findIndex(p => p.label === label);
            if (idx >= 0) {
                myPlaylists.splice(idx, 1);
                if (btn) btn.classList.remove('text-amber-300');
            } else {
                myPlaylists.push({ label, embedUrl, realUrl });
                if (btn) btn.classList.add('text-amber-300');
            }
        }

        function openMyPlaylistsModal() {
            playBeep();
            const body = myPlaylists.length ? myPlaylists.map(p => `
                <button onclick="closeModal(); navigateAppleMusic('${p.embedUrl}', '${p.realUrl}', '${p.label.replace(/'/g, "\\'")}')" class="w-full p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-left text-xs font-bold text-white flex items-center gap-2 mb-1.5 border border-slate-700">
                    <span class="material-symbols-filled text-amber-400 text-base">star</span> ${p.label}
                </button>
            `).join('') : '<div class="text-xs text-slate-400 p-2">クイックリンクの★ボタンからプレイリストをお気に入り登録できます。</div>';
            openCustomModal('マイプレイリスト', body);
        }

        function navigateAppleMusic(embedUrl, realUrl, label) {
            playBeep();
            appleMusicCurrentEmbedUrl = embedUrl || DEFAULT_APPLE_MUSIC_EMBED;
            appleMusicCurrentRealUrl = realUrl || DEFAULT_APPLE_MUSIC_REAL;
            appleMusicCurrentLabel = label || "Apple Music";
            if (currentAudioSource !== 'applemusic') {
                switchAudioSource('applemusic');
                return;
            }
            loadEmbeddedPlayer(appleMusicCurrentEmbedUrl, appleMusicCurrentRealUrl);
            const trackText = document.getElementById('top-audio-track');
            if (trackText) trackText.innerText = "Apple Music - " + appleMusicCurrentLabel;
            const urlDisplay = document.getElementById('player-current-url');
            if (urlDisplay) urlDisplay.innerText = appleMusicCurrentEmbedUrl;
        }

        function refreshAudioIframe() {
            playBeep();
            const iframe = document.getElementById('audio-player-iframe');
            if (iframe) iframe.src = iframe.src;
        }

        // NEW FEATURE: Favorites & Recent Destinations (in-memory this session)
        let favoriteDestinations = [
            { name: '東京タワー', lat: 35.6586, lon: 139.7454 },
            { name: '横浜赤レンガ倉庫', lat: 35.4527, lon: 139.6425 }
        ];
        let recentDestinations = [];
        // NEW FEATURE: Traffic Avoidance preference (affects AI route narrative only, this is a UI sim)
        let trafficAvoidanceOn = true;

        function toggleTrafficAvoidance(btn) {
            playBeep();
            trafficAvoidanceOn = !trafficAvoidanceOn;
            btn.className = trafficAvoidanceOn
                ? 'p-2 rounded-xl bg-emerald-900/80 border border-emerald-400 text-center font-bold text-xs text-emerald-200 flex items-center justify-center gap-1'
                : 'p-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-center font-bold text-xs text-slate-400 flex items-center justify-center gap-1';
            btn.querySelector('span.tag').innerText = trafficAvoidanceOn ? '渋滞回避: ON' : '渋滞回避: OFF';
            speakGuidance(trafficAvoidanceOn ? '渋滞回避ルートを優先します。' : '渋滞回避を解除しました。');
        }

        function addFavorite(name, lat, lon) {
            playBeep();
            if (!favoriteDestinations.some(f => f.name === name)) {
                favoriteDestinations.unshift({ name, lat, lon });
            }
            openDestinationModal();
        }

        function removeFavorite(name) {
            playBeep();
            favoriteDestinations = favoriteDestinations.filter(f => f.name !== name);
            openDestinationModal();
        }

        function renderFavoritesAndHistory() {
            const favHtml = favoriteDestinations.map(f => `
                <div class="flex items-center gap-1">
                    <button onclick="setQuickDestination('${f.name}', ${f.lat}, ${f.lon})" class="flex-1 p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-left border border-slate-700 flex items-center gap-2 min-w-0">
                        <span class="material-symbols-filled text-amber-400 text-sm">star</span>
                        <span class="font-bold text-xs text-white truncate">${f.name}</span>
                    </button>
                    <button onclick="removeFavorite('${f.name}')" class="p-2 rounded-xl bg-slate-800 hover:bg-red-900 border border-slate-700 text-slate-400 hover:text-red-300" title="お気に入り解除">
                        <span class="material-symbols-filled text-sm">close</span>
                    </button>
                </div>
            `).join('') || '<div class="text-[10px] text-slate-500 p-1">お気に入りはありません</div>';

            const histHtml = recentDestinations.slice(0, 4).map(h => `
                <button onclick="setQuickDestination('${h.name}', ${h.lat}, ${h.lon})" class="w-full p-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-left border border-slate-700 flex items-center gap-2">
                    <span class="material-symbols-filled text-slate-400 text-sm">history</span>
                    <span class="font-bold text-xs text-slate-200 truncate">${h.name}</span>
                </button>
            `).join('') || '<div class="text-[10px] text-slate-500 p-1">最近の目的地はありません</div>';

            return { favHtml, histHtml };
        }

        function openDestinationModal() {
            playBeep();
            const { favHtml, histHtml } = renderFavoritesAndHistory();
            const body = `
                <div class="space-y-4">
                    <!-- M3 filled text fields: 出発地 / 経由地 / 目的地 -->
                    <div class="space-y-3">
                        <div class="flex items-center gap-2">
                            <div class="flex-1">
                                <label class="block text-[11px] font-bold tracking-wide text-emerald-400 mb-1 ml-1">出発地</label>
                                <div class="flex items-center gap-2 bg-slate-800 rounded-2xl pl-4 pr-2 py-1 border border-slate-700 focus-within:border-emerald-400 transition">
                                    <span class="material-symbols-filled text-emerald-400 text-lg">trip_origin</span>
                                    <input id="origin-input" type="text" placeholder="現在地 (空欄時) または任意の場所" class="flex-1 bg-transparent py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none">
                                    <button onclick="searchLocation('origin')" class="w-11 h-11 shrink-0 rounded-full bg-emerald-600 hover:bg-emerald-500 active:scale-95 transition flex items-center justify-center text-white shadow" title="検索">
                                        <span class="material-symbols-filled text-lg">search</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div id="origin-search-results" class="space-y-2"></div>

                        <!-- NEW FEATURE: optional single waypoint ("経由地") -->
                        <div class="flex items-center gap-2">
                            <div class="flex-1">
                                <label class="block text-[11px] font-bold tracking-wide text-amber-400 mb-1 ml-1">経由地(任意)</label>
                                <div class="flex items-center gap-2 bg-slate-800 rounded-2xl pl-4 pr-2 py-1 border border-slate-700 focus-within:border-amber-400 transition">
                                    <span class="material-symbols-filled text-amber-400 text-lg">alt_route</span>
                                    <input id="via-input" type="text" placeholder="例: コンビニ, 道の駅" value="${viaPointName}" class="flex-1 bg-transparent py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none">
                                    ${viaPoint ? '<button onclick="clearViaPoint()" class="w-11 h-11 shrink-0 rounded-full bg-slate-700 hover:bg-slate-600 active:scale-95 transition flex items-center justify-center text-white" title="経由地を削除"><span class="material-symbols-filled text-lg">close</span></button>' : ''}
                                    <button onclick="searchLocation('via')" class="w-11 h-11 shrink-0 rounded-full bg-amber-600 hover:bg-amber-500 active:scale-95 transition flex items-center justify-center text-white shadow" title="検索">
                                        <span class="material-symbols-filled text-lg">search</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div id="via-search-results" class="space-y-2"></div>

                        <!-- Free Destination Search Input -->
                        <div class="flex items-center gap-2">
                            <div class="flex-1">
                                <label class="block text-[11px] font-bold tracking-wide text-red-400 mb-1 ml-1">目的地</label>
                                <div class="flex items-center gap-2 bg-slate-800 rounded-2xl pl-4 pr-2 py-1 border border-slate-700 focus-within:border-red-400 transition">
                                    <span class="material-symbols-filled text-red-400 text-lg">location_on</span>
                                    <input id="dest-input" type="text" placeholder="例: 東京タワー, 横浜赤レンガ倉庫" class="flex-1 bg-transparent py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none">
                                    <button onclick="searchLocation('dest')" class="w-11 h-11 shrink-0 rounded-full bg-red-600 hover:bg-red-500 active:scale-95 transition flex items-center justify-center text-white shadow" title="検索">
                                        <span class="material-symbols-filled text-lg">search</span>
                                    </button>
                                </div>
                            </div>
                        </div>
                        <div id="dest-search-results" class="space-y-2"></div>
                    </div>

                    <!-- AI Route Option Selector -->
                    <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800 space-y-2">
                        <div class="flex items-center justify-between">
                            <div class="text-xs font-bold text-cyan-400 flex items-center gap-1.5">
                                <span class="material-symbols-filled" >auto_awesome</span> AIルート優先モード選択
                            </div>
                            <button onclick="toggleTrafficAvoidance(this)" class="p-2 rounded-xl bg-emerald-900/80 border border-emerald-400 text-center font-bold text-xs text-emerald-200 flex items-center justify-center gap-1">
                                <span class="material-symbols-filled text-sm">traffic</span><span class="tag">渋滞回避: ON</span>
                            </button>
                        </div>
                        <div class="grid grid-cols-3 gap-2">
                            <button onclick="selectRouteType('AI推奨', this)" class="route-opt-btn active p-2 rounded-xl bg-blue-900/80 border border-blue-400 text-center font-bold text-xs text-white">
                                AI推奨
                            </button>
                            <button onclick="selectRouteType('高速優先', this)" class="route-opt-btn p-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-center font-bold text-xs text-slate-300">
                                高速優先
                            </button>
                            <button onclick="selectRouteType('ECO・景観優先', this)" class="route-opt-btn p-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-center font-bold text-xs text-slate-300">
                                ECO・景観
                            </button>
                        </div>
                    </div>

                    <!-- NEW: Favorites -->
                    <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800 space-y-1.5">
                        <div class="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                            <span class="material-symbols-filled text-sm">star</span> お気に入り地点
                        </div>
                        ${favHtml}
                    </div>

                    <!-- NEW: Recent History -->
                    <div class="bg-slate-950 p-3 rounded-2xl border border-slate-800 space-y-1.5">
                        <div class="text-xs font-bold text-slate-300 flex items-center gap-1.5">
                            <span class="material-symbols-filled text-sm">history</span> 履歴
                        </div>
                        ${histHtml}
                    </div>

                    <!-- Quick Preset Recommendations -->
                    <div class="grid grid-cols-2 gap-2">
                        <button onclick="setQuickDestination('東京タワー', 35.6586, 139.7454)" class="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-left border border-slate-700">
                            <div class="font-bold text-xs text-white">東京タワー</div>
                            <div class="text-[9px] text-slate-400">東京都港区芝公園</div>
                        </button>
                        <button onclick="setQuickDestination('国立競技場', 35.6778, 139.7137)" class="p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-left border border-slate-700">
                            <div class="font-bold text-xs text-white">国立競技場</div>
                            <div class="text-[9px] text-slate-400">東京都新宿区霞ヶ丘町</div>
                        </button>
                    </div>
                </div>
            `;
            openCustomModal('目的地＆AI経路探索', body);
        }

        let selectedRouteMode = 'AI推奨';
        function selectRouteType(mode, btn) {
            playBeep();
            selectedRouteMode = mode;
            document.querySelectorAll('.route-opt-btn').forEach(b => {
                b.className = 'route-opt-btn p-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-center font-bold text-xs text-slate-300';
            });
            btn.className = 'route-opt-btn p-2 rounded-xl bg-blue-900/80 border border-blue-400 text-center font-bold text-xs text-white';
        }

        // Escapes a string for safe interpolation inside a single-quoted inline
        // onclick="...('...')" attribute (backslashes and quotes)
        function escJs(str) {
            return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        }

        const SEARCH_TARGET_STYLE = {
            origin: { color: 'emerald', icon: 'trip_origin' },
            via: { color: 'amber', icon: 'alt_route' },
            dest: { color: 'red', icon: 'location_on' }
        };

        async function searchLocation(target) {
            playBeep();
            const inputId = target === 'origin' ? 'origin-input' : (target === 'via' ? 'via-input' : 'dest-input');
            const resId = target === 'origin' ? 'origin-search-results' : (target === 'via' ? 'via-search-results' : 'dest-search-results');
            const query = document.getElementById(inputId).value;
            if (!query) return;

            const style = SEARCH_TARGET_STYLE[target] || SEARCH_TARGET_STYLE.dest;
            const box = document.getElementById(resId);
            box.innerHTML = `<div class="text-xs text-cyan-400 p-2 font-bold flex items-center gap-2"><span class="material-symbols-filled fa-spin">progress_activity</span> 位置情報照合中...</div>`;

            try {
                const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=jp&addressdetails=1&limit=5`;
                const res = await fetch(url);
                const data = await res.json();

                if (data.length === 0) {
                    box.innerHTML = '<div class="text-xs text-red-400 p-2">候補が見つかりませんでした</div>';
                    return;
                }

                // NEW: Material 3 style candidate cards — bigger touch target, two-line
                // (name + full address) so the driver can actually tell candidates apart.
                box.innerHTML = data.map(item => {
                    const parts = item.display_name.split(',').map(p => p.trim());
                    const name = parts[0];
                    const address = parts.slice(1).join('、');
                    const category = (item.type || item.class || '').replace(/_/g, ' ');
                    return `
                    <button onclick="selectSearchResult('${target}', '${escJs(name)}', ${item.lat}, ${item.lon})" class="w-full p-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 active:scale-[0.98] transition text-left border border-slate-700 flex items-start gap-3">
                        <span class="material-symbols-filled text-${style.color}-400 text-2xl shrink-0 mt-0.5">${style.icon}</span>
                        <div class="min-w-0 flex-1">
                            <div class="font-bold text-sm text-white truncate">${name}</div>
                            <div class="text-xs text-slate-400 leading-snug mt-0.5 line-clamp-2">${address}</div>
                            ${category ? `<div class="text-[10px] text-${style.color}-400 font-bold mt-1">${category}</div>` : ''}
                        </div>
                        <span class="material-symbols-filled text-slate-600 text-lg shrink-0 mt-0.5">chevron_right</span>
                    </button>
                `;
                }).join('');
            } catch (err) {
                box.innerHTML = '<div class="text-xs text-red-400 p-2">通信エラー</div>';
            }
        }

        function selectSearchResult(target, name, lat, lon) {
            playBeep();
            if (target === 'origin') {
                originPos = [lat, lon];
                document.getElementById('origin-input').value = name;
                document.getElementById('origin-search-results').innerHTML = `<div class="text-[10px] text-emerald-400 font-bold p-1">✓ 出発地に設定: ${name}</div>`;
            } else if (target === 'via') {
                viaPoint = [lat, lon];
                viaPointName = name;
                document.getElementById('via-input').value = name;
                document.getElementById('via-search-results').innerHTML = `<div class="text-[10px] text-amber-400 font-bold p-1">✓ 経由地に設定: ${name}</div>`;
            } else {
                destinationPos = [lat, lon];
                currentDestName = name;
                recentDestinations = recentDestinations.filter(h => h.name !== name);
                recentDestinations.unshift({ name, lat, lon });
                if (recentDestinations.length > 8) recentDestinations.length = 8;
                document.getElementById('dest-input').value = name;
                closeModal();
                startAIRouteCalculationAnimation(name);
            }
        }

        function setQuickDestination(name, lat, lon) {
            playBeep();
            destinationPos = [lat, lon];
            currentDestName = name;
            recentDestinations = recentDestinations.filter(h => h.name !== name);
            recentDestinations.unshift({ name, lat, lon });
            if (recentDestinations.length > 8) recentDestinations.length = 8;
            closeModal();
            startAIRouteCalculationAnimation(name);
        }

        /* AI Route Calculation Loading Animation */
        function startAIRouteCalculationAnimation(destName) {
            playBeep();
            const body = `
                <div class="py-6 flex flex-col items-center justify-center space-y-4">
                    <div class="w-16 h-16 rounded-full bg-blue-900/60 border-2 border-cyan-400 flex items-center justify-center animate-pulse text-2xl text-cyan-300 shadow-xl">
                        <span class="material-symbols-filled" >psychology</span>
                    </div>
                    <div class="text-center space-y-1">
                        <div class="text-sm font-black text-white">AI最適経路を探索・算出中...</div>
                        <div class="text-xs text-slate-400">VICSリアルタイム渋滞 & 高速道路規制情報を照合</div>
                    </div>
                    <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden border border-slate-700">
                        <div class="bg-gradient-to-r from-blue-500 to-cyan-400 h-full w-full animate-pulse"></div>
                    </div>
                </div>
            `;
            openCustomModal('T-Connect AI 経路探索', body);

            setTimeout(() => {
                closeModal();
                calculateAndDrawRoute(destName);
            }, 1200);
        }

        function clearViaPoint() {
            playBeep();
            viaPoint = null;
            viaPointName = '';
            openDestinationModal();
        }

        async function calculateAndDrawRoute(destName = '目的地') {
            if (!destinationPos) return;
            const startPoint = originPos || currentPos;
            // NEW FEATURE: optional single waypoint ("経由地") — OSRM accepts a
            // semicolon-separated chain of coordinates and returns one continuous route
            // across all of them, with a separate `legs` entry per leg.
            const coordChain = [startPoint, ...(viaPoint ? [viaPoint] : []), destinationPos]
                .map(p => `${p[1]},${p[0]}`).join(';');
            const url = `https://router.project-osrm.org/route/v1/driving/${coordChain}?overview=full&geometries=geojson&steps=true`;
            
            try {
                const res = await fetch(url);
                const data = await res.json();
                if (!data.routes || data.routes.length === 0) return;

                const route = data.routes[0];
                simCoords = route.geometry.coordinates.map(c => [c[1], c[0]]);
                simSteps = route.legs.flatMap(leg => leg.steps); // flatten all legs (origin→via, via→dest)
                buildRouteDistanceTables();
                simTraveledM = 0;
                simCurrentSpeedMps = 0;
                simLastFrameTime = null;
                lastAnnouncedStepIdx = { far: -1, mid: -1, near: -1, now: -1 };
                lastLongStraightAnnounceIdx = -1;
                Object.keys(jctLandmarkCache).forEach(k => delete jctLandmarkCache[k]);

                if (routePolyline) map.removeLayer(routePolyline);
                routePolyline = L.polyline(simCoords, { color: '#2563eb', weight: 8, opacity: 0.9 }).addTo(map);
                map.fitBounds(routePolyline.getBounds(), { padding: [50, 50] });

                document.getElementById('top-route-banner').classList.remove('hidden');
                document.getElementById('banner-next-turn').innerText = simSteps[0]?.name || destName;
                document.getElementById('route-type-badge').innerText = selectedRouteMode;

                // NEW: keep totals around so ETA/残り距離 can be recalculated live as the drive progresses
                routeTotalDistanceM = route.distance;
                routeTotalDurationS = route.duration;
                updateEtaDisplay(1);

                // Reveal Sim Speed Controller Badge on Navigation Start
                const simSpeedBadge = document.getElementById('btn-sim-speed');
                if (simSpeedBadge) simSpeedBadge.classList.remove('hidden');

                speakGuidance(viaPoint
                    ? `AI探索完了。${viaPointName}経由、${selectedRouteMode}ルートで${destName}までの案内を開始します。`
                    : `AI探索完了。${selectedRouteMode}ルートで${destName}までの案内を開始します。`);
                startSmoothDrivingSimulation();
            } catch (err) {}
        }

        function startSmoothDrivingSimulation() {
            if (animFrameId) cancelAnimationFrame(animFrameId);
            simLastFrameTime = null;

            function animateStep(now) {
                const total = simCumDistM[simCumDistM.length - 1] || 0;

                if (simTraveledM >= total && total > 0) {
                    speakGuidance('目的地付近に到着しました。');
                    document.getElementById('junction-3d-container').classList.add('hidden');
                    simCurrentSpeedMps = 0;
                    updateSafetyMonitor(0);
                    return;
                }

                if (simLastFrameTime === null) simLastFrameTime = now;
                const dtReal = Math.min(0.25, (now - simLastFrameTime) / 1000); // clamp to avoid huge jumps (tab was backgrounded, etc.)
                simLastFrameTime = now;

                if (simSpeedMultiplier > 0) {
                    // Smoothly accelerate/decelerate the simulated vehicle toward a target speed
                    // that reacts to upcoming curves and turns, instead of jumping straight to it —
                    // and instead of the old fixed "progress per frame" that ignored real distances.
                    const targetKmh = computeTargetSpeedKmh(simTraveledM);
                    const targetMps = targetKmh / 3.6;
                    const accel = targetMps > simCurrentSpeedMps ? 2.2 : 3.4; // m/s^2 (braking is quicker than accelerating)
                    const maxDelta = accel * dtReal;
                    const diff = targetMps - simCurrentSpeedMps;
                    simCurrentSpeedMps += Math.max(-maxDelta, Math.min(maxDelta, diff));

                    // simSpeedMultiplier fast-forwards simulated time (for quickly previewing a
                    // route), the vehicle's own speed profile (and the km/h readout) stays realistic
                    simTraveledM = Math.min(total, simTraveledM + simCurrentSpeedMps * dtReal * simSpeedMultiplier);
                } else {
                    simCurrentSpeedMps = 0;
                }

                const { lat, lon, index } = getPointAtDistance(simTraveledM);
                currentPos = [lat, lon];
                simIndex = index;

                // Calculate Heading Bearing
                currentHeading = getHeadingAtDistance(simTraveledM);

                // Rotate Car Icon Arrow
                const carElem = document.getElementById('car-arrow-element');
                if (carElem) {
                    carElem.style.transform = `rotate(${currentHeading}deg)`;
                }

                carMarker.setLatLng(currentPos);
                // NEW: only auto-pan the map while in "follow" mode — once the user drags the
                // map to look around, guidance stops fighting their pan until they re-center.
                if (mapFollowMode) map.panTo(currentPos, { animate: false });

                checkJunctionApproach();
                updateSafetyMonitor(simCurrentSpeedMps);

                // Live ETA / remaining-distance readout (throttled to ~4 updates/sec)
                etaUpdateCounter++;
                if (total > 0 && etaUpdateCounter % 15 === 0) {
                    updateEtaDisplay(Math.max(0, 1 - simTraveledM / total));
                }

                animFrameId = requestAnimationFrame(animateStep);
            }
            animFrameId = requestAnimationFrame(animateStep);
        }

        /* ====================================================================
           NEW FEATURE: SAFETY DRIVING SUPPORT (Toyota Safety Sense style HUD)
           Simulated front-collision warning, lane-departure warning and
           speed-over-limit alert driven off the driving simulation loop.
           ==================================================================== */
        let safetyAssistOn = true;
        let speedLimitKmh = 60; // default matches the sim's normal straight-road cruising speed (~56km/h)
                                  // — previously this was 50, which is BELOW that, so the speed-over-limit
                                  // alert used to fire every ~6s nonstop on ordinary straight roads.
        let lastSafetyAlertAt = 0;
        const SAFETY_ALERT_COOLDOWN_MS = 6000;
        let safetyAlertCooldownMs = SAFETY_ALERT_COOLDOWN_MS;

        function setSpeedLimit(val) {
            speedLimitKmh = parseInt(val, 10);
            const limitText = document.getElementById('speed-limit-text');
            if (limitText) limitText.innerText = speedLimitKmh;
            const sliderVal = document.getElementById('speed-limit-slider-val');
            if (sliderVal) sliderVal.innerText = speedLimitKmh + 'km/h';
        }

        function toggleSafetyAssist(forcedState = null) {
            playBeep();
            safetyAssistOn = forcedState !== null ? forcedState : !safetyAssistOn;
            const label = document.getElementById('label-safety-toggle');
            if (label) label.innerText = safetyAssistOn ? '安全支援: ON' : '安全支援: OFF';
            if (!safetyAssistOn) hideSafetyHud();
            speakGuidance(safetyAssistOn ? '運転支援機能を有効にしました。' : '運転支援機能をオフにしました。');
        }

        function showSafetyHud(kind) {
            const banner = document.getElementById('safety-hud-banner');
            const inner = document.getElementById('safety-hud-inner');
            const icon = document.getElementById('safety-hud-icon');
            const text = document.getElementById('safety-hud-text');
            if (!banner) return;

            const styles = {
                collision: { cls: 'bg-red-950/95 border-red-500 text-red-200', icon: 'front_hand', label: '前方衝突注意！ブレーキ準備', voice: '前方に注意してください。' },
                lane: { cls: 'bg-amber-950/95 border-amber-400 text-amber-200', icon: 'directions_car', label: '車線逸脱を検知しました', voice: '車線がはみ出しています。ハンドル操作にご注意ください。' },
                speed: { cls: 'bg-orange-950/95 border-orange-400 text-orange-200', icon: 'speed', label: '制限速度超過', voice: '制限速度を超えています。速度を落としてください。' }
            };
            const s = styles[kind];
            if (!s) return;

            inner.className = `flex items-center gap-2 px-5 py-2 rounded-xl border-2 shadow-2xl font-black text-sm backdrop-blur ${s.cls}`;
            icon.innerText = s.icon;
            text.innerText = s.label;
            banner.classList.remove('hidden');
            playBeep('alert');
            speakGuidance(s.voice);

            // NEW: a genuine front-collision warning also triggers the dashcam's event recording,
            // the way a real drive recorder's G-sensor would — logged for the "イベント記録一覧" list.
            if (kind === 'collision') {
                dashcamEvents.unshift({ time: new Date().toLocaleString('ja-JP') });
                if (dashcamEvents.length > 20) dashcamEvents.length = 20;
            }

            clearTimeout(banner._hideTimer);
            banner._hideTimer = setTimeout(hideSafetyHud, 2600);
        }

        function hideSafetyHud() {
            const banner = document.getElementById('safety-hud-banner');
            if (banner) banner.classList.add('hidden');
        }

        function updateSafetyMonitor(currentSpeedMps = 0) {
            // Real speed readout, derived directly from the distance-based driving simulation
            // (physically consistent with how far the car marker actually moved this frame)
            const kmh = Math.max(0, Math.round(currentSpeedMps * 3.6));
            const speedText = document.getElementById('current-speed-text');
            const speedBox = document.getElementById('speed-readout-box');
            if (speedText && speedText.innerText != kmh) {
                speedText.innerText = kmh;
                speedText.classList.remove('speed-tick');
                void speedText.offsetWidth;
                speedText.classList.add('speed-tick');
            }

            const overLimit = kmh > speedLimitKmh;
            if (speedBox) {
                speedBox.className = overLimit
                    ? 'bg-red-950/95 backdrop-blur border-2 border-red-500 rounded-2xl w-16 h-16 flex flex-col items-center justify-center shadow-xl animate-pulse'
                    : 'bg-slate-900/95 backdrop-blur border-2 border-slate-700 rounded-2xl w-16 h-16 flex flex-col items-center justify-center shadow-xl';
            }

            if (!safetyAssistOn) return;
            const now = performance.now();
            if (now - lastSafetyAlertAt < safetyAlertCooldownMs) return;

            if (overLimit) {
                lastSafetyAlertAt = now;
                safetyAlertCooldownMs = SAFETY_ALERT_COOLDOWN_MS; // fixed cooldown for genuine over-limit alerts
                showSafetyHud('speed');
                return;
            }
            // Low-probability simulated ADAS events while cruising, for demo purposes — cooldown is
            // randomized (not a fixed 6s) so these don't fall into an obviously repeating cadence.
            if (simSpeedMultiplier > 0 && Math.random() < 0.0012) {
                lastSafetyAlertAt = now;
                safetyAlertCooldownMs = SAFETY_ALERT_COOLDOWN_MS + Math.random() * 8000;
                showSafetyHud(Math.random() < 0.5 ? 'collision' : 'lane');
            }
        }

        /* ====================================================================
           NEW FEATURE 1: DASHCAM LIVE FEED & HUD
           ==================================================================== */
        // NEW: dashcam event log — populated automatically whenever a collision-warning HUD
        // fires, so "event recording" actually reflects something that happened in the drive.
        let dashcamEvents = [];
        let dashcamAnimFrameId = null;

        function openDashcamModal() {
            playBeep();
            closeTConnectMenu();
            const eventsHtml = dashcamEvents.length
                ? dashcamEvents.slice(0, 5).map(e => `
                    <button onclick="alertModal('イベント記録再生', '${e.time} に記録された前方衝撃検知イベントです。前後10秒間の映像が保護されています。')" class="w-full flex items-center justify-between p-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left">
                        <span class="flex items-center gap-2 text-xs font-bold text-white"><span class="material-symbols-filled text-red-400 text-sm">warning</span> 衝撃検知イベント</span>
                        <span class="text-[10px] text-slate-400">${e.time}</span>
                    </button>
                `).join('')
                : '<div class="text-[10px] text-slate-500 p-1">記録されたイベントはありません</div>';

            const body = `
                <div class="space-y-3">
                    <div class="relative bg-black rounded-xl overflow-hidden border border-slate-800 h-52">
                        <canvas id="dashcam-canvas" class="w-full h-full block"></canvas>
                        <div class="absolute top-2 left-2 flex items-center gap-2 bg-black/70 px-2.5 py-1 rounded-full border border-red-600/80">
                            <span class="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping"></span>
                            <span class="text-[10px] font-black text-red-400">REC 1080P HD</span>
                        </div>
                        <div id="dashcam-speed-badge" class="absolute top-2 right-2 bg-black/70 px-2.5 py-1 rounded-full border border-slate-700 text-[10px] font-black text-cyan-300 digital-font">0 km/h</div>
                        <div class="absolute bottom-2 left-2 text-[10px] text-slate-300 font-mono" id="dashcam-clock">
                            ${new Date().toLocaleString('ja-JP')}
                        </div>
                    </div>
                    <div class="flex justify-between items-center bg-slate-800 p-2.5 rounded-xl border border-slate-700">
                        <span class="font-bold text-xs text-white">常時録画 & イベント衝撃録画機能</span>
                        <button onclick="alertModal('録画保存', '最新15分間のドライブレコーダー動画を保存しました。')" class="bg-red-600 hover:bg-red-500 font-bold px-3 py-1 rounded text-white text-xs">
                            手動保存
                        </button>
                    </div>
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1.5">
                        <div class="text-xs font-bold text-amber-400 flex items-center gap-1.5">
                            <span class="material-symbols-filled text-sm">event_note</span> イベント記録一覧
                        </div>
                        ${eventsHtml}
                    </div>
                </div>
            `;
            openCustomModal('トヨタドライブレコーダー', body);
            setTimeout(startDashcamFeed, 30);
        }

        // Procedural, canvas-drawn driving POV — not a real video file (which would need
        // licensing and a reliable external host), but an actually-animated road scene whose
        // speed is driven by the real driving simulation, so it moves realistically fast/slow
        // rather than sitting on a static placeholder icon.
        function startDashcamFeed() {
            const canvas = document.getElementById('dashcam-canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            let laneOffset = 0;
            let buildingOffset = 0;
            let lastTs = null;

            function resize() {
                canvas.width = canvas.clientWidth;
                canvas.height = canvas.clientHeight;
            }
            resize();

            function draw(ts) {
                if (!document.body.contains(canvas)) { dashcamAnimFrameId = null; return; } // modal closed
                if (lastTs === null) lastTs = ts;
                const dt = Math.min(0.1, (ts - lastTs) / 1000);
                lastTs = ts;

                const w = canvas.width, h = canvas.height;
                const speedMps = simCurrentSpeedMps > 0 ? simCurrentSpeedMps : 0.6; // idle drift when parked
                const speedKmh = Math.round(speedMps * 3.6);

                // Sky
                const skyGrad = ctx.createLinearGradient(0, 0, 0, h * 0.55);
                const night = mapThemeMode === 'night' || (mapThemeMode === 'auto' && (new Date().getHours() < 6 || new Date().getHours() >= 18));
                if (night) { skyGrad.addColorStop(0, '#0b1120'); skyGrad.addColorStop(1, '#1e293b'); }
                else { skyGrad.addColorStop(0, '#87ceeb'); skyGrad.addColorStop(1, '#dbeafe'); }
                ctx.fillStyle = skyGrad;
                ctx.fillRect(0, 0, w, h * 0.55);

                // Ground / road
                ctx.fillStyle = night ? '#111827' : '#3f4652';
                ctx.fillRect(0, h * 0.5, w, h * 0.5);

                // Receding buildings (both sides), scrolling with speed for parallax
                buildingOffset = (buildingOffset + speedMps * dt * 8) % 60;
                ctx.fillStyle = night ? '#1f2937' : '#94a3b8';
                for (let i = -1; i < 6; i++) {
                    const bx = i * 60 - buildingOffset;
                    const bh = 30 + ((i * 37) % 40);
                    ctx.fillRect(bx, h * 0.55 - bh, 34, bh);
                    ctx.fillRect(w - bx - 34, h * 0.55 - bh * 0.8, 34, bh * 0.8);
                }

                // Road surface (perspective trapezoid)
                ctx.fillStyle = night ? '#1e293b' : '#4b5563';
                ctx.beginPath();
                ctx.moveTo(w * 0.42, h * 0.5);
                ctx.lineTo(w * 0.58, h * 0.5);
                ctx.lineTo(w * 0.92, h);
                ctx.lineTo(w * 0.08, h);
                ctx.closePath();
                ctx.fill();

                // Center dashed lane line, scrolling toward viewer based on real simulated speed
                laneOffset = (laneOffset + speedMps * dt * 40) % 40;
                ctx.strokeStyle = '#facc15';
                ctx.lineWidth = 3;
                for (let y = h * 0.5; y < h; y += 40) {
                    const yy = y + laneOffset;
                    if (yy > h) continue;
                    const t = (yy - h * 0.5) / (h * 0.5);
                    const x = w * 0.5 - 2 + (Math.random() - 0.5) * 0; // straight for simplicity
                    ctx.beginPath();
                    ctx.moveTo(x, yy);
                    ctx.lineTo(x, Math.min(h, yy + 18 * (0.4 + t)));
                    ctx.stroke();
                }

                // Windshield vignette
                const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.8);
                vg.addColorStop(0, 'rgba(0,0,0,0)');
                vg.addColorStop(1, 'rgba(0,0,0,0.35)');
                ctx.fillStyle = vg;
                ctx.fillRect(0, 0, w, h);

                const speedBadge = document.getElementById('dashcam-speed-badge');
                if (speedBadge) speedBadge.innerText = `${speedKmh} km/h`;
                const clockEl = document.getElementById('dashcam-clock');
                if (clockEl) clockEl.innerText = new Date().toLocaleString('ja-JP');

                dashcamAnimFrameId = requestAnimationFrame(draw);
            }
            if (dashcamAnimFrameId) cancelAnimationFrame(dashcamAnimFrameId);
            dashcamAnimFrameId = requestAnimationFrame(draw);
        }

        /* ====================================================================
           NEW FEATURE 2: TOYOTA ADVANCED PARK 360° MONITOR
           ==================================================================== */
        function openAdvancedParkModal() {
            playBeep();
            closeTConnectMenu();
            const body = `
                <div class="space-y-3">
                    <div class="grid grid-cols-2 gap-2">
                        <div class="bg-slate-950 rounded-xl p-3 border border-slate-800 flex flex-col items-center justify-center h-44 relative">
                            <span class="absolute top-2 left-2 text-[10px] font-bold text-cyan-400 bg-cyan-950 px-1.5 py-0.5 rounded">360° TOP VIEW</span>
                            <span class="material-symbols-filled text-5xl text-blue-500 my-2" >directions_car</span>
                            <span class="text-[10px] text-emerald-400 font-bold">周囲障害物なし</span>
                        </div>
                        <div class="bg-slate-950 rounded-xl p-3 border border-slate-800 flex flex-col items-center justify-center h-44 relative">
                            <span class="absolute top-2 left-2 text-[10px] font-bold text-amber-400 bg-amber-950 px-1.5 py-0.5 rounded">BACK CAMERA</span>
                            <span class="material-symbols-filled text-4xl text-slate-500 my-2" >videocam</span>
                            <span class="text-[10px] text-slate-400 font-bold">駐車枠自動認識完了</span>
                        </div>
                    </div>
                    <button onclick="speakGuidance('アドバンストパークを開始します。ステアリングから手を離してください。'); closeModal();" class="w-full py-2.5 bg-gradient-to-r from-blue-600 to-cyan-500 font-extrabold text-xs text-white rounded-xl shadow">
                        <span class="material-symbols-filled mr-1" >local_parking</span> 自動駐車アシストを開始
                    </button>
                </div>
            `;
            openCustomModal('Toyota Advanced Park (360°パノラミックビュー)', body);
        }

        /* ====================================================================
           NEW FEATURE 3: DRIVE MODE SELECT (ECO / NORMAL / SPORT)
           ==================================================================== */
        function cycleDriveMode() {
            playBeep();
            const badge = document.getElementById('drive-mode-badge');
            const bezel = document.getElementById('toyota-bezel');

            if (driveMode === 'NORMAL') {
                driveMode = 'SPORT';
                badge.innerText = 'MODE: SPORT';
                badge.className = 'bg-red-900/90 border border-red-500 text-red-200 text-[10px] font-black px-2 py-0.5 rounded-full shadow hover:brightness-125';
                bezel.classList.add('sport-mode');
                speakGuidance('スポーツモードが選択されました。レスポンスを強化します。');
            } else if (driveMode === 'SPORT') {
                driveMode = 'ECO';
                badge.innerText = 'MODE: ECO';
                badge.className = 'bg-emerald-900/90 border border-emerald-500 text-emerald-200 text-[10px] font-black px-2 py-0.5 rounded-full shadow hover:brightness-125';
                bezel.classList.remove('sport-mode');
                speakGuidance('エコモードが選択されました。環境優先走行を行います。');
            } else {
                driveMode = 'NORMAL';
                badge.innerText = 'MODE: NORMAL';
                badge.className = 'bg-blue-900/80 border border-blue-500 text-cyan-200 text-[10px] font-black px-2 py-0.5 rounded-full shadow hover:brightness-125';
                bezel.classList.remove('sport-mode');
                speakGuidance('ノーマルモードに戻りました。');
            }
        }

        /* ====================================================================
           NEW FEATURE 4: AI SMART VOICE ASSISTANT DIALOGUE LOG
           ==================================================================== */
        function openVoiceLogModal() {
            playBeep();
            closeTConnectMenu();
            const body = `
                <div class="space-y-3 text-xs">
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2 max-h-52 overflow-y-auto">
                        <div class="flex items-start gap-2">
                            <span class="bg-blue-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">DRIVER</span>
                            <p class="text-slate-200">「Hey Toyota, 近くのコンビニを探して」</p>
                        </div>
                        <div class="flex items-start gap-2 bg-slate-900 p-2 rounded-lg">
                            <span class="bg-cyan-600 text-white text-[9px] font-bold px-1.5 py-0.5 rounded">AI</span>
                            <p class="text-cyan-300">「300m先にセブンイレブンがあります。目的地に設定しますか？」</p>
                        </div>
                    </div>
                    <button onclick="triggerVoiceAgent(); closeModal();" class="w-full py-2 bg-cyan-600 hover:bg-cyan-500 font-bold text-white rounded-xl">
                        新しい音声対話を開始
                    </button>
                </div>
            `;
            openCustomModal('T-Connect AI対話履歴', body);
        }

        /* ====================================================================
           NEW FEATURE 5: WEATHER & HAZARD OVERLAY TOGGLE
           ==================================================================== */
        function toggleWeatherOverlay() {
            playBeep();
            isWeatherRainActive = !isWeatherRainActive;
            const layer = document.getElementById('weather-layer');
            const desc = document.getElementById('weather-desc');
            const icon = document.getElementById('weather-icon');

            if (isWeatherRainActive) {
                layer.classList.remove('hidden');
                desc.innerText = '小雨';
                icon.className = 'material-symbols-filled text-blue-400';
                icon.innerText = 'rainy';
                speakGuidance('天候が雨に変化しました。安全運転をサポートします。');
            } else {
                layer.classList.add('hidden');
                desc.innerText = '晴れ';
                icon.className = 'material-symbols-filled text-cyan-400';
                icon.innerText = 'partly_cloudy_day';
            }
        }

        // Climate Control Helpers
        function changeDriverTemp(val) {
            playBeep();
            driverTemp = Math.min(32.0, Math.max(18.0, driverTemp + val));
            document.getElementById('driver-temp-text').innerText = driverTemp.toFixed(1);
            if (isDual) {
                passengerTemp = driverTemp;
                document.getElementById('passenger-temp-text').innerText = passengerTemp.toFixed(1);
            }
        }
        function changePassengerTemp(val) {
            playBeep();
            passengerTemp = Math.min(32.0, Math.max(18.0, passengerTemp + val));
            document.getElementById('passenger-temp-text').innerText = passengerTemp.toFixed(1);
        }
        function changeFanSpeed(val) {
            playBeep();
            fanSpeed = Math.min(5, Math.max(1, fanSpeed + val));
            for (let i = 1; i <= 5; i++) {
                const bar = document.getElementById(`fan-bar-${i}`);
                bar.className = `w-1.5 h-${i + 1} ${i <= fanSpeed ? 'bg-blue-500' : 'bg-slate-700'} rounded-sm`;
            }
        }
        function cycleVentMode() {
            playBeep();
            ventMode = (ventMode + 1) % 3;
            const modes = ['FACE / FEET', 'FACE ONLY', 'FEET ONLY'];
            document.getElementById('vent-mode-label').innerText = modes[ventMode];
        }
        function toggleAC() {
            playBeep();
            isAC = !isAC;
            const btn = document.getElementById('btn-ac-toggle');
            if (btn) {
                btn.className = isAC
                    ? 'py-2 bg-blue-600 text-white rounded-lg text-center border border-blue-400'
                    : 'py-2 bg-slate-800 text-slate-300 rounded-lg text-center border border-slate-700';
            }
            speakGuidance(isAC ? 'エアコンをオンにしました。' : 'エアコンをオフにしました。');
        }

        function toggleDual() {
            playBeep();
            isDual = !isDual;
            const btn = document.getElementById('btn-dual-toggle');
            if (btn) {
                btn.className = isDual
                    ? 'py-2 bg-blue-600 text-white rounded-lg text-center border border-blue-400'
                    : 'py-2 bg-slate-800 text-slate-300 rounded-lg text-center border border-slate-700';
            }
            // When DUAL is off, the passenger dial follows the driver's setting
            if (!isDual) {
                passengerTemp = driverTemp;
                const pText = document.getElementById('passenger-temp-text');
                if (pText) pText.innerText = passengerTemp.toFixed(1);
            }
        }

        let isEco = false;
        function toggleEcoMode() {
            playBeep();
            isEco = !isEco;
            const btn = document.getElementById('btn-eco-toggle');
            if (btn) {
                btn.className = isEco
                    ? 'py-2 bg-emerald-600 text-white rounded-lg text-center border border-emerald-400'
                    : 'py-2 bg-slate-800 text-slate-300 rounded-lg text-center border border-slate-700';
            }
            speakGuidance(isEco ? 'ECOモードを有効にしました。燃費を優先します。' : 'ECOモードを解除しました。');
        }

        let isRecirc = false;
        function toggleRecirculation() {
            playBeep();
            isRecirc = !isRecirc;
            const btn = document.getElementById('btn-recirc-toggle');
            if (btn) {
                btn.className = isRecirc
                    ? 'py-2 bg-blue-600 text-white rounded-lg text-center border border-blue-400'
                    : 'py-2 bg-slate-800 text-slate-300 rounded-lg text-center border border-slate-700';
            }
            speakGuidance(isRecirc ? '内気循環モードにしました。' : '外気導入モードにしました。');
        }

        function toggleSeatHeater() { playBeep(); }
        function openClimateOptions() { openCustomModal('エアコン詳細', '<div class="text-xs text-slate-300">nanoe X 脱臭・除菌イオン自動制御ON</div>'); }

        // Switch Dock Tabs
        function switchDockTab(tab) {
            playBeep();
            document.querySelectorAll('.dock-btn').forEach(b => b.classList.remove('active'));
            if (tab === 'audio') {
                document.getElementById('dock-audio').classList.add('active');
                openCarPlayAudio('applemusic');
            } else if (tab === 'nav') {
                document.getElementById('dock-nav').classList.add('active');
                closeCarPlayOverlay();
            } else if (tab === 'car') {
                document.getElementById('dock-car').classList.add('active');
                openVehicleInfo();
            }
        }

        function triggerVoiceAgent() {
            playBeep();
            const body = `
                <div class="space-y-3">
                    <div class="flex items-center gap-2">
                        <input id="ai-query-input" type="text" placeholder="例: 近くの美味しいラーメン屋は？" class="flex-1 bg-slate-900 border border-slate-700 rounded-xl p-2.5 text-xs text-white focus:outline-none focus:border-cyan-400" onkeydown="if(event.key==='Enter') submitAiQuery()">
                        <button onclick="startVoiceRecognition()" id="ai-mic-btn" class="w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-center text-cyan-300" title="音声入力">
                            <span class="material-symbols-filled">mic</span>
                        </button>
                        <button onclick="submitAiQuery()" class="px-4 h-10 rounded-xl bg-blue-600 hover:bg-blue-500 font-bold text-xs text-white">送信</button>
                    </div>
                    <div id="ai-response-box" class="bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-300 min-h-[60px] leading-relaxed">
                        はい、どのようなご用件でしょうか？目的地検索やエアコン設定、周辺情報の質問にお答えします。
                    </div>
                </div>
            `;
            openCustomModal('AIアシスタント (Gemini)', body);
        }

        function startVoiceRecognition() {
            playBeep();
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            const micBtn = document.getElementById('ai-mic-btn');
            if (!SR) {
                document.getElementById('ai-response-box').innerText = 'この環境では音声入力を利用できません。テキストで入力してください。';
                return;
            }
            try {
                const recog = new SR();
                recog.lang = 'ja-JP';
                recog.interimResults = false;
                micBtn.classList.add('text-red-400');
                recog.onresult = (e) => {
                    document.getElementById('ai-query-input').value = e.results[0][0].transcript;
                    submitAiQuery();
                };
                recog.onerror = () => {
                    document.getElementById('ai-response-box').innerText = '音声を認識できませんでした。テキストで入力してください。';
                };
                recog.onend = () => micBtn.classList.remove('text-red-400');
                recog.start();
            } catch (err) {
                document.getElementById('ai-response-box').innerText = 'この環境(埋め込み画面)ではマイクにアクセスできません。テキストで入力してください。';
            }
        }

        function submitAiQuery() {
            const input = document.getElementById('ai-query-input');
            const query = input.value.trim();
            if (!query) return;
            playBeep();
            const box = document.getElementById('ai-response-box');
            box.innerHTML = '<span class="material-symbols-filled fa-spin mr-1">progress_activity</span> 考え中...';

            // Give Gemini some situational context so answers feel like a real car assistant
            const context = `あなたはトヨタ車のカーナビ・AIアシスタントです。運転中に自然に読み上げられる、簡潔な日本語(2〜3文以内)で答えてください。
現在地: 緯度${currentPos[0].toFixed(4)}, 経度${currentPos[1].toFixed(4)}
目的地: ${currentDestName || '未設定'}
車内温度設定: 運転席${driverTemp}°C
質問: ${query}`;

            // GitHub Pages版: サーバーがいないのでブラウザから直接Gemini APIを叩く。
            // ⚠️ script.js 内の GEMINI_API_KEY はブラウザに丸見え(誰でもソースから読める)になります。
            // 個人の学習・文化祭用途などキーが漏れても実害が小さい前提での簡易実装です。
            // 本気で守りたい場合は Cloudflare Workers 等の無料サーバーレスプロキシを別途挟んでください。
            fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + GEMINI_API_KEY, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: context }] }],
                    generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingLevel: 'minimal' } }
                })
            })
                .then(res => res.json().then(json => ({ ok: res.ok, json })))
                .then(({ ok, json }) => {
                    if (!ok) {
                        const msg = (json.error && json.error.message) || 'HTTPエラー';
                        throw new Error(msg);
                    }
                    const text = json.candidates && json.candidates[0] && json.candidates[0].content &&
                        json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
                        json.candidates[0].content.parts[0].text;
                    box.innerText = text || '応答を取得できませんでした。';
                    if (text) speakGuidance(text);
                })
                .catch(err => {
                    box.innerText = 'エラー: AIサーバーに接続できませんでした。(' + (err && err.message ? err.message : err) + ')';
                });

            input.value = '';
        }

        // NEW FEATURE: Bluetooth hands-free call history
        const callHistory = [
            { name: '田中 部長', number: '090-XXXX-1122', type: 'incoming', time: '今日 16:40' },
            { name: '自宅', number: '03-XXXX-5566', type: 'outgoing', time: '今日 12:05' },
            { name: '不明な番号', number: '080-XXXX-9981', type: 'missed', time: '昨日 21:15' },
            { name: '鈴木さん', number: '090-XXXX-3344', type: 'outgoing', time: '昨日 09:30' }
        ];
        const callIcon = { incoming: 'call_received', outgoing: 'call_made', missed: 'call_missed' };
        const callColor = { incoming: 'text-emerald-400', outgoing: 'text-cyan-400', missed: 'text-red-400' };

        function launchCarPlayPhone() {
            playBeep();
            const body = `
                <div class="space-y-3 text-xs">
                    <div class="bg-emerald-950/80 border border-emerald-700 rounded-xl p-2.5 flex items-center gap-2">
                        <span class="material-symbols-filled text-emerald-400">bluetooth_connected</span>
                        <span class="font-bold text-emerald-200">iPhone 15 Pro と接続中</span>
                    </div>
                    <div class="font-bold text-slate-300 text-sm">発着信履歴</div>
                    <div class="space-y-1.5">
                        ${callHistory.map(c => `
                            <button onclick="redialNumber('${c.name}')" class="w-full flex items-center justify-between p-2 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left">
                                <div class="flex items-center gap-2">
                                    <span class="material-symbols-filled ${callColor[c.type]} text-base">${callIcon[c.type]}</span>
                                    <div>
                                        <div class="font-bold text-white">${c.name}</div>
                                        <div class="text-[9px] text-slate-400">${c.number}</div>
                                    </div>
                                </div>
                                <span class="text-[9px] text-slate-500">${c.time}</span>
                            </button>
                        `).join('')}
                    </div>
                </div>
            `;
            openCustomModal('ハンズフリー電話', body);
        }

        function redialNumber(name) {
            playBeep();
            alertModal('発信中...', `${name} に発信しています。`);
        }

        function openVehicleInfo() {
            playBeep();
            const body = `
                <div class="space-y-3">
                    <div class="bg-emerald-950/80 border border-emerald-800 p-3 rounded-xl flex items-center justify-between">
                        <div>
                            <div class="text-xs font-bold text-emerald-300">HYBRID SYSTEM</div>
                            <div class="text-lg font-black text-white">EV走行モード可能</div>
                        </div>
                        <span class="material-symbols-filled text-3xl text-emerald-400" >eco</span>
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-xs">
                        <div class="bg-slate-800 p-3 rounded-xl border border-slate-700">
                            <div class="text-slate-400">駆動バッテリー</div>
                            <div class="text-xl font-black text-cyan-300 digital-font">86 %</div>
                        </div>
                        <div class="bg-slate-800 p-3 rounded-xl border border-slate-700">
                            <div class="text-slate-400">平均燃費</div>
                            <div class="text-xl font-black text-emerald-300 digital-font">25.8 km/L</div>
                        </div>
                    </div>

                    <!-- NEW FEATURE: Tire Pressure Monitor (TPMS) -->
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800">
                        <div class="text-xs font-bold text-cyan-400 mb-2 flex items-center gap-1.5">
                            <span class="material-symbols-filled text-sm">tire_repair</span> タイヤ空気圧モニター (TPMS)
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                            ${tirePressures.map(t => `
                                <div class="bg-slate-800 rounded-lg p-2 border ${t.kpa < 210 ? 'border-amber-500' : 'border-slate-700'} flex items-center justify-between">
                                    <span class="text-[10px] text-slate-400 font-bold">${t.pos}</span>
                                    <span class="digital-font font-black text-sm ${t.kpa < 210 ? 'text-amber-400' : 'text-emerald-300'}">${t.kpa} kPa</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- NEW FEATURE: Fuel/Energy Economy History Graph (simple CSS bar chart) -->
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800">
                        <div class="text-xs font-bold text-emerald-400 mb-2 flex items-center gap-1.5">
                            <span class="material-symbols-filled text-sm">monitoring</span> 燃費履歴 (直近7日)
                        </div>
                        <div class="flex items-end gap-1.5 h-20">
                            ${fuelEconomyHistory.map(v => `
                                <div class="flex-1 flex flex-col items-center justify-end gap-1">
                                    <div class="w-full bg-gradient-to-t from-emerald-600 to-emerald-300 rounded-t" style="height: ${Math.round((v / 30) * 100)}%"></div>
                                    <span class="text-[8px] text-slate-500 digital-font">${v}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- NEW FEATURE: EV Charge Planning -->
                    <button onclick="openEvChargePlanModal()" class="w-full p-3 rounded-xl bg-cyan-950/80 border border-cyan-600 hover:bg-cyan-900 flex items-center justify-between">
                        <span class="text-xs font-bold text-cyan-200 flex items-center gap-1.5">
                            <span class="material-symbols-filled text-sm">ev_station</span> EV充電計画を立てる
                        </span>
                        <span class="material-symbols-filled text-cyan-400 text-sm">chevron_right</span>
                    </button>
                </div>
            `;
            openCustomModal('車両情報 / HVエネルギーモニター', body);
        }

        // NEW FEATURE: Tire pressure + fuel economy demo data
        const tirePressures = [
            { pos: '左前 (FL)', kpa: 230 },
            { pos: '右前 (FR)', kpa: 228 },
            { pos: '左後 (RL)', kpa: 205 },
            { pos: '右後 (RR)', kpa: 231 }
        ];
        const fuelEconomyHistory = [22.4, 24.1, 19.8, 26.5, 25.8, 27.2, 25.8];

        function openEvChargePlanModal() {
            playBeep();
            const body = `
                <div class="space-y-3 text-xs">
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
                        <div>
                            <div class="text-slate-400">現在バッテリー残量</div>
                            <div class="text-xl font-black text-cyan-300 digital-font">86 %</div>
                        </div>
                        <div class="text-right">
                            <div class="text-slate-400">EV航続可能距離</div>
                            <div class="text-xl font-black text-emerald-300 digital-font">62 km</div>
                        </div>
                    </div>
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2">
                        <div class="font-bold text-cyan-400 text-sm">目的地までの充電計画</div>
                        <div class="text-slate-300">現在の航続距離で目的地まで到達可能です。念のため経路上の急速充電スポットを表示できます。</div>
                        <button onclick="openNearbyPOI('ev_charge')" class="w-full py-2 rounded-xl bg-cyan-700 hover:bg-cyan-600 text-white font-bold">経路上のEV充電スポットを検索</button>
                    </div>
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1.5">
                        <div class="font-bold text-slate-300 text-sm mb-1">充電目標を設定</div>
                        <input id="ev-charge-target" type="range" min="50" max="100" step="10" value="90" oninput="document.getElementById('ev-charge-target-val').innerText = this.value + '%'" class="w-full accent-cyan-500">
                        <div class="text-right text-cyan-300 font-black digital-font" id="ev-charge-target-val">90%</div>
                    </div>
                </div>
            `;
            openCustomModal('EV充電計画', body);
        }

        function openUserSettings() {
            playBeep();
            closeTConnectMenu();
            const body = `
                <div class="space-y-3 text-xs">
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2">
                        <div class="font-bold text-cyan-400 text-sm border-b border-slate-800 pb-1">Toyota Safety Sense & 3D表示設定</div>
                        <div class="flex justify-between items-center py-1">
                            <span class="font-bold text-white">3Dジャンクション案内を有効化</span>
                            <input type="checkbox" ${enable3DJunction ? 'checked' : ''} onchange="toggle3DJunctionEnable(this.checked)" class="w-5 h-5 accent-blue-600">
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">PDA (プロアクティブドライビングアシスト)</span>
                            <input type="checkbox" checked class="w-5 h-5 accent-blue-600">
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">安全運転支援 HUD (前方衝突・車線逸脱・速度超過)</span>
                            <input type="checkbox" ${safetyAssistOn ? 'checked' : ''} onchange="toggleSafetyAssist(this.checked)" class="w-5 h-5 accent-red-600">
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">速度超過アラートしきい値</span>
                            <div class="flex items-center gap-2">
                                <input type="range" min="30" max="100" step="10" value="${speedLimitKmh}" oninput="setSpeedLimit(this.value)" class="w-24 accent-red-600">
                                <span id="speed-limit-slider-val" class="digital-font text-cyan-300 font-black w-10 text-right">${speedLimitKmh}km/h</span>
                            </div>
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">エアコン表示パネル</span>
                            <div class="flex gap-1.5">
                                <button onclick="toggleClimatePanel(true)" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold text-white">表示</button>
                                <button onclick="toggleClimatePanel(false)" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold text-white">非表示</button>
                            </div>
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">起動アニメーション</span>
                            <button onclick="closeModal(); playBootAnimation();" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold text-cyan-300 flex items-center gap-1">
                                <span class="material-symbols-filled text-xs">play_arrow</span> 再生
                            </button>
                        </div>
                    </div>
                </div>
            `;
            openCustomModal('T-Connect 設定', body);
        }

        function openDisplayChangeModal() {
            playBeep();
            const body = `
                <div class="space-y-3">
                    <div class="grid grid-cols-3 gap-2">
                        <button onclick="setMapTheme('day')" class="p-3 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold border border-slate-700 text-amber-300 text-xs">
                            <span class="material-symbols-filled text-lg mb-1 block" >light_mode</span> 昼間表示
                        </button>
                        <button onclick="setMapTheme('night')" class="p-3 rounded-xl bg-slate-800 hover:bg-slate-700 font-bold border border-slate-700 text-indigo-300 text-xs">
                            <span class="material-symbols-filled text-lg mb-1 block" >dark_mode</span> 夜間表示
                        </button>
                        <button onclick="setMapTheme('auto')" class="p-3 rounded-xl ${mapThemeMode === 'auto' ? 'bg-cyan-950/80 border-cyan-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'} font-bold border text-cyan-300 text-xs">
                            <span class="material-symbols-filled text-lg mb-1 block">routine</span> 自動切替
                        </button>
                    </div>
                    <div class="text-[10px] text-slate-500 px-1">自動切替: 6:00〜17:59は昼間表示、18:00〜5:59は夜間表示に毎分自動で切り替わります。</div>
                </div>
            `;
            openCustomModal('表示テーマ切替', body);
        }

        let mapThemeMode = 'auto'; // 'day' | 'night' | 'auto' — defaults to auto so it matches real time on first load
        function setMapTheme(theme) {
            playBeep();
            mapThemeMode = theme;
            applyMapTheme();
            closeModal();
        }

        function applyMapTheme() {
            const sc = document.getElementById('screen-container');
            if (!sc) return;
            let effective = mapThemeMode;
            if (mapThemeMode === 'auto') {
                const hour = new Date().getHours();
                effective = (hour >= 6 && hour < 18) ? 'day' : 'night';
            }
            if (effective === 'night') sc.classList.add('dark-mode-map');
            else sc.classList.remove('dark-mode-map');
        }

        function openNearbyPOI(type) {
            playBeep();
            const OVERPASS_TAGS = {
                convenience: 'shop=convenience',
                gas_station: 'amenity=fuel',
                ev_charge: 'amenity=charging_station',
                parking: 'amenity=parking'
            };
            const labelMap = { convenience: '周辺コンビニ', gas_station: 'ガソリンスタンド', ev_charge: 'EV充電スポット', parking: '周辺駐車場' };
            const label = labelMap[type] || '周辺スポット';
            const tagQuery = OVERPASS_TAGS[type] || OVERPASS_TAGS.convenience;
            const [lat, lon] = currentPos;
            const radius = 3000;
            const query = `[out:json][timeout:15];node[${tagQuery}](around:${radius},${lat},${lon});out body 12;`;
            const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);

            openCustomModal(label, `<div class="text-xs text-slate-400 p-2 flex items-center gap-2"><span class="material-symbols-filled fa-spin">progress_activity</span> 半径3km以内を検索中...</div>`);

            fetch(url)
                .then(res => res.json())
                .then(data => {
                    const pois = (data.elements || [])
                        .filter(el => el.lat && el.lon)
                        .map(el => ({
                            name: (el.tags && el.tags.name) || label,
                            lat: el.lat,
                            lon: el.lon,
                            distM: haversineM(lat, lon, el.lat, el.lon)
                        }))
                        .sort((a, b) => a.distM - b.distM)
                        .slice(0, 10);

                    if (!pois.length) {
                        openCustomModal(label, '<div class="text-xs text-slate-400 p-2">周辺3km以内に見つかりませんでした。</div>');
                        return;
                    }
                    const body = pois.map(p => `
                        <button onclick="closeModal(); setQuickDestination('${p.name.replace(/'/g, "\\'")}', ${p.lat}, ${p.lon})" class="w-full p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left flex items-center justify-between mb-1.5">
                            <span class="text-xs font-bold text-white truncate mr-2">${p.name}</span>
                            <span class="text-[10px] text-cyan-300 font-black digital-font whitespace-nowrap">${p.distM < 1000 ? Math.round(p.distM) + 'm' : (p.distM / 1000).toFixed(1) + 'km'}</span>
                        </button>
                    `).join('');
                    openCustomModal(label, body);
                })
                .catch(() => {
                    openCustomModal(label, '<div class="text-xs text-red-400 p-2">検索中にエラーが発生しました。通信環境をご確認ください。</div>');
                });
        }

        function recalculateRoute() {
            playBeep();
            if (destinationPos) calculateAndDrawRoute();
            else openDestinationModal();
        }

        function toggleSplitScreen() {
            playBeep();
            splitScreenOpen = !splitScreenOpen;
            const btn = document.getElementById('btn-split-toggle');
            const nav = document.getElementById('dock-nav');
            if (splitScreenOpen) {
                btn.classList.add('active');
                if (nav) nav.click();
                speakGuidance('スプリット画面表示に切り替えました。');
            } else {
                btn.classList.remove('active');
                speakGuidance('全画面表示に切り替えました。');
            }
        }

        function toggleTConnectMenu() { playBeep(); document.getElementById('tconnect-menu').classList.toggle('hidden'); }
        function closeTConnectMenu() { playBeep(); document.getElementById('tconnect-menu').classList.add('hidden'); }

        function openCustomModal(title, bodyHtml) {
            document.getElementById('modal-title').innerHTML = `<span class="material-symbols-filled" >info</span> ${title}`;
            document.getElementById('modal-body').innerHTML = bodyHtml;
            document.getElementById('app-modal').classList.remove('hidden');
        }

        function alertModal(title, message) {
            openCustomModal(title, `<div class="text-xs leading-relaxed text-slate-200">${message}</div>`);
        }

        function closeModal() {
            playBeep();
            document.getElementById('app-modal').classList.add('hidden');
        }
