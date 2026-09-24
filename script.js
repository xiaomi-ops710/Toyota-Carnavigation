/* ====================================================================
           TOYOTA T-CONNECT NAVIGATION & ADVANCED ENGINE
           ==================================================================== */
        // GitHub Pages版: ここに自分のGemini APIキーを直接貼り付けてください
        // (取得先: https://aistudio.google.com/app/apikey)。
        // ⚠️ 静的サイトなので、このキーは誰でもブラウザの「ページのソースを表示」で読めてしまいます。
        const GEMINI_API_KEY = 'ここにGemini APIキーを貼り付け';

        /* ====================================================================
           NEW: persisted app settings (localStorage) — Gemini APIキー / 効果音 / 起動
           アニメーションをアプリ内の「設定」画面から変更できるようにする。
           BUGFIX: previously the Gemini key could ONLY be set by hand-editing this
           source file (GEMINI_API_KEY above) and re-deploying — any mistake there (or
           simply forgetting the running page was still the old deploy) surfaced as a
           confusing "APIキーがありません" error even though the user believed it was
           configured correctly. A key entered in Settings now always takes priority.
           ==================================================================== */
        const SETTINGS_STORAGE_KEY = 'tconnectAppSettings_v1';
        let appSettings = {
            buttonSound: 'default',   // 'default' | 'soft' | 'chime' | 'off'
            navChime: 'default',      // 'default' | 'soft' | 'chime' | 'off'
            bootAnimation: 'classic', // 'classic' | 'radial' | 'minimal'
            geminiApiKey: ''          // user-supplied key, saved from the 設定 screen
        };

        function loadAppSettings() {
            try {
                const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
                if (raw) Object.assign(appSettings, JSON.parse(raw));
            } catch (e) { /* localStorage unavailable (private mode, etc.) — defaults are fine */ }
        }
        loadAppSettings();

        function saveAppSettings() {
            try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(appSettings)); } catch (e) {}
        }

        // BUGFIX: the untouched placeholder text in GEMINI_API_KEY above used to be sent to
        // Google exactly as-is whenever nobody had set a real key in Settings, which comes
        // back as an "API key not valid" error that reads like a bug rather than "you
        // haven't set a key yet". Both that placeholder and a Settings key that's just
        // whitespace are now correctly treated as "not configured".
        function getActiveGeminiApiKey() {
            const fromSettings = (appSettings.geminiApiKey || '').trim();
            if (fromSettings) return fromSettings;
            const fallback = (GEMINI_API_KEY || '').trim();
            if (!fallback || fallback === 'ここにGemini APIキーを貼り付け') return '';
            return fallback;
        }
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
        let currentRadioStationLabel = '未選択'; // NEW: radio state (Radio-Browser search based)

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

        // NEW FEATURE: renewed Toyota-style destination search front menu (category grid +
        // 特別メモリ quick-memory slots + 自宅登録) — see openDestinationCategoryMenu().
        let memorySlots = [null, null, null, null, null]; // 特別メモリ 1〜5, each {name, lat, lon} or null
        let homeLocation = null; // {name, lat, lon} once registered via 自宅登録
        let pendingMemorySlotIndex = null; // set while a search is being performed to fill a memory slot
        let activeDestScreen = 'category'; // tracks which destination-search screen is currently open, so favorite add/remove can refresh the right one

        // NEW FEATURE: JCT/IC passing list (highway "cruise" mode) — shown on the right side
        // while several upcoming maneuvers are highway interchanges and none is imminent yet;
        // yields to the close-range 3D junction view once a maneuver is actually near.
        let jctListManuallyHidden = false;
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
        let simStepCumTimeS = [];  // NEW: cumulative OSRM-estimated seconds at the START of each simSteps[] entry — used to estimate arrival clock times for the IC/JCT passing list
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

        function haversineM(lat1, lon1, lat2, lon2) {
            const R = 6371000;
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLon = (lon2 - lon1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }

        // NEW: Catmull-Rom spline through 4 control points (p1→p2 is the segment being
        // subdivided; p0/p3 are the neighbors, used so the curve bends naturally into and out of
        // the segment instead of just being a straight line). Passes exactly through every real
        // point OSRM gave us — it only adds curvature *between* them, never moves them.
        function catmullRomPoint(p0, p1, p2, p3, t) {
            const t2 = t * t, t3 = t2 * t;
            const lat = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t +
                (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
                (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
            const lon = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t +
                (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
                (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
            return [lat, lon];
        }

        function densifyRouteCoords(coords, maxGapM = 12) {
            if (coords.length < 3) return coords;
            const out = [coords[0]];
            for (let i = 0; i < coords.length - 1; i++) {
                const p0 = coords[i - 1] || coords[i];
                const p1 = coords[i];
                const p2 = coords[i + 1];
                const p3 = coords[i + 2] || coords[i + 1];
                const gap = haversineM(p1[0], p1[1], p2[0], p2[1]);
                const steps = Math.min(20, Math.max(1, Math.ceil(gap / maxGapM)));
                for (let s = 1; s <= steps; s++) {
                    out.push(s === steps ? p2 : catmullRomPoint(p0, p1, p2, p3, s / steps));
                }
            }
            return out;
        }

        // ---- Geo helpers for the distance-based driving simulation ----

        function buildRouteDistanceTables() {
            simCumDistM = [0];
            for (let i = 1; i < simCoords.length; i++) {
                const d = haversineM(simCoords[i - 1][0], simCoords[i - 1][1], simCoords[i][0], simCoords[i][1]);
                simCumDistM.push(simCumDistM[i - 1] + d);
            }
            simStepCumDistM = [0];
            simStepCumTimeS = [0];
            for (let i = 0; i < simSteps.length; i++) {
                simStepCumDistM.push(simStepCumDistM[i] + (simSteps[i].distance || 0));
                simStepCumTimeS.push(simStepCumTimeS[i] + (simSteps[i].duration || 0));
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

        // NEW: returns the index into simSteps[] of whichever step covers the given traveled
        // distance (i.e. the road actually being driven right now, as opposed to
        // getDistanceToNextManeuver()'s *upcoming* step) — used to tell whether the vehicle
        // is currently on a highway/expressway so its cruising speed can reflect that.
        function getCurrentStepIndex(atDistM) {
            if (!simStepCumDistM.length) return -1;
            let idx = 0;
            while (idx < simStepCumDistM.length - 1 && simStepCumDistM[idx + 1] <= atDistM) idx++;
            return idx;
        }

        // Target cruising speed derived from how sharply the road curves just ahead, plus a
        // slowdown as the next turn/maneuver approaches — replaces the old fixed "40〜44
        // repeating" placeholder with something that actually reacts to the route shape.
        // NEW: now also reacts to the *type* of road currently being driven — a real
        // highway/expressway (OSRM step has a route ref, or an IC/JCT/高速-style name) lets
        // the simulated vehicle cruise at ~100km/h-class speeds, not the ~56km/h ceiling that
        // used to apply everywhere regardless of road type.
        function computeTargetSpeedKmh(atDistM) {
            const total = simCumDistM[simCumDistM.length - 1] || 0;
            const hNow = getHeadingAtDistance(atDistM);
            const hAhead = getHeadingAtDistance(Math.min(atDistM + 70, total));
            let diff = Math.abs(((hAhead - hNow + 540) % 360) - 180);

            const onHighway = isStepHighway(simSteps[getCurrentStepIndex(atDistM)]);
            // Gentle, slow oscillation (not a fixed number) so a highway cruise visibly
            // hovers "around 100km/h", the way real traffic/cruise-control speed drifts,
            // rather than pinning at one exact value.
            const highwayCruise = 100 + Math.sin(atDistM * 0.008) * 10; // ~90–110 km/h
            const localCruise = 56;

            let target;
            if (onHighway) {
                if (diff < 6) target = highwayCruise;
                else if (diff < 18) target = 80;
                else if (diff < 45) target = 55;
                else target = 35;
            } else {
                if (diff < 6) target = localCruise;
                else if (diff < 18) target = 42;
                else if (diff < 45) target = 28;
                else target = 16;
            }

            // NEW: wet-road conditions bring the natural cruising speed down, same as a real driver easing off
            if (isWeatherRainActive) target = Math.round(target * 0.8);

            const { distToNextManeuverM } = getDistanceToNextManeuver();
            if (isFinite(distToNextManeuverM)) {
                if (distToNextManeuverM < 35) target = Math.min(target, onHighway ? 40 : 14);
                else if (distToNextManeuverM < 90) target = Math.min(target, onHighway ? 60 : 26);
                else if (distToNextManeuverM < 300) target = Math.min(target, onHighway ? 80 : target);
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
                const vol = 0.12 * (volumeLevel / 5);

                // Safety-critical alerts (collision/lane-departure/overspeed HUD warnings)
                // always sound regardless of the button-sound preference below — muting the
                // *button click* sound shouldn't also silence an actual safety warning.
                if (type === 'alert') {
                    playTone(1200, now, 0.05, vol, 'square');
                    playTone(1200, now + 0.09, 0.05, vol, 'square');
                    return;
                }

                // NEW: which sound style plays is now user-configurable in 設定 — see
                // appSettings.buttonSound (ordinary UI taps) and appSettings.navChime (the
                // chime that precedes each spoken nav announcement, in speakGuidance below).
                const style = (type === 'nav') ? appSettings.navChime : appSettings.buttonSound;
                if (style === 'off') return;
                if (style === 'soft') {
                    playTone(523.25, now, 0.09, vol * 0.7, 'sine');
                } else if (style === 'chime') {
                    playTone(880, now, 0.05, vol, 'triangle');
                    playTone(1318.5, now + 0.06, 0.09, vol * 0.8, 'triangle');
                } else {
                    playTone(type === 'click' ? 880 : 1200, now, 0.04, vol, 'sine');
                }
            } catch (e) {}
        }

        // Plays one short synthesized tone — shared by every playBeep() sound style above.
        function playTone(freq, startTime, duration, vol, wave) {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = wave;
            osc.frequency.setValueAtTime(freq, startTime);
            gain.gain.setValueAtTime(vol, startTime);
            gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(startTime);
            osc.stop(startTime + duration);
        }

        // BUGFIX/NEW: previously nothing in this app ever adjusted music volume during
        // spoken guidance at all — any perceived "the music gets quiet while the nav voice
        // is talking" was purely the browser/OS's own automatic audio-ducking kicking in
        // when speechSynthesis grabs audio focus, which this page has no control over, and
        // which can appear to "get stuck" quiet if a new announcement starts before the
        // previous one's focus was ever released. This makes ducking explicit and reliable
        // for the two audio sources this page *can* actually control — the internet-radio
        // and locally-uploaded-MP3 <audio> elements — ducking them to 25% right as guidance
        // starts and reliably restoring full volume afterward via a token so a rapid string
        // of announcements can't leave the music stuck quiet.
        // NOTE: Apple Music here plays inside a cross-origin <iframe> (embed.music.apple.com)
        // — browsers deliberately block a page's JavaScript from reaching into another
        // origin's iframe to read or change its audio, so that source's volume genuinely
        // cannot be touched from here. Any dip on that source specifically is the OS/browser
        // doing its own ducking, not this app.
        let speechDuckToken = 0;
        function duckLocalAudioForSpeech(duck) {
            [document.getElementById('radio-audio-el'), document.getElementById('local-audio-el')].forEach(el => {
                if (!el) return;
                if (duck) {
                    if (el.dataset.preDuckVolume === undefined) el.dataset.preDuckVolume = String(el.volume);
                    el.volume = parseFloat(el.dataset.preDuckVolume) * 0.25;
                } else if (el.dataset.preDuckVolume !== undefined) {
                    el.volume = parseFloat(el.dataset.preDuckVolume);
                    delete el.dataset.preDuckVolume;
                }
            });
        }

        function speakGuidance(text) {
            playBeep('nav');
            if (guidanceOff || volumeLevel === 0) return;
            if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.lang = 'ja-JP';
                utterance.rate = 1.05;
                utterance.volume = Math.min(1, volumeLevel / 5);

                const myToken = ++speechDuckToken;
                duckLocalAudioForSpeech(true);
                const release = () => { if (speechDuckToken === myToken) duckLocalAudioForSpeech(false); };
                utterance.onend = release;
                utterance.onerror = release;

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

                // BUGFIX: in ヘディングアップ mode the #map element is CSS-rotated, and its
                // old fixed 150%/-25% oversize (enough to cover a roughly-square viewport at
                // 45°) left real black/untiled gaps at the left and right edges on the wider,
                // landscape-shaped viewport this app actually runs in — the oversized square
                // just didn't reach the corners. This sizes it to the viewport's own diagonal
                // instead, which mathematically guarantees full tile coverage at any rotation
                // angle regardless of aspect ratio, and re-runs whenever the viewport can have
                // changed size (window resize, split-screen toggle).
                sizeRotatableMap();
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);

                // Re-fit #map's diagonal-safe size whenever the viewport can have changed —
                // window resize, orientation change, or the split-screen panel opening/closing
                // (its CSS transition runs ~300ms, hence the small delay on that one).
                window.addEventListener('resize', sizeRotatableMap);

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
        // Style is now user-selectable in 設定 (appSettings.bootAnimation) — see the
        // matching .boot-style-* CSS rules in style.css.
        function playBootAnimation() {
            const splash = document.getElementById('boot-splash');
            if (!splash) return;
            splash.classList.remove('boot-style-classic', 'boot-style-radial', 'boot-style-minimal');
            splash.classList.add('boot-style-' + (appSettings.bootAnimation || 'classic'));
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

        // BUGFIX: sizes the (rotatable) #map element to its viewport's own diagonal, centered,
        // so it fully covers the visible area at ANY rotation angle regardless of aspect ratio
        // — a plain "150% bigger" oversize left real gaps (shown as black/untiled map) at the
        // left/right edges once rotated on this app's wide, landscape-shaped map viewport.
        // Re-run whenever the viewport can have changed size.
        function sizeRotatableMap() {
            const section = document.getElementById('map-section');
            const mapEl = document.getElementById('map');
            if (!section || !mapEl) return;
            const w = section.clientWidth, h = section.clientHeight;
            if (!w || !h) return;
            const size = Math.ceil(Math.sqrt(w * w + h * h) * 1.05);
            mapEl.style.width = size + 'px';
            mapEl.style.height = size + 'px';
            mapEl.style.left = Math.round((w - size) / 2) + 'px';
            mapEl.style.top = Math.round((h - size) / 2) + 'px';
            if (map) map.invalidateSize();
        }

        // NEW: rotates the map itself (see the #map CSS rule) so that in ヘディングアップ mode
        // the current travel direction always points "up" on screen — the car icon's own
        // rotation always equals the true heading (set in animateStep), so combined with this
        // map rotation it visually stays pointing straight up, and in ノースアップ mode the map
        // simply stays unrotated (north always up) while the car icon rotates to show heading.
        function updateMapRotation() {
            const mapEl = document.getElementById('map');
            if (!mapEl) return;
            const rotateDeg = (headingMode === 'heading') ? -currentHeading : 0;
            // NEW: translateX is applied BEFORE rotate in the CSS function list below, which
            // (per how CSS composes multiple transforms) means it shifts the map in true,
            // un-rotated SCREEN pixels first — so the car stays correctly shifted into the
            // visible left half regardless of the current heading-up rotation angle — and
            // THEN the whole already-shifted result is rotated. Reversing the order would
            // make the shift rotate along with the map instead of staying screen-horizontal.
            const offsetPx = getSidebarOffsetPx();
            mapEl.style.transform = `translateX(${offsetPx}px) rotate(${rotateDeg}deg)`;
        }

        // NEW: when the 3D junction view or the IC/JCT passing list is showing (both cover
        // the right half of the map — see #junction-3d-container / #jct-list-panel), the car
        // marker previously stayed centered on the FULL map width, which put it right at (or
        // under) the sidebar's left edge, effectively hiding the driver's own position. This
        // returns how many screen pixels to shift the map content left so the car ends up
        // centered in the remaining, uncovered left half instead.
        function getSidebarOffsetPx() {
            const jctBox = document.getElementById('junction-3d-container');
            const jctList = document.getElementById('jct-list-panel');
            const sidebarVisible = (jctBox && !jctBox.classList.contains('hidden')) ||
                (jctList && !jctList.classList.contains('hidden'));
            if (!sidebarVisible) return 0;
            const mapSection = document.getElementById('map-section');
            if (!mapSection) return 0;
            return -(mapSection.clientWidth * 0.25);
        }

        function toggleHeadingMode() {
            playBeep();
            if (headingMode === 'north') {
                headingMode = 'heading';
                speakGuidance('ヘディングアップ表示に変更しました。');
            } else {
                headingMode = 'north';
                speakGuidance('ノースアップ表示に変更しました。');
            }
            updateMapRotation();
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
                if (label) label.innerText = 'ON';
                speakGuidance('3Dジャンクションガイドを有効にしました。');
            } else {
                if (label) label.innerText = 'OFF';
                if (jctBox) jctBox.classList.add('hidden');
                speakGuidance('3Dジャンクションガイドをオフにしました。');
            }
            updateMapRotation();
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
                // FIXED: the scene used to render with a fully transparent (alpha) canvas so
                // the CSS sky gradient behind it would show through, but the combination of
                // alpha:true + antialias:true is a known WebGL trouble spot on some
                // browsers/GPU drivers — any pixel the scene itself never draws to (empty sky
                // above the horizon) could come back as leftover/uninitialized GPU memory
                // instead of clean transparency, which is exactly the colorful static/noise
                // seen in the sky. The renderer is now fully opaque, and the sky gradient is
                // painted directly into the scene as a real background texture, so every
                // pixel always has a deterministic color.
                threeScene.background = createSkyGradientTexture();
                threeScene.fog = new THREE.FogExp2(0xcfe9f7, 0.0055);

                const width = container.clientWidth || 300;
                const height = container.clientHeight || 250;

                threeCamera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
                update3DCameraPosition();

                threeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
                threeRenderer.setSize(width, height);
                threeRenderer.shadowMap.enabled = true;
                threeRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
                container.appendChild(threeRenderer.domElement);

                // Lighting — bright warm "sun" + sky/ground bounce fill, replacing the old
                // moody blue night lighting so the whole scene reads as a clear, sunlit day.
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
                threeScene.add(ambientLight);

                const dirLight = new THREE.DirectionalLight(0xfff3d6, 2.0);
                dirLight.position.set(45, 90, 35);
                dirLight.castShadow = true;
                dirLight.shadow.mapSize.set(1024, 1024);
                dirLight.shadow.camera.left = -140;
                dirLight.shadow.camera.right = 140;
                dirLight.shadow.camera.top = 140;
                dirLight.shadow.camera.bottom = -140;
                dirLight.shadow.camera.near = 1;
                dirLight.shadow.camera.far = 260;
                dirLight.shadow.bias = -0.0015;
                threeScene.add(dirLight);
                threeScene.add(dirLight.target);

                // Group Containers for Route-following Objects
                roadGroup = new THREE.Group();
                buildingGroup = new THREE.Group();
                threeScene.add(roadGroup);
                threeScene.add(buildingGroup);

                // Sky (light blue) / ground-bounce (warm green) fill so every face of every
                // building and the road reads correctly lit from any camera angle, day-bright.
                const hemiLight = new THREE.HemisphereLight(0x9fd3f7, 0x8a9a6e, 0.9);
                threeScene.add(hemiLight);

                // A few soft painted-looking clouds high in the sky for atmosphere.
                createSkyClouds();

                // Grass/terrain Ground Plane (replaces the old flat dark asphalt-colored plane
                // that covered the whole view) — real ground around a road is grass/earth, not
                // asphalt, so the road itself now reads as a distinct paved ribbon on top of it.
                const groundGeo = new THREE.PlaneGeometry(500, 500);
                const groundMat = new THREE.MeshStandardMaterial({ map: createGrassTexture(), roughness: 0.95 });
                const ground = new THREE.Mesh(groundGeo, groundMat);
                ground.rotation.x = -Math.PI / 2;
                ground.position.y = -0.06;
                ground.receiveShadow = true;
                threeScene.add(ground);

                // Build Overhead Expressway Sign Gantry
                createOverheadGantry();

                animateThreeJS();
            } catch (err) {
                console.log("WebGL 3D fallback active:", err);
            }
        }

        // NEW: a real vertical sky gradient painted into the scene itself (used as
        // scene.background, see initThreeJSJunction) — replaces relying on a transparent
        // canvas + CSS gradient behind it, which was the root cause of the sky rendering as
        // colorful static/noise on some browsers/GPUs.
        function createSkyGradientTexture() {
            const c = document.createElement('canvas');
            c.width = 8; c.height = 256;
            const ctx = c.getContext('2d');
            const grad = ctx.createLinearGradient(0, 0, 0, 256);
            grad.addColorStop(0, '#4f96e0');
            grad.addColorStop(0.45, '#8fc7ef');
            grad.addColorStop(0.75, '#cfe9f7');
            grad.addColorStop(1, '#eaf4e6');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 8, 256);
            const tex = new THREE.CanvasTexture(c);
            return tex;
        }

        // NEW: procedurally-painted textures (no external image downloads needed) so the
        // ground and road read as real grass/asphalt instead of flat single-color planes.
        function createGrassTexture() {
            const c = document.createElement('canvas');
            c.width = c.height = 256;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#5a9450';
            ctx.fillRect(0, 0, 256, 256);
            for (let i = 0; i < 2200; i++) {
                const shade = 30 + Math.random() * 55;
                ctx.fillStyle = Math.random() > 0.5
                    ? `rgba(${70 + shade * 0.3},${140 + shade * 0.5},${60 + shade * 0.2},0.5)`
                    : `rgba(${60},${110 - shade * 0.2},${50},0.35)`;
                const x = Math.random() * 256, y = Math.random() * 256;
                ctx.fillRect(x, y, 2, 2 + Math.random() * 3);
            }
            const tex = new THREE.CanvasTexture(c);
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(30, 30);
            return tex;
        }

        function createAsphaltTexture() {
            const c = document.createElement('canvas');
            c.width = c.height = 128;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#54585e';
            ctx.fillRect(0, 0, 128, 128);
            for (let i = 0; i < 900; i++) {
                const v = 60 + Math.random() * 50;
                ctx.fillStyle = `rgba(${v},${v + 2},${v + 4},0.35)`;
                ctx.fillRect(Math.random() * 128, Math.random() * 128, 1.5, 1.5);
            }
            const tex = new THREE.CanvasTexture(c);
            tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
            tex.repeat.set(4, 24);
            return tex;
        }

        // A handful of soft, painted-cloud sprites high in the sky — cheap atmosphere that
        // reads well against the CSS sky gradient without needing any external texture asset.
        function createSkyClouds() {
            const c = document.createElement('canvas');
            c.width = 128; c.height = 64;
            const ctx = c.getContext('2d');
            const grad = ctx.createRadialGradient(64, 32, 4, 64, 32, 60);
            grad.addColorStop(0, 'rgba(255,255,255,0.95)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 128, 64);
            const tex = new THREE.CanvasTexture(c);
            const positions = [[-60, 45, -120], [40, 55, -160], [-20, 40, -90], [70, 48, -145], [10, 62, -205]];
            positions.forEach(([x, y, z]) => {
                const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
                const sprite = new THREE.Sprite(mat);
                sprite.scale.set(60 + Math.random() * 30, 26 + Math.random() * 10, 1);
                sprite.position.set(x, y, z);
                threeScene.add(sprite);
            });
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

        /* NEW: a real car nav's 3D junction view always shows a big directional arrow for the
           upcoming maneuver — this was previously missing entirely (the scene showed the real
           road/buildings but gave no visual cue for *which way* to go). Built as a bent tube +
           arrowhead, angled to match the OSRM maneuver modifier (left/right/slight/sharp/uturn). */
        function buildManeuverArrow(maneuver) {
            if (!maneuver) return;
            const angleMap = {
                'straight': 0, 'slight left': -28, 'left': -75, 'sharp left': -122, 'uturn': 175,
                'slight right': 28, 'right': 75, 'sharp right': 122
            };
            const angleDeg = angleMap[maneuver.modifier];
            if (angleDeg === undefined) return; // e.g. "depart"/"arrive" — no turn to show
            const theta = angleDeg * Math.PI / 180;

            const start = new THREE.Vector3(0, 1.6, -7);
            const forwardDist = Math.abs(angleDeg) < 10 ? 20 : 13;
            const control = new THREE.Vector3(0, 1.6, -7 - forwardDist * 0.55);
            const end = new THREE.Vector3(
                Math.sin(theta) * forwardDist,
                1.6,
                -7 - Math.cos(theta) * forwardDist
            );

            const curve = new THREE.QuadraticBezierCurve3(start, control, end);
            const tubeGeo = new THREE.TubeGeometry(curve, 24, 0.45, 10, false);
            const arrowMat = new THREE.MeshStandardMaterial({
                color: 0x22d3ee, emissive: 0x0891b2, emissiveIntensity: 0.7, roughness: 0.3
            });
            roadGroup.add(new THREE.Mesh(tubeGeo, arrowMat));

            // Arrowhead cone at the end, oriented along the curve's tangent there
            const tangent = curve.getTangentAt(1);
            const coneGeo = new THREE.ConeGeometry(1.1, 2.6, 12);
            const cone = new THREE.Mesh(coneGeo, arrowMat);
            cone.position.copy(end);
            const up = new THREE.Vector3(0, 1, 0);
            const quat = new THREE.Quaternion().setFromUnitVectors(up, tangent.clone().normalize());
            cone.quaternion.copy(quat);
            roadGroup.add(cone);
        }

        /* NEW: a light concrete curb/shoulder strip offset to one side of the road curve —
           built by projecting a parallel curve at `offsetDist` along each point's local
           normal, then tubing that. Reused for both the left and right edge of the road. */
        function buildCurbStrip(curve, segments, offsetDist, color) {
            const pts = [];
            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const p = curve.getPointAt(t);
                const tangent = curve.getTangentAt(t);
                const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
                pts.push(p.clone().addScaledVector(normal, offsetDist));
            }
            const curbCurve = new THREE.CatmullRomCurve3(pts);
            const geo = new THREE.TubeGeometry(curbCurve, segments, 0.28, 6, false);
            const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.position.y += 0.16;
            mesh.receiveShadow = true;
            roadGroup.add(mesh);
        }

        /* NEW: street lamps along the real route curve, alternating sides — mainly to stop the
           night-time junction scene from reading as an empty test track. */
        function buildStreetLamps(curve, segments) {
            const lampCount = Math.min(10, Math.floor(segments / 6));
            for (let i = 1; i <= lampCount; i++) {
                const t = i / (lampCount + 1);
                const p = curve.getPointAt(t);
                const tangent = curve.getTangentAt(t);
                const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
                const side = i % 2 === 0 ? 1 : -1;
                const base = p.clone().addScaledVector(normal, side * 5.2);

                // NEW: daytime street lamps — a plain metal pole/head (was a glowing yellow
                // orb, which only makes sense at night; the scene is now a bright sunny day).
                const poleGeo = new THREE.CylinderGeometry(0.12, 0.15, 6.5);
                const poleMat = new THREE.MeshStandardMaterial({ color: 0x707880, roughness: 0.5, metalness: 0.4 });
                const pole = new THREE.Mesh(poleGeo, poleMat);
                pole.position.set(base.x, 3.25, base.z);
                pole.castShadow = true;
                roadGroup.add(pole);

                const lampGeo = new THREE.SphereGeometry(0.35, 8, 8);
                const lampMat = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.4 });
                const lamp = new THREE.Mesh(lampGeo, lampMat);
                lamp.position.set(base.x, 6.5, base.z);
                lamp.castShadow = true;
                roadGroup.add(lamp);
            }
        }

        /* Build the 3D road directly from the real OSRM route geometry (the same
           coordinates that drive the 2D map), instead of a synthetic curve, so the
           junction's shape actually matches the road being driven. */
        // BUGFIX: THREE.TubeGeometry orients its cross-section using automatically-computed
        // Frenet frames, which are numerically unstable on nearly-straight curves (a
        // well-known three.js quirk) — the frame visibly rotates along the tube's length,
        // which for a round curb or thin guide line is barely noticeable, but for the WIDE,
        // flat-topped road surface it read as the whole road twisting/tilting diagonally,
        // especially obvious from the close-up ドライバー視点 camera. This instead builds the
        // road as a flat ribbon using a manually-computed, always-horizontal "right" vector
        // (tangent × world-up) at each point, so the road surface can never twist regardless
        // of how straight or curved the real route geometry is.
        function buildFlatRoadRibbon(curve, segments, halfWidth) {
            const positions = [];
            const normals = [];
            const uvs = [];
            const indices = [];
            const worldUp = new THREE.Vector3(0, 1, 0);

            for (let i = 0; i <= segments; i++) {
                const t = i / segments;
                const p = curve.getPointAt(t);
                const tangent = curve.getTangentAt(t).normalize();
                let right = new THREE.Vector3().crossVectors(tangent, worldUp);
                if (right.lengthSq() < 1e-6) right.set(1, 0, 0); // tangent ~vertical fallback
                right.normalize();

                const leftPt = p.clone().addScaledVector(right, -halfWidth);
                const rightPt = p.clone().addScaledVector(right, halfWidth);
                positions.push(leftPt.x, leftPt.y, leftPt.z, rightPt.x, rightPt.y, rightPt.z);
                normals.push(0, 1, 0, 0, 1, 0);
                uvs.push(0, t, 1, t);
            }
            for (let i = 0; i < segments; i++) {
                const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
                indices.push(a, c, b, b, c, d);
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
            geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geo.setIndex(indices);
            return geo;
        }

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

            // FIXED: the road used to be a round TubeGeometry (a pipe swept along the curve).
            // At the close, low driver-view camera distance that put the camera right at the
            // pipe's own surface height, so the road filled almost the whole screen as one
            // giant grey dome instead of reading as a road at all — and TubeGeometry's default
            // Frenet-frame orientation can twist/roll along a curve, which was the "road looks
            // tilted" bug in driver view. This builds a genuinely FLAT ribbon instead: for
            // every point along the curve, "right" is always derived from a level, world-up
            // cross product rather than a Frenet frame, so the road surface can never roll or
            // bank unexpectedly and always reads as a flat, level road.
            const roadGeo = buildFlatRoadRibbon(curve, segments, 3.6);
            const roadMat = new THREE.MeshStandardMaterial({ map: createAsphaltTexture(), color: 0xaaaaaa, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide });
            const roadMesh = new THREE.Mesh(roadGeo, roadMat);
            roadMesh.receiveShadow = true;
            roadGroup.add(roadMesh);
            buildCurbStrip(curve, segments, 3.95, 0xdcd8cc);
            buildCurbStrip(curve, segments, -3.95, 0xdcd8cc);

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

            buildStreetLamps(curve, segments);
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
                // NEW: light, realistic daytime concrete/render tones (was near-black navy),
                // matching the scene's overall brightness pass.
                const residentialPalette = [0xe4d9c6, 0xead9c0, 0xd8c8ae];
                const commercialPalette = [0xcdd6dc, 0xc0ccd6, 0xd8d8d0, 0xc9c2b2];
                const palette = isResidential ? residentialPalette : commercialPalette;
                const mat = new THREE.MeshStandardMaterial({
                    color: palette[rendered % palette.length],
                    roughness: 0.8,
                    metalness: 0.05
                });
                const mesh = new THREE.Mesh(geo, mat);
                mesh.rotation.x = -Math.PI / 2;
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                buildingGroup.add(mesh);

                // Subtle architectural edge lines (dark outline instead of the old glowing
                // blue "night window" look, since the scene is now a bright day scene)
                const edges = new THREE.EdgesGeometry(geo);
                const edgeLines = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x3a4450, transparent: true, opacity: 0.3 }));
                edgeLines.rotation.x = -Math.PI / 2;
                buildingGroup.add(edgeLines);

                rendered++;
            }
            if (rendered === 0) renderProceduralFallbackBuildings();
        }

        /* Used only when real OpenStreetMap building data can't be fetched (offline, or the
           Overpass API is unreachable) so the junction view still has some city context. */
        function renderProceduralFallbackBuildings() {
            // NEW: bright daytime concrete tones (was near-black navy/purple night colors)
            const palette = [0xcdd6dc, 0xd8d0bd, 0xc9c2b2, 0xd2ccc0];
            for (let i = -3; i <= 3; i++) {
                if (i === 0) continue;
                const h = 15 + Math.abs(i) * 10 + Math.random() * 15;
                const bGeo = new THREE.BoxGeometry(10, h, 10);
                const bMat = new THREE.MeshStandardMaterial({
                    color: palette[(i + 3) % palette.length],
                    roughness: 0.8
                });
                const bMesh = new THREE.Mesh(bGeo, bMat);
                bMesh.position.set(i * 22, h / 2, -10 - Math.abs(i) * 15);
                bMesh.castShadow = true;
                bMesh.receiveShadow = true;
                buildingGroup.add(bMesh);
            }
        }

        /* Rebuild the 3D junction scene for the given point along the real route:
           road + lane markings come straight from the OSRM geometry already being
           driven, and buildings are fetched from live OpenStreetMap data so the scene
           reflects the actual terrain around that junction rather than an invented one. */
        async function updateJunction3DScene(stepIdx, stepName, maneuver) {
            if (!roadGroup || !buildingGroup || !simCoords || simCoords.length === 0) return;

            const requestToken = ++jctRequestToken;
            const [anchorLat, anchorLng] = simCoords[stepIdx];
            const p2 = simCoords[Math.min(stepIdx + 3, simCoords.length - 1)];
            const bearingDeg = calculateBearing(anchorLat, anchorLng, p2[0], p2[1]);

            while (roadGroup.children.length > 0) roadGroup.remove(roadGroup.children[0]);
            buildRealRoadFromRoute(stepIdx, anchorLat, anchorLng, bearingDeg);
            buildManeuverArrow(maneuver);

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
            const poleMat = new THREE.MeshStandardMaterial({ color: 0x8b939c, roughness: 0.6, metalness: 0.3 });

            const leftPole = new THREE.Mesh(poleGeo, poleMat);
            leftPole.position.set(-10, 6, 0);
            leftPole.castShadow = true;

            const rightPole = new THREE.Mesh(poleGeo, poleMat);
            rightPole.position.set(10, 6, 0);
            rightPole.castShadow = true;

            const beamGeo = new THREE.BoxGeometry(22, 0.6, 0.6);
            const beam = new THREE.Mesh(beamGeo, poleMat);
            beam.position.set(0, 11.5, 0);
            beam.castShadow = true;

            // NEW: a real green expressway signboard hanging from the gantry, like the ones
            // visible on real Japanese expressway overhead signs (was bare metal beams only).
            const signGeo = new THREE.BoxGeometry(15, 3.4, 0.35);
            const signMat = new THREE.MeshStandardMaterial({ color: 0x0e7a3e, roughness: 0.55 });
            const signBoard = new THREE.Mesh(signGeo, signMat);
            signBoard.position.set(0, 9.4, 0.5);
            signBoard.castShadow = true;
            const signBorderGeo = new THREE.EdgesGeometry(signGeo);
            const signBorder = new THREE.LineSegments(signBorderGeo, new THREE.LineBasicMaterial({ color: 0xffffff }));
            signBorder.position.copy(signBoard.position);

            gantryGroup.add(leftPole);
            gantryGroup.add(rightPole);
            gantryGroup.add(beam);
            gantryGroup.add(signBoard);
            gantryGroup.add(signBorder);
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
                // FIXED: the road is now a flat ribbon sitting at y≈0 near the camera (it used
                // to be a round tube whose surface sat at y≈3.6, which is what the old
                // driver-view camera height of 3.5 was actually calibrated for) — a windshield
                // eye height of ~1.6 units above the flat road, close to the vehicle's own
                // position, reads correctly now instead of nearly clipping into the road.
                threeCamera.position.set(0, 1.6, 3);
                threeCamera.lookAt(0, 1.3, -40);
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
        /* ====================================================================
           BUGFIX: 経路案内の食い違い — the turn-direction ICON next to the banner text
           (and the one in the 3D junction header) were hard-coded "turn_right" in the HTML
           and never actually updated by any code, so they always showed a right-turn arrow
           regardless of the real maneuver — while the text/voice, which WAS derived from
           the real OSRM maneuver, could correctly say "左折" (left) or anything else. That
           mismatch between a frozen icon and live, correct text/speech is exactly what this
           reproduces "音声案内、文字の案内、実際の経路が食い違ってる" bug. This derives a
           matching icon from the same maneuver object maneuverToText() already uses.
           ==================================================================== */
        function maneuverToIcon(step) {
            if (!step || !step.maneuver) return 'straight';
            const { type, modifier } = step.maneuver;
            if (type === 'arrive') return 'flag';
            if (type === 'depart') return 'trip_origin';
            if (type === 'roundabout' || type === 'rotary') return 'roundabout_left';
            if (modifier === 'uturn') return 'u_turn_left';
            const iconMap = {
                'left': 'turn_left', 'right': 'turn_right',
                'slight left': 'turn_slight_left', 'slight right': 'turn_slight_right',
                'sharp left': 'turn_sharp_left', 'sharp right': 'turn_sharp_right',
                'straight': 'straight'
            };
            return iconMap[modifier] || 'straight';
        }

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
            if (type === 'roundabout' || type === 'rotary') {
                // NEW: OSRM gives the exit number (1st exit, 2nd exit, ...) for roundabouts —
                // previously ignored, so every roundabout gave the same generic instruction
                // regardless of which exit to actually take.
                return step.maneuver.exit ? `ラウンドアバウトを${step.maneuver.exit}番目の出口で退出` : 'ラウンドアバウトを通過';
            }
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

        /* ====================================================================
           NEW FEATURE: IC/JCT PASSING LIST ("ハイウェイモード")
           Real Toyota nav switches its right-hand panel between a scrolling list of
           upcoming IC/JCT (while cruising along an expressway, well before the next one)
           and the close-range 3D junction view (once actually approaching one). This
           reproduces that behavior using the same real OSRM step data already driving
           the rest of the simulation.
           ==================================================================== */

        // Heuristic for "this step is a highway interchange/junction" rather than an
        // ordinary local-road turn — based on OSRM's own maneuver type plus the kind of
        // naming/reference real Japanese expressway data carries (route number "ref",
        // or an IC/JCT keyword in the name).
        function isStepHighway(step) {
            if (!step) return false;
            if (step.ref) return true;
            const name = step.name || '';
            if (/IC|JCT|インターチェンジ|ジャンクション|高速|自動車道|バイパス|号線/.test(name)) return true;
            const type = step.maneuver && step.maneuver.type;
            return type === 'on ramp' || type === 'off ramp' || type === 'merge' || type === 'fork';
        }

        // Derives a short display tag ("IC" / "JCT") plus a clean label for one upcoming
        // highway step, mirroring how a real gantry sign would present it.
        function classifyJunctionStep(step) {
            const rawName = (step.name || '').trim();
            const cleaned = rawName.replace(/^(東名|首都高速|新東名|中央自動車道|名古屋高速)?\s*/, '').replace(/(インターチェンジ|ジャンクション)$/, '').trim();
            const isJct = /JCT|ジャンクション/.test(rawName) || step.maneuver?.type === 'fork' || step.maneuver?.type === 'merge';
            const tag = isJct ? 'JCT' : 'IC';
            const label = cleaned || rawName || (step.ref ? step.ref : (isJct ? '分岐' : '出口'));
            return { tag, label };
        }

        // Scans ahead in simSteps (from the current position) for up to maxCount upcoming
        // highway steps, returning their distance-ahead and an estimated arrival clock time.
        // Time is estimated by scaling the *remaining* portion of OSRM's own route duration
        // proportionally to remaining distance — the same approximation updateEtaDisplay()
        // already uses — so it stays consistent with the ETA shown elsewhere in the UI.
        function computeUpcomingJunctions(maxCount = 4) {
            if (!simSteps.length || simStepCumDistM.length < 2) return [];
            const total = simCumDistM[simCumDistM.length - 1] || 0;
            if (total <= 0) return [];
            const remainingTotalM = Math.max(0, total - simTraveledM);
            const remainingTotalS = routeTotalDurationS * (remainingTotalM / total);
            const nowMs = Date.now();

            const results = [];
            for (let i = 0; i < simSteps.length && results.length < maxCount; i++) {
                const stepStartM = simStepCumDistM[i];
                if (stepStartM <= simTraveledM + 5) continue; // already passed / directly underneath us
                const step = simSteps[i];
                if (!isStepHighway(step)) continue;

                const distRemainM = stepStartM - simTraveledM;
                const timeRemainS = remainingTotalM > 0 ? remainingTotalS * (distRemainM / remainingTotalM) : 0;
                const arrival = new Date(nowMs + timeRemainS * 1000);
                const { tag, label } = classifyJunctionStep(step);
                results.push({
                    tag, label,
                    distKm: distRemainM >= 1000 ? (distRemainM / 1000).toFixed(1) + 'km' : Math.round(distRemainM) + 'm',
                    etaClock: `${String(arrival.getHours()).padStart(2, '0')}:${String(arrival.getMinutes()).padStart(2, '0')}`
                });
            }
            return results;
        }

        function renderJctListPanel(items) {
            const listEl = document.getElementById('jct-list-items');
            const roadEl = document.getElementById('jct-list-current-road');
            if (!listEl) return;
            listEl.innerHTML = items.map((it, idx) => `
                <div class="${idx === 0 ? 'bg-blue-900/60 border-l-4 border-cyan-400' : 'border-l-4 border-transparent'}">
                    <div class="flex items-center justify-between px-3 py-1.5">
                        <div class="flex items-center gap-2 min-w-0">
                            <span class="shrink-0 text-[10px] font-black px-1.5 py-0.5 rounded ${it.tag === 'JCT' ? 'bg-emerald-600' : 'bg-blue-600'} text-white">${it.tag}</span>
                            <span class="font-bold text-sm text-white truncate">${it.label}</span>
                        </div>
                        <span class="text-cyan-200 font-black digital-font text-base shrink-0 ml-2">${it.distKm}</span>
                    </div>
                    <div class="px-3 pb-1.5 -mt-0.5 text-[11px] text-slate-400 digital-font">${it.etaClock}</div>
                </div>
            `).join('');
            if (roadEl) roadEl.innerText = document.getElementById('current-road-text')?.innerText || '道なり';
        }

        function toggleJctListManualHide() {
            playBeep();
            jctListManuallyHidden = true;
            const panel = document.getElementById('jct-list-panel');
            if (panel) panel.classList.add('hidden');
            updateMapRotation();
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
        // BUGFIX: the 3D scene / title used to only be (re)rendered the moment the panel first
        // appeared, and never again while it stayed open — so if two maneuvers fell close
        // together (a right turn immediately followed by a left turn, say), the panel would
        // silently keep showing the FIRST turn's arrow/name/title even once voice guidance had
        // already moved on to announcing the second one. That's exactly the "voice says one
        // thing, the 3D view/text says another" mismatch — tracking which step is currently
        // rendered and re-rendering whenever it changes (not just on first open) fixes it.
        let lastRenderedJctStepIdx = -1;

        function checkJunctionApproach() {
            const jctBox = document.getElementById('junction-3d-container');
            const jctDistEl = document.getElementById('jct-distance');
            const bannerNextTurn = document.getElementById('banner-next-turn');
            const { distToNextManeuverM, upcomingStepIdx, upcomingStep } = getDistanceToNextManeuver();

            // NEW: the posted speed limit badge now reflects the type of road actually being
            // driven (expressway vs. ordinary road), the same way a real nav's speed-limit
            // sign recognition would, instead of staying fixed regardless of road type —
            // this also keeps it in sync with the now-dynamic highway cruising speed above.
            const onHighwayNow = isStepHighway(simSteps[getCurrentStepIndex(simTraveledM)]);
            const expectedLimit = onHighwayNow ? 100 : 60;
            if (speedLimitKmh !== expectedLimit) setSpeedLimit(expectedLimit);

            const instructionText = upcomingStep ? maneuverToText(upcomingStep) : '直進';
            const roadName = (upcomingStep && upcomingStep.name) ? upcomingStep.name : '道なり';
            const isHighway = !!(upcomingStep && upcomingStep.ref);
            // BUGFIX: keep the turn-direction icon in sync with the real maneuver (see
            // maneuverToIcon above) — this used to be a hard-coded right-turn arrow that
            // never changed regardless of what the text/voice actually said.
            const turnIcon = maneuverToIcon(upcomingStep);
            const bannerIconEl = document.getElementById('banner-turn-icon');
            if (bannerIconEl) bannerIconEl.innerText = turnIcon;

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

            // NEW: the right-side panel now alternates between the close-range 3D junction
            // view (a maneuver is imminent) and the IC/JCT passing list (cruising along an
            // expressway well ahead of the next one) — matching how a real Toyota nav's
            // panel switches between these two modes rather than always showing one or the other.
            const jctListPanel = document.getElementById('jct-list-panel');
            const nearManeuver = enable3DJunction && jctBox && isFinite(distToNextManeuverM) && distToNextManeuverM < 220 && distToNextManeuverM > 0;

            if (nearManeuver) {
                if (jctListPanel) jctListPanel.classList.add('hidden');
                if (jctDistEl) jctDistEl.innerText = `あと ${Math.round(distToNextManeuverM)}m (実地形追従3D)`;
                lastJctInstructionText = instructionText;
                upcomingLandmarkStepIdx = upcomingStepIdx;
                const justOpened = jctBox.classList.contains('hidden');
                if (justOpened) {
                    jctBox.classList.remove('hidden');
                    setTimeout(resizeJunction3D, 50);
                }
                // BUGFIX: re-render whenever the upcoming maneuver has actually changed, not
                // only the first time the panel opens — see lastRenderedJctStepIdx above.
                if (justOpened || upcomingStepIdx !== lastRenderedJctStepIdx) {
                    lastRenderedJctStepIdx = upcomingStepIdx;
                    updateJunction3DScene(simIndex, roadName, upcomingStep && upcomingStep.maneuver);
                    const jctTurnIconEl = document.getElementById('jct-turn-icon');
                    if (jctTurnIconEl) jctTurnIconEl.innerText = turnIcon;
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
                if (jctBox) jctBox.classList.add('hidden');
                lastRenderedJctStepIdx = -1;
                if (jctListPanel && !jctListManuallyHidden && simTraveledM > 0) {
                    const items = computeUpcomingJunctions(4);
                    if (items.length > 0) {
                        renderJctListPanel(items);
                        jctListPanel.classList.remove('hidden');
                    } else {
                        jctListPanel.classList.add('hidden');
                    }
                } else if (jctListPanel) {
                    jctListPanel.classList.add('hidden');
                }
            }

            // NEW: keep the car's screen-space offset in sync with whatever the sidebar
            // visibility just became above (see getSidebarOffsetPx / updateMapRotation).
            updateMapRotation();
        }

        /* ====================================================================
           APPLE MUSIC & MULTI-AUDIO PLAYER INTEGRATION ENGINE
           ==================================================================== */
        function openCarPlayAudio(source = 'applemusic') {
            playBeep();
            closeTConnectMenu();
            switchAudioSource(source);
            document.getElementById('carplay-overlay').classList.remove('hidden');
            // BUGFIX: carplay-overlay only covered its own nested container's box, which
            // stops short of the right-side hardware button strip (zoom/Gemini/radio/re-
            // search) — that strip sat physically beside it, visually clipping/hiding the
            // right edge of the Apple Music (or radio/MP3) screen. This measures the whole
            // simulated head-unit display (#screen-container, which the hw-strip is also
            // part of) and pins the overlay exactly over it with real fixed-position pixel
            // coordinates, so CarPlay now genuinely takes over the entire screen edge-to-edge.
            alignCarplayOverlayToScreen();
            window.addEventListener('resize', alignCarplayOverlayToScreen);
        }

        function closeCarPlayOverlay() {
            playBeep();
            document.getElementById('carplay-overlay').classList.add('hidden');
            window.removeEventListener('resize', alignCarplayOverlayToScreen);
        }

        function alignCarplayOverlayToScreen() {
            const overlay = document.getElementById('carplay-overlay');
            const screen = document.getElementById('screen-container');
            if (!overlay || !screen) return;
            const rect = screen.getBoundingClientRect();
            // BUGFIX: this used to pin the overlay to the WHOLE screen rect, top edge
            // included — which covers the top status bar (clock/weather/and critically the
            // "now playing" Apple Music mini-player + controls), making the music info and
            // its play/pause button disappear the instant you open Audio/CarPlay, T-Connect
            // menu, etc. Now it starts just below the top bar so that bar (and the music
            // controls in it) stays visible/reachable no matter which full-screen "app" is
            // open, the way a real car head unit keeps its status bar persistent.
            const topBar = document.getElementById('top-status-bar');
            const topBarH = topBar ? topBar.getBoundingClientRect().height : 0;
            overlay.style.position = 'fixed';
            overlay.style.top = (rect.top + topBarH) + 'px';
            overlay.style.left = rect.left + 'px';
            overlay.style.width = rect.width + 'px';
            overlay.style.height = (rect.height - topBarH) + 'px';
        }

        function switchAudioSource(source) {
            playBeep();
            currentAudioSource = source;
            const trackText = document.getElementById('top-audio-track');
            const icon = document.getElementById('mini-audio-icon');
            const urlDisplay = document.getElementById('player-current-url');
            const urlBar = document.getElementById('audio-address-bar');

            // Reset App Button Styles
            ['applemusic', 'radio', 'local'].forEach(s => {
                const btn = document.getElementById(`app-btn-${s}`);
                if (btn) btn.className = 'w-full p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left text-xs font-bold text-slate-300 flex items-center gap-2';
            });

            // NEW: only the iframe-based source (Apple Music) needs the fallback/error UI and the
            // address bar up top — the radio and local-MP3 panels are plain <audio> elements with
            // their own self-contained UI, so those pieces are hidden while either is active.
            const iframe = document.getElementById('audio-player-iframe');
            const radioPanel = document.getElementById('radio-player-panel');
            const localPanel = document.getElementById('local-player-panel');
            if (iframe) iframe.classList.toggle('hidden', source !== 'applemusic');
            if (radioPanel) radioPanel.classList.toggle('hidden', source !== 'radio');
            if (localPanel) localPanel.classList.toggle('hidden', source !== 'local');
            hideAudioEmbedFallback();
            if (urlBar) urlBar.classList.toggle('hidden', source !== 'applemusic');

            // Stop whichever <audio> element isn't the active source, so switching apps doesn't
            // leave two things playing at once.
            const radioEl = document.getElementById('radio-audio-el');
            const localEl = document.getElementById('local-audio-el');
            if (source !== 'radio' && radioEl && !radioEl.paused) radioEl.pause();
            if (source !== 'local' && localEl && !localEl.paused) localEl.pause();

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
                // NEW: TuneIn's embed widget, and later a YouTube livestream embed, both proved
                // unreliable (either blocked framing or errored out). Neither is used anymore —
                // this plays a direct SomaFM internet-radio audio stream instead, through a plain
                // <audio> element. SomaFM's streams send Access-Control-Allow-Origin: *, so there's
                // no iframe/X-Frame-Options failure mode possible here at all.
                trackText.innerText = "ラジオ - " + currentRadioStationLabel;
                icon.className = "material-symbols-filled text-red-400";
                icon.innerText = "radio";
                document.getElementById('app-btn-radio').className = 'w-full p-2.5 rounded-xl bg-red-950/80 border border-red-500 text-left text-xs font-bold text-red-200 flex items-center gap-2 shadow';
            } else if (source === 'local') {
                // NEW: locally uploaded MP3 playback.
                trackText.innerText = "ローカルMP3";
                icon.className = "material-symbols-filled text-emerald-400";
                icon.innerText = "library_music";
                document.getElementById('app-btn-local').className = 'w-full p-2.5 rounded-xl bg-emerald-950/80 border border-emerald-500 text-left text-xs font-bold text-emerald-200 flex items-center gap-2 shadow';
                renderLocalMp3List();
            }
            updateTopMiniPlayIcon();
        }

        /* ====================================================================
           RADIO — <audio>ベース、iframe不使用。特定の1局/1プロバイダに固定せず、
           Radio-Browser(世界中のネットラジオ局を集めた無料の公開ディレクトリ)を検索して
           再生する。あるプロバイダの配信がブロックされても、別の局を探して切り替えられる。
           ==================================================================== */
        const RADIO_BROWSER_API = 'https://de1.api.radio-browser.info';

        function quickRadioSearch(query) {
            const input = document.getElementById('radio-search-input');
            if (input) input.value = query;
            searchRadioStations();
        }

        async function searchRadioStations() {
            playBeep();
            const input = document.getElementById('radio-search-input');
            const query = (input && input.value || '').trim();
            const resultsEl = document.getElementById('radio-search-results');
            if (!query || !resultsEl) return;
            resultsEl.innerHTML = '<div class="text-xs text-slate-500 p-2 flex items-center gap-2"><span class="material-symbols-filled fa-spin text-sm">progress_activity</span> 検索中...</div>';
            try {
                const url = `${RADIO_BROWSER_API}/json/stations/search?name=${encodeURIComponent(query)}&limit=10&hidebroken=true&order=clickcount&reverse=true`;
                const res = await fetch(url);
                const stations = await res.json();
                if (!Array.isArray(stations) || stations.length === 0) {
                    resultsEl.innerHTML = '<div class="text-xs text-slate-500 p-2 text-center">見つかりませんでした。別のキーワードをお試しください。</div>';
                    return;
                }
                resultsEl.innerHTML = stations.map(s => `
                    <button onclick='playRadioStation(${JSON.stringify(s.url_resolved || s.url)}, ${JSON.stringify(s.name)})' class="w-full p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left flex items-center gap-2.5">
                        <span class="material-symbols-filled text-red-400 text-lg shrink-0">radio</span>
                        <div class="min-w-0 flex-1">
                            <div class="text-xs font-bold text-white truncate">${s.name || '(無題の局)'}</div>
                            <div class="text-[9px] text-slate-400 truncate">${[s.countrycode, s.bitrate ? s.bitrate + 'kbps' : '', s.codec].filter(Boolean).join(' ・ ')}</div>
                        </div>
                    </button>
                `).join('');
            } catch (err) {
                resultsEl.innerHTML = '<div class="text-xs text-red-400 p-2 text-center">検索に失敗しました。通信環境をご確認ください。</div>';
            }
        }

        function playRadioStation(url, name) {
            playBeep();
            if (!url) { speakGuidance('この局は再生用のURLがありません。'); return; }
            currentRadioStationLabel = name;
            const nameEl = document.getElementById('radio-station-name');
            if (nameEl) nameEl.innerText = name;
            const trackText = document.getElementById('top-audio-track');
            if (trackText && currentAudioSource === 'radio') trackText.innerText = 'ラジオ - ' + name;

            const radioEl = document.getElementById('radio-audio-el');
            if (!radioEl) return;
            radioEl.pause();
            radioEl.src = url;
            radioEl.play().catch(() => {
                speakGuidance('この局は再生できませんでした。別の局をお試しください。');
            });
            updateRadioPlayButtonIcon();
        }

        function playManualRadioUrl() {
            const input = document.getElementById('radio-manual-url');
            const url = (input && input.value || '').trim();
            if (!url) return;
            playRadioStation(url, 'カスタム局');
        }

        function toggleRadioPlayback() {
            playBeep();
            const radioEl = document.getElementById('radio-audio-el');
            if (!radioEl) return;
            if (!radioEl.src) {
                speakGuidance('まず局を検索して選んでください。');
                return;
            }
            if (radioEl.paused) {
                radioEl.play().catch(() => {
                    speakGuidance('ラジオの再生に失敗しました。別の局をお試しください。');
                });
            } else {
                radioEl.pause();
            }
            updateRadioPlayButtonIcon();
        }

        function updateRadioPlayButtonIcon() {
            const radioEl = document.getElementById('radio-audio-el');
            const iconEl = document.querySelector('#radio-play-btn .material-symbols-filled');
            if (radioEl && iconEl) iconEl.innerText = radioEl.paused ? 'play_arrow' : 'pause';
            updateTopMiniPlayIcon();
        }

        /* ====================================================================
           ローカルMP3再生 — File API + IndexedDB。ファイルはこのブラウザの中だけに
           保存され、どこにもアップロードされない。
           ==================================================================== */
        const MP3_DB_NAME = 'toyotaNaviLocalMp3';
        const MP3_STORE_NAME = 'files';
        let mp3DbPromise = null;

        function openMp3Db() {
            if (mp3DbPromise) return mp3DbPromise;
            mp3DbPromise = new Promise((resolve, reject) => {
                if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
                const req = indexedDB.open(MP3_DB_NAME, 1);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains(MP3_STORE_NAME)) {
                        db.createObjectStore(MP3_STORE_NAME, { keyPath: 'id', autoIncrement: true });
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            return mp3DbPromise;
        }

        async function saveMp3ToDb(file) {
            const db = await openMp3Db();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(MP3_STORE_NAME, 'readwrite');
                const store = tx.objectStore(MP3_STORE_NAME);
                const req = store.add({ name: file.name, blob: file, addedAt: Date.now() });
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        }

        async function loadAllMp3FromDb() {
            const db = await openMp3Db();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(MP3_STORE_NAME, 'readonly');
                const store = tx.objectStore(MP3_STORE_NAME);
                const req = store.getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        }

        async function deleteMp3FromDb(id) {
            const db = await openMp3Db();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(MP3_STORE_NAME, 'readwrite');
                tx.objectStore(MP3_STORE_NAME).delete(id);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        let currentLocalMp3Id = null;
        let currentLocalObjectUrl = null;

        async function handleMp3Upload(event) {
            const files = Array.from(event.target.files || []);
            event.target.value = ''; // allow re-selecting the same file later
            if (files.length === 0) return;
            try {
                for (const file of files) {
                    await saveMp3ToDb(file);
                }
                speakGuidance(`${files.length}件のMP3を追加しました。`);
            } catch (err) {
                speakGuidance('MP3の保存に失敗しました。');
            }
            renderLocalMp3List();
        }

        async function renderLocalMp3List() {
            const listEl = document.getElementById('local-mp3-list');
            if (!listEl) return;
            let files;
            try {
                files = await loadAllMp3FromDb();
            } catch (err) {
                listEl.innerHTML = '<div class="text-xs text-red-400 p-2">このブラウザではローカル保存に対応していません。</div>';
                return;
            }
            if (files.length === 0) {
                listEl.innerHTML = '<div class="text-xs text-slate-500 p-2 text-center">アップロードされたMP3はまだありません。右上の「アップロード」から追加してください。</div>';
                return;
            }
            listEl.innerHTML = files.slice().reverse().map(f => `
                <div class="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-xl p-2.5">
                    <button onclick="playLocalMp3(${f.id}, '${escJs(f.name)}')" class="w-9 h-9 shrink-0 rounded-full bg-emerald-700 hover:bg-emerald-600 active:scale-95 transition flex items-center justify-center text-white">
                        <span class="material-symbols-filled text-lg">play_arrow</span>
                    </button>
                    <div class="min-w-0 flex-1 text-xs font-bold text-white truncate">${f.name}</div>
                    <button onclick="deleteLocalMp3(${f.id})" class="w-9 h-9 shrink-0 rounded-full text-slate-500 hover:text-red-400 hover:bg-slate-800 flex items-center justify-center transition" title="削除">
                        <span class="material-symbols-filled text-lg">delete</span>
                    </button>
                </div>
            `).join('');
        }

        async function playLocalMp3(id, name) {
            playBeep();
            const db = await openMp3Db();
            const tx = db.transaction(MP3_STORE_NAME, 'readonly');
            const req = tx.objectStore(MP3_STORE_NAME).get(id);
            req.onsuccess = () => {
                const record = req.result;
                if (!record) return;
                if (currentLocalObjectUrl) URL.revokeObjectURL(currentLocalObjectUrl);
                currentLocalObjectUrl = URL.createObjectURL(record.blob);
                currentLocalMp3Id = id;

                const el = document.getElementById('local-audio-el');
                el.src = currentLocalObjectUrl;
                el.play().catch(() => {});

                const nowPlaying = document.getElementById('local-now-playing');
                const nameEl = document.getElementById('local-now-playing-name');
                if (nowPlaying) nowPlaying.classList.remove('hidden');
                if (nameEl) nameEl.innerText = name;
                updateLocalPlayButtonIcon();

                const trackText = document.getElementById('top-audio-track');
                if (trackText && currentAudioSource === 'local') trackText.innerText = name;
            };
        }

        function toggleLocalPlayback() {
            playBeep();
            const el = document.getElementById('local-audio-el');
            if (!el || !el.src) return;
            if (el.paused) el.play().catch(() => {}); else el.pause();
            updateLocalPlayButtonIcon();
        }

        function updateLocalPlayButtonIcon() {
            const el = document.getElementById('local-audio-el');
            const iconEl = document.querySelector('#local-play-btn .material-symbols-filled');
            if (el && iconEl) iconEl.innerText = el.paused ? 'play_arrow' : 'pause';
            updateTopMiniPlayIcon();
        }

        // NEW: the top-bar mini audio banner's own play/pause button — dispatches to whichever
        // source is actually active. Apple Music plays inside a cross-origin <iframe>
        // (embed.music.apple.com); browsers deliberately block this page's JavaScript from
        // reaching into another origin's iframe to control its playback, so that source can't
        // actually be toggled from here — the button still appears (matching the requested
        // icon/track-name/play-button layout) but explains the limitation instead of silently
        // doing nothing.
        function toggleTopMiniPlayback() {
            playBeep();
            if (currentAudioSource === 'radio') {
                toggleRadioPlayback();
            } else if (currentAudioSource === 'local') {
                toggleLocalPlayback();
            } else {
                speakGuidance('Apple Musicの再生操作は埋め込みプレイヤー内で行ってください。');
            }
            updateTopMiniPlayIcon();
        }

        function updateTopMiniPlayIcon() {
            const iconEl = document.getElementById('top-mini-play-icon');
            if (!iconEl) return;
            const wrap = iconEl.parentElement;
            if (currentAudioSource === 'radio') {
                const el = document.getElementById('radio-audio-el');
                iconEl.innerText = (el && !el.paused) ? 'pause' : 'play_arrow';
                if (wrap) wrap.classList.remove('opacity-40');
            } else if (currentAudioSource === 'local') {
                const el = document.getElementById('local-audio-el');
                iconEl.innerText = (el && !el.paused) ? 'pause' : 'play_arrow';
                if (wrap) wrap.classList.remove('opacity-40');
            } else {
                // Apple Music — no real control possible from here (see toggleTopMiniPlayback);
                // dim the button so it doesn't look like a fully live playback control.
                iconEl.innerText = 'play_arrow';
                if (wrap) wrap.classList.add('opacity-40');
            }
        }

        async function deleteLocalMp3(id) {
            playBeep();
            if (id === currentLocalMp3Id) {
                const el = document.getElementById('local-audio-el');
                if (el) { el.pause(); el.removeAttribute('src'); }
                const nowPlaying = document.getElementById('local-now-playing');
                if (nowPlaying) nowPlaying.classList.add('hidden');
                currentLocalMp3Id = null;
            }
            try { await deleteMp3FromDb(id); } catch (err) {}
            renderLocalMp3List();
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
            speakGuidance(`${name}をメモリ地点に登録しました。`);
            // NEW: only refresh a destination screen if one is actually open (this is also
            // called from the ETA panel's star button while simply driving, where popping a
            // full-screen destination search over the map would be unwelcome).
            const modalEl = document.getElementById('app-modal');
            if (modalEl && !modalEl.classList.contains('hidden')) refreshActiveDestScreen();
        }

        function removeFavorite(name) {
            playBeep();
            favoriteDestinations = favoriteDestinations.filter(f => f.name !== name);
            refreshActiveDestScreen();
        }

        function refreshActiveDestScreen() {
            if (activeDestScreen === 'memory') openMemoryPointsScreen();
            else if (activeDestScreen === 'name') openDestinationModal();
            else openDestinationCategoryMenu();
        }

        /* ====================================================================
           NEW FEATURE: renewed Toyota-style destination search front menu.
           Matches the real T-Connect nav's "目的地" screen: a row of search-method
           category icons (ジャンル / 電話番号 / 住所 / メモリ地点 / 名称) plus a
           "特別メモリ" quick-memory row (5 numbered slots, 履歴, 自宅登録) beneath it.
           This is now the default entry point; each category routes into its own
           focused search screen (some of which reuse the existing free-text search
           machinery below via the shared #dest-input / searchLocation('dest') flow).
           ==================================================================== */
        function memorySlotButtonHtml(i) {
            const slot = memorySlots[i];
            if (slot) {
                return `<button onclick="useMemorySlot(${i})" title="${slot.name.replace(/"/g, '&quot;')}" class="bg-blue-900/70 border border-blue-500 rounded-xl flex flex-col items-center justify-center py-2.5 active:scale-95 transition hover:border-blue-300">
                    <span class="text-base font-black text-white">${i + 1}</span>
                </button>`;
            }
            return `<button onclick="assignMemorySlot(${i})" class="bg-slate-800 border border-slate-700 rounded-xl flex flex-col items-center justify-center py-2.5 active:scale-95 transition hover:border-slate-500">
                <span class="text-base font-black text-slate-500">${i + 1}</span>
            </button>`;
        }

        function openDestinationCategoryMenu() {
            playBeep();
            activeDestScreen = 'category';
            const body = `
                <div class="space-y-6">
                    <div>
                        <div class="grid grid-cols-3 sm:grid-cols-5 gap-2.5">
                            <button onclick="selectDestCategory('genre')" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-cyan-400 rounded-2xl py-4 flex flex-col items-center gap-1.5 active:scale-95 transition">
                                <span class="material-symbols-filled text-3xl text-cyan-300">storefront</span>
                                <span class="text-xs font-bold text-slate-100">ジャンル</span>
                            </button>
                            <button onclick="selectDestCategory('phone')" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-cyan-400 rounded-2xl py-4 flex flex-col items-center gap-1.5 active:scale-95 transition">
                                <span class="material-symbols-filled text-3xl text-cyan-300">call</span>
                                <span class="text-xs font-bold text-slate-100">電話番号</span>
                            </button>
                            <button onclick="selectDestCategory('address')" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-cyan-400 rounded-2xl py-4 flex flex-col items-center gap-1.5 active:scale-95 transition">
                                <span class="material-symbols-filled text-3xl text-cyan-300">home_pin</span>
                                <span class="text-xs font-bold text-slate-100">住所</span>
                            </button>
                            <button onclick="selectDestCategory('memory')" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-cyan-400 rounded-2xl py-4 flex flex-col items-center gap-1.5 active:scale-95 transition">
                                <span class="material-symbols-filled text-3xl text-cyan-300">flag</span>
                                <span class="text-xs font-bold text-slate-100">メモリ地点</span>
                            </button>
                            <button onclick="selectDestCategory('name')" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-cyan-400 rounded-2xl py-4 flex flex-col items-center gap-1.5 active:scale-95 transition relative">
                                <span class="material-symbols-filled text-3xl text-cyan-300">edit</span>
                                <span class="text-xs font-bold text-slate-100">名称</span>
                            </button>
                        </div>
                        <div class="flex justify-end mt-2">
                            <button onclick="openMoreDestCategories()" class="text-slate-400 hover:text-white flex items-center gap-0.5 text-[11px] font-bold px-2 py-1 rounded-lg hover:bg-slate-800">
                                その他の検索方法 <span class="material-symbols-filled text-base">chevron_right</span>
                            </button>
                        </div>
                    </div>

                    <div>
                        <div class="text-[11px] font-bold text-slate-400 mb-1.5 ml-1">特別メモリ</div>
                        <div class="grid grid-cols-7 gap-2">
                            ${[0, 1, 2, 3, 4].map(i => memorySlotButtonHtml(i)).join('')}
                            <button onclick="openHistoryScreen()" class="bg-slate-800 border border-slate-700 rounded-xl flex flex-col items-center justify-center py-1.5 active:scale-95 transition hover:border-slate-500">
                                <span class="material-symbols-filled text-lg text-slate-200">history</span>
                                <span class="text-[9px] font-bold text-slate-300 mt-0.5">履歴</span>
                            </button>
                            <button onclick="handleHomeRegisterTap()" class="bg-slate-800 border border-slate-700 rounded-xl flex flex-col items-center justify-center py-1.5 active:scale-95 transition hover:border-emerald-500">
                                <span class="material-symbols-filled text-lg ${homeLocation ? 'text-emerald-400' : 'text-slate-300'}">home</span>
                                <span class="text-[9px] font-bold text-slate-300 mt-0.5">${homeLocation ? '自宅' : '自宅登録'}</span>
                            </button>
                        </div>
                    </div>

                    <button onclick="openFullRouteSearchModal()" class="w-full py-2.5 rounded-2xl bg-blue-900/50 hover:bg-blue-900/80 border border-blue-600/60 text-blue-200 text-xs font-bold flex items-center justify-center gap-1.5">
                        <span class="material-symbols-filled text-base">alt_route</span> 出発地・経由地を設定してAIルート検索
                    </button>
                </div>
            `;
            openCustomModal('目的地', body, { fullscreen: true });
        }

        function selectDestCategory(type) {
            playBeep();
            if (type === 'name') { openDestinationModal(); return; }
            if (type === 'address') { openAddressSearchScreen(); return; }
            if (type === 'genre') { openGenreCategoryScreen(); return; }
            if (type === 'phone') { openPhoneSearchScreen(); return; }
            if (type === 'memory') { openMemoryPointsScreen(); return; }
            if (type === 'postal') { openAddressSearchScreen('郵便番号で探す', '例: 150-0001'); return; }
            if (type === 'coords') { openCoordsSearchScreen(); return; }
        }

        function openMoreDestCategories() {
            playBeep();
            const body = `
                <div class="grid grid-cols-2 gap-3">
                    <button onclick="selectDestCategory('postal')" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-cyan-400 rounded-2xl p-4 flex flex-col items-center gap-1.5 active:scale-95 transition">
                        <span class="material-symbols-filled text-2xl text-cyan-300">local_post_office</span>
                        <span class="text-xs font-bold text-slate-100">郵便番号</span>
                    </button>
                    <button onclick="selectDestCategory('coords')" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-cyan-400 rounded-2xl p-4 flex flex-col items-center gap-1.5 active:scale-95 transition">
                        <span class="material-symbols-filled text-2xl text-cyan-300">explore</span>
                        <span class="text-xs font-bold text-slate-100">緯度経度</span>
                    </button>
                </div>
                <button onclick="openDestinationCategoryMenu()" class="text-xs text-slate-400 hover:text-white underline mt-4">← カテゴリ選択に戻る</button>
            `;
            openCustomModal('その他の検索方法', body, { fullscreen: true });
        }

        function openAddressSearchScreen(title, placeholder) {
            activeDestScreen = 'address';
            const hint = pendingMemorySlotIndex !== null
                ? `<div class="text-[11px] text-blue-300 bg-blue-950/60 border border-blue-800 rounded-xl px-3 py-2">特別メモリ ${pendingMemorySlotIndex + 1} に登録する地点を検索してください</div>`
                : '';
            const body = `
                <div class="space-y-3">
                    ${hint}
                    <div class="flex items-center gap-2 bg-slate-800 rounded-2xl pl-4 pr-2 py-1 border border-slate-700 focus-within:border-red-400 transition">
                        <span class="material-symbols-filled text-red-400 text-lg">home_pin</span>
                        <input id="dest-input" type="text" placeholder="${placeholder || '都道府県・市区町村・番地など'}" class="flex-1 bg-transparent py-3 text-sm text-white placeholder-slate-500 focus:outline-none">
                        <button onclick="searchLocation('dest')" class="w-11 h-11 shrink-0 rounded-full bg-red-600 hover:bg-red-500 active:scale-95 transition flex items-center justify-center text-white shadow" title="検索">
                            <span class="material-symbols-filled text-lg">search</span>
                        </button>
                    </div>
                    <div id="dest-search-results" class="space-y-2"></div>
                    <button onclick="pendingMemorySlotIndex = null; openDestinationCategoryMenu();" class="text-xs text-slate-400 hover:text-white underline">← カテゴリ選択に戻る</button>
                </div>
            `;
            openCustomModal(title || '住所から探す', body, { fullscreen: true });
        }

        function openGenreCategoryScreen() {
            playBeep();
            activeDestScreen = 'genre';
            const cats = [
                { type: 'convenience', icon: 'storefront', label: 'コンビニ' },
                { type: 'restaurant', icon: 'restaurant', label: '飲食店' },
                { type: 'cafe', icon: 'local_cafe', label: 'カフェ' },
                { type: 'gas_station', icon: 'local_gas_station', label: 'ガソリンスタンド' },
                { type: 'ev_charge', icon: 'ev_station', label: 'EV充電' },
                { type: 'parking', icon: 'local_parking', label: '駐車場' },
                { type: 'hospital', icon: 'local_hospital', label: '病院' },
                { type: 'hotel', icon: 'hotel', label: 'ホテル' },
                { type: 'attraction', icon: 'photo_camera', label: '観光地' }
            ];
            const body = `
                <div class="grid grid-cols-3 gap-3">
                    ${cats.map(c => `
                        <button onclick="closeModal(); openNearbyPOI('${c.type}')" class="bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-cyan-400 rounded-2xl p-4 flex flex-col items-center gap-1.5 active:scale-95 transition">
                            <span class="material-symbols-filled text-2xl text-cyan-300">${c.icon}</span>
                            <span class="text-[11px] font-bold text-slate-200">${c.label}</span>
                        </button>
                    `).join('')}
                </div>
                <button onclick="openDestinationCategoryMenu()" class="text-xs text-slate-400 hover:text-white underline mt-4">← カテゴリ選択に戻る</button>
            `;
            openCustomModal('ジャンルで探す', body, { fullscreen: true });
        }

        // NEW: small built-in demo phone directory — Nominatim has no phone-number lookup,
        // so a handful of well-known landmark numbers are matched locally to keep this
        // category genuinely functional rather than a dead end.
        const PHONE_DIRECTORY = [
            { phone: '0334335111', name: '東京タワー', lat: 35.6586, lon: 139.7454 },
            { phone: '0334422111', name: '東京スカイツリー', lat: 35.7101, lon: 139.8107 },
            { phone: '0332132111', name: '皇居', lat: 35.6852, lon: 139.7528 },
            { phone: '0455038822', name: '横浜赤レンガ倉庫', lat: 35.4527, lon: 139.6425 }
        ];

        function openPhoneSearchScreen() {
            playBeep();
            activeDestScreen = 'phone';
            const body = `
                <div class="space-y-3">
                    <div class="flex items-center gap-2 bg-slate-800 rounded-2xl pl-4 pr-2 py-1 border border-slate-700 focus-within:border-red-400 transition">
                        <span class="material-symbols-filled text-red-400 text-lg">call</span>
                        <input id="phone-input" type="tel" placeholder="0312345678 (ハイフンなし)" class="flex-1 bg-transparent py-3 text-sm text-white placeholder-slate-500 focus:outline-none">
                        <button onclick="searchByPhone()" class="w-11 h-11 shrink-0 rounded-full bg-red-600 hover:bg-red-500 active:scale-95 transition flex items-center justify-center text-white shadow" title="検索">
                            <span class="material-symbols-filled text-lg">search</span>
                        </button>
                    </div>
                    <div id="phone-search-results" class="text-xs text-slate-500 p-1">市外局番から番号を入力してください</div>
                    <button onclick="openDestinationCategoryMenu()" class="text-xs text-slate-400 hover:text-white underline">← カテゴリ選択に戻る</button>
                </div>
            `;
            openCustomModal('電話番号で探す', body, { fullscreen: true });
        }

        function searchByPhone() {
            playBeep();
            const raw = document.getElementById('phone-input').value.replace(/[^0-9]/g, '');
            const box = document.getElementById('phone-search-results');
            const hit = PHONE_DIRECTORY.find(p => p.phone === raw);
            if (hit) {
                box.innerHTML = `
                    <button onclick="closeModal(); setQuickDestination('${escJs(hit.name)}', ${hit.lat}, ${hit.lon})" class="w-full p-3 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left flex items-center justify-between">
                        <div>
                            <div class="font-bold text-sm text-white">${hit.name}</div>
                            <div class="text-[10px] text-cyan-400 mt-0.5">タップして目的地に設定</div>
                        </div>
                        <span class="material-symbols-filled text-slate-500">chevron_right</span>
                    </button>
                `;
            } else {
                box.innerHTML = '<div class="text-xs text-red-400 p-2">該当する情報が見つかりませんでした</div>';
            }
        }

        function openCoordsSearchScreen() {
            playBeep();
            activeDestScreen = 'coords';
            const body = `
                <div class="space-y-3">
                    <div class="grid grid-cols-2 gap-2">
                        <input id="coord-lat-input" type="text" inputmode="decimal" placeholder="緯度 例: 35.6586" class="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-400">
                        <input id="coord-lon-input" type="text" inputmode="decimal" placeholder="経度 例: 139.7454" class="bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-red-400">
                    </div>
                    <button onclick="searchByCoords()" class="w-full py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold text-sm flex items-center justify-center gap-1.5">
                        <span class="material-symbols-filled text-lg">search</span> この座標を目的地に設定
                    </button>
                    <div id="coord-search-results" class="text-xs text-red-400"></div>
                    <button onclick="openDestinationCategoryMenu()" class="text-xs text-slate-400 hover:text-white underline">← カテゴリ選択に戻る</button>
                </div>
            `;
            openCustomModal('緯度経度で指定', body, { fullscreen: true });
        }

        function searchByCoords() {
            playBeep();
            const lat = parseFloat(document.getElementById('coord-lat-input').value);
            const lon = parseFloat(document.getElementById('coord-lon-input').value);
            const box = document.getElementById('coord-search-results');
            if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
                box.innerText = '有効な緯度・経度を入力してください';
                return;
            }
            closeModal();
            setQuickDestination(`地点(${lat.toFixed(4)}, ${lon.toFixed(4)})`, lat, lon);
        }

        function openMemoryPointsScreen() {
            playBeep();
            activeDestScreen = 'memory';
            const { favHtml } = renderFavoritesAndHistory();
            const body = `
                <div class="space-y-3">
                    <div class="space-y-1.5">${favHtml}</div>
                    <button onclick="addCurrentAsMemoryPoint()" class="w-full p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-dashed border-slate-600 text-slate-300 text-xs font-bold flex items-center justify-center gap-1.5">
                        <span class="material-symbols-filled text-sm">add_location_alt</span> 現在地をメモリ地点に追加
                    </button>
                    <button onclick="openDestinationCategoryMenu()" class="text-xs text-slate-400 hover:text-white underline">← カテゴリ選択に戻る</button>
                </div>
            `;
            openCustomModal('メモリ地点', body, { fullscreen: true });
        }

        function addCurrentAsMemoryPoint() {
            const [lat, lon] = currentPos;
            const name = `地点(${lat.toFixed(3)}, ${lon.toFixed(3)})`;
            addFavorite(name, lat, lon);
        }

        function openHistoryScreen() {
            playBeep();
            activeDestScreen = 'history';
            const { histHtml } = renderFavoritesAndHistory();
            const body = `
                <div class="space-y-2">${histHtml}</div>
                <button onclick="openDestinationCategoryMenu()" class="text-xs text-slate-400 hover:text-white underline mt-4">← カテゴリ選択に戻る</button>
            `;
            openCustomModal('履歴', body, { fullscreen: true });
        }

        function assignMemorySlot(i) {
            playBeep();
            pendingMemorySlotIndex = i;
            openAddressSearchScreen(`特別メモリ ${i + 1} に登録`, '登録する地点名・住所で検索');
        }

        function useMemorySlot(i) {
            const slot = memorySlots[i];
            if (!slot) return;
            playBeep();
            closeModal();
            setQuickDestination(slot.name, slot.lat, slot.lon);
        }

        function handleHomeRegisterTap() {
            playBeep();
            if (homeLocation) {
                closeModal();
                setQuickDestination(homeLocation.name || '自宅', homeLocation.lat, homeLocation.lon);
                return;
            }
            const body = `
                <div class="space-y-4 text-center py-2">
                    <span class="material-symbols-filled text-4xl text-emerald-400">home</span>
                    <div class="text-sm font-bold text-white">現在地を自宅として登録しますか？</div>
                    <div class="text-xs text-slate-400">登録すると次回から「自宅」ボタンで一発案内できます。</div>
                    <div class="flex gap-2 justify-center pt-2">
                        <button onclick="confirmRegisterHome()" class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm">現在地を登録</button>
                        <button onclick="openDestinationCategoryMenu()" class="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-sm">キャンセル</button>
                    </div>
                </div>
            `;
            openCustomModal('自宅登録', body);
        }

        function confirmRegisterHome() {
            playBeep();
            const [lat, lon] = currentPos;
            homeLocation = { name: '自宅', lat, lon };
            speakGuidance('現在地を自宅として登録しました。');
            openDestinationCategoryMenu();
        }

        // NEW: the previous free-text search screen (出発地/経由地/目的地 + AI route mode +
        // favorites/history) is kept intact and now reachable both via the 名称 category and
        // as a dedicated "full AI route search" shortcut from the new front menu.
        function openFullRouteSearchModal() { openDestinationModal(); }

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
            activeDestScreen = 'name';
            const { favHtml, histHtml } = renderFavoritesAndHistory();
            // NEW: now opened as a fullscreen modal (see openCustomModal's fullscreen option),
            // so the layout is reorganized into two columns on wider screens instead of one long
            // vertically-stacked column — search fields on the left, favorites/history/quick
            // destinations on the right, both visible without scrolling past the fold.
            const body = `
                <div class="sm:grid sm:grid-cols-[1.3fr_1fr] sm:gap-5 sm:items-start">
                    <div class="space-y-4">
                        <button onclick="openDestinationCategoryMenu()" class="text-xs text-slate-400 hover:text-white underline">← カテゴリ選択に戻る</button>
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
                    </div>

                    <div class="space-y-4 mt-4 sm:mt-0">
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
                </div>
            `;
            openCustomModal('目的地＆AI経路探索', body, { fullscreen: true });
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
        // onclick="...('...')" attribute (backslashes, single quotes, AND double quotes —
        // the double-quote escape matters because the onclick attribute itself is always
        // written with double quotes in this app's templates, so a literal " in the value
        // would otherwise terminate the HTML attribute early and corrupt the whole tag).
        function escJs(str) {
            return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
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
            const query = document.getElementById(inputId).value.trim();
            if (!query) return;

            const style = SEARCH_TARGET_STYLE[target] || SEARCH_TARGET_STYLE.dest;
            const box = document.getElementById(resId);
            box.innerHTML = `<div class="text-xs text-cyan-400 p-2 font-bold flex items-center gap-2"><span class="material-symbols-filled fa-spin">progress_activity</span> 位置情報照合中...</div>`;

            try {
                const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=jp&addressdetails=1&limit=5`;
                const res = await fetch(url);
                // BUGFIX: a non-OK response (rate-limited, temporarily down, etc.) used to fall
                // straight through to res.json(), which either threw a generic "通信エラー" or, if
                // the error page happened to parse as an empty array, silently showed "候補が
                // 見つかりませんでした" as if the place genuinely didn't exist. Both cases are now
                // routed into the same AI-assisted retry below instead of just giving up.
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();

                if (data.length === 0) {
                    // NEW: a plain geocoder has nothing for free-form/broad requests like "現在地
                    //付近の観光地" — try an AI-assisted interpretation instead of dead-ending here.
                    await searchLocationWithAiFallback(target, query, box, style);
                    return;
                }
                renderGeocodeResults(box, data, target, style);
            } catch (err) {
                await searchLocationWithAiFallback(target, query, box, style, true);
            }
        }

        // Renders plain Nominatim geocoding candidates as selectable cards.
        function renderGeocodeResults(box, data, target, style) {
            // BUGFIX: the place name/address/category text was inserted directly into the HTML
            // with no escaping at all — a result containing "&", "<", etc. (not rare in real
            // OSM data — company names, ampersands in addresses) could silently corrupt the
            // card's markup, which looked like "search returned nothing" even though Nominatim
            // had genuinely found matches.
            box.innerHTML = data.map(item => {
                const parts = item.display_name.split(',').map(p => p.trim());
                const name = parts[0];
                const address = parts.slice(1).join('、');
                const category = (item.type || item.class || '').replace(/_/g, ' ');
                return `
                <button onclick="selectSearchResult('${target}', '${escJs(name)}', ${item.lat}, ${item.lon})" class="w-full p-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 active:scale-[0.98] transition text-left border border-slate-700 flex items-start gap-3">
                    <span class="material-symbols-filled text-${style.color}-400 text-2xl shrink-0 mt-0.5">${style.icon}</span>
                    <div class="min-w-0 flex-1">
                        <div class="font-bold text-sm text-white truncate">${escapeHtml(name)}</div>
                        <div class="text-xs text-slate-400 leading-snug mt-0.5 line-clamp-2">${escapeHtml(address)}</div>
                        ${category ? `<div class="text-[10px] text-${style.color}-400 font-bold mt-1">${escapeHtml(category)}</div>` : ''}
                    </div>
                    <span class="material-symbols-filled text-slate-600 text-lg shrink-0 mt-0.5">chevron_right</span>
                </button>
            `;
            }).join('');
        }

        // NEW FEATURE: AI-assisted search fallback. Nominatim is a plain geocoder — it has
        // nothing for broad, natural-language requests like "現在地付近の観光地" or "この辺の
        // 美味しいラーメン屋", which just came back as "候補が見つかりませんでした" even though the
        // request was perfectly reasonable. This asks Gemini to interpret the query as either
        // (a) a specific real place name to re-geocode via the same Nominatim search, or (b) a
        // "nearby category" request, which is then answered with real OSM data via the same
        // Overpass-based nearby search the ジャンル category screen uses (fetchNearbyPOIs).
        async function searchLocationWithAiFallback(target, query, box, style, wasError = false) {
            const apiKey = getActiveGeminiApiKey();
            if (!apiKey) {
                box.innerHTML = wasError
                    ? '<div class="text-xs text-red-400 p-2">通信エラーが発生しました。しばらくしてからもう一度お試しください。</div>'
                    : '<div class="text-xs text-red-400 p-2">候補が見つかりませんでした。別の地名や住所でお試しください。<br><span class="text-slate-500">(「設定」でGemini APIキーを登録すると、「現在地付近の観光地」のような曖昧な検索もできるようになります)</span></div>';
                return;
            }

            box.innerHTML = `<div class="text-xs text-cyan-400 p-2 font-bold flex items-center gap-2"><span class="material-symbols-filled fa-spin">progress_activity</span> AIが検索意図を解析中...</div>`;

            try {
                const prompt = `あなたはカーナビの目的地検索アシスタントです。ユーザーが検索ボックスに入力した文字列を解釈してください。
現在地: 緯度${currentPos[0].toFixed(4)}, 経度${currentPos[1].toFixed(4)}
入力: 「${query}」

次のJSON形式で「のみ」回答してください（説明文・前置き・コードブロック記号は一切不要、JSON以外の文字を含めない）:
{"mode":"place","name":"具体的な地名・施設名（Nominatimで検索できる実在の名称に言い換えたもの）"}
または
{"mode":"nearby","category":"convenience|restaurant|cafe|gas_station|ev_charge|parking|hospital|hotel|attraction"}

「現在地付近の観光地」「この辺のコンビニ」のような周辺カテゴリ検索なら必ずnearby、特定の場所・施設名を指しているならplaceを選んでください。`;

                const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + apiKey, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        generationConfig: { maxOutputTokens: 150, thinkingConfig: { thinkingLevel: 'minimal' } }
                    })
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const json = await res.json();
                const text = json.candidates && json.candidates[0] && json.candidates[0].content &&
                    json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
                    json.candidates[0].content.parts[0].text;
                if (!text) throw new Error('no AI response');
                const cleaned = text.replace(/```json|```/g, '').trim();
                const parsed = JSON.parse(cleaned);

                if (parsed.mode === 'nearby' && parsed.category) {
                    await renderNearbySearchInline(box, target, style, parsed.category);
                    return;
                }

                const placeName = (parsed.name || query).trim();
                const geoUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(placeName)}&countrycodes=jp&addressdetails=1&limit=5`;
                const geoRes = await fetch(geoUrl);
                const geoData = await geoRes.json();
                if (!geoData.length) {
                    box.innerHTML = `<div class="text-xs text-red-400 p-2">「${escapeHtml(placeName)}」に該当する候補が見つかりませんでした。</div>`;
                    return;
                }
                renderGeocodeResults(box, geoData, target, style);
            } catch (err) {
                box.innerHTML = '<div class="text-xs text-red-400 p-2">候補が見つかりませんでした。別のキーワードでお試しください。</div>';
            }
        }

        // Renders a "nearby category" AI-fallback result inline in the search results box,
        // reusing the real Overpass-based nearby search (see fetchNearbyPOIs).
        async function renderNearbySearchInline(box, target, style, category) {
            const label = NEARBY_LABEL_MAP[category] || '周辺スポット';
            box.innerHTML = `<div class="text-xs text-cyan-400 p-2 font-bold flex items-center gap-2"><span class="material-symbols-filled fa-spin">progress_activity</span> ${escapeHtml(label)}を検索中...</div>`;
            try {
                const pois = await fetchNearbyPOIs(category, 8);
                if (!pois.length) {
                    box.innerHTML = `<div class="text-xs text-red-400 p-2">周辺3km以内に${escapeHtml(label)}が見つかりませんでした。</div>`;
                    return;
                }
                box.innerHTML = `<div class="text-[10px] text-cyan-400 font-bold px-1 pb-1">AI検索: ${escapeHtml(label)}</div>` + pois.map(p => `
                    <button onclick="selectSearchResult('${target}', '${escJs(p.name)}', ${p.lat}, ${p.lon})" class="w-full p-3 rounded-2xl bg-slate-800 hover:bg-slate-700 active:scale-[0.98] transition text-left border border-slate-700 flex items-center justify-between gap-2 mb-1.5">
                        <div class="flex items-center gap-2.5 min-w-0">
                            <span class="material-symbols-filled text-${style.color}-400 text-xl shrink-0">${style.icon}</span>
                            <span class="font-bold text-sm text-white truncate">${escapeHtml(p.name)}</span>
                        </div>
                        <span class="text-[10px] text-cyan-300 font-black digital-font whitespace-nowrap shrink-0">${p.distM < 1000 ? Math.round(p.distM) + 'm' : (p.distM / 1000).toFixed(1) + 'km'}</span>
                    </button>
                `).join('');
            } catch (err) {
                box.innerHTML = '<div class="text-xs text-red-400 p-2">周辺検索中にエラーが発生しました。通信環境をご確認ください。</div>';
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
                // NEW: if this search was launched to fill a 特別メモリ slot (see
                // assignMemorySlot), save the result there instead of routing immediately —
                // matching a real memory-point registration, which just saves the spot.
                if (pendingMemorySlotIndex !== null) {
                    const savedNo = pendingMemorySlotIndex + 1;
                    memorySlots[pendingMemorySlotIndex] = { name, lat, lon };
                    pendingMemorySlotIndex = null;
                    speakGuidance(`特別メモリ${savedNo}に${name}を登録しました。`);
                    closeModal();
                    openDestinationCategoryMenu();
                    return;
                }
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

        async function calculateAndDrawRoute(destName = '目的地', opts = {}) {
            if (!destinationPos) return;
            // NEW: mid-drive reroutes (recalculateRoute) pass autoStart so the vehicle just
            // keeps driving on the new route immediately — showing a "案内開始?" confirmation
            // mid-drive would be strange since guidance is already active. A destination
            // freshly picked from search, on the other hand, no longer starts moving the
            // instant you tap it — the route is calculated and drawn as a preview, and actual
            // turn-by-turn guidance only begins once the driver taps 案内開始 below (see
            // showRoutePreviewBar / confirmStartGuidance).
            const autoStart = !!opts.autoStart;
            // NEW: mid-drive reroutes (recalculateRoute) now start from the vehicle's current
            // simulated position on the road, not the original trip's origin — previously a
            // manual "reroute" during a drive would snap back to wherever the trip started from.
            const startPoint = (simCoords.length > 0 && simTraveledM > 0) ? simCoords[simIndex] : (originPos || currentPos);
            // NEW FEATURE: optional single waypoint ("経由地") — OSRM accepts a
            // semicolon-separated chain of coordinates and returns one continuous route
            // across all of them, with a separate `legs` entry per leg.
            const coordChain = [startPoint, ...(viaPoint ? [viaPoint] : []), destinationPos]
                .map(p => `${p[1]},${p[0]}`).join(';');
            // NEW: the route type the driver picked now actually changes the routing query
            // instead of only relabeling the same route. "ECO・景観優先" excludes motorways
            // (OSRM's public demo server supports exclude=motorway on its car profile), giving
            // a genuinely different, lower-speed-road route rather than just a different badge.
            const excludeParam = selectedRouteMode === 'ECO・景観優先' ? '&exclude=motorway' : '';
            const url = `https://router.project-osrm.org/route/v1/driving/${coordChain}?overview=full&geometries=geojson&steps=true${excludeParam}`;

            try {
                const res = await fetch(url);
                const data = await res.json();
                if (!data.routes || data.routes.length === 0) {
                    // NEW: previously failed silently (empty catch/branch) — a driver picking an
                    // unreachable destination or losing connectivity just saw nothing happen.
                    speakGuidance('経路を計算できませんでした。目的地を変更するか、通信環境をご確認ください。');
                    return;
                }

                const route = data.routes[0];
                // NEW: OSRM's raw geometry points can be tens of meters apart on tight curves
                // (highway interchange loops, curved intersections) — driving in a straight line
                // between two such points visually cuts across the inside of the curve instead of
                // following the road, which is the "car drives off the road" symptom. This inserts
                // extra points along a Catmull-Rom spline that passes through every real
                // (road-snapped) point OSRM gave us, so the path still hugs the actual curve
                // between them instead of a straight chord.
                simCoords = densifyRouteCoords(route.geometry.coordinates.map(c => [c[1], c[0]]));
                simSteps = route.legs.flatMap(leg => leg.steps); // flatten all legs (origin→via, via→dest)
                buildRouteDistanceTables();
                simTraveledM = 0;
                simCurrentSpeedMps = 0;
                simLastFrameTime = null;
                lastAnnouncedStepIdx = { far: -1, mid: -1, near: -1, now: -1 };
                lastLongStraightAnnounceIdx = -1;
                jctListManuallyHidden = false;
                lastRenderedJctStepIdx = -1;
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

                if (autoStart) {
                    beginActiveGuidance(destName);
                } else {
                    showRoutePreviewBar(destName, route.distance, route.duration);
                }
            } catch (err) {
                // NEW: was previously a silent no-op, indistinguishable from the button doing
                // nothing at all.
                speakGuidance('通信エラーにより経路探索に失敗しました。もう一度お試しください。');
            }
        }

        // NEW: actually starts turn-by-turn guidance (voice + driving simulation) — split out
        // of calculateAndDrawRoute so a freshly-picked destination can show a route preview
        // with a 案内開始 button first instead of driving off immediately.
        function beginActiveGuidance(destName) {
            speakGuidance(viaPoint
                ? `AI探索完了。${viaPointName}経由、${selectedRouteMode}ルートで${destName}までの案内を開始します。`
                : `AI探索完了。${selectedRouteMode}ルートで${destName}までの案内を開始します。`);
            hideRoutePreviewBar();
            const stopBtn = document.getElementById('btn-stop-guidance');
            if (stopBtn) stopBtn.classList.remove('hidden');
            startSmoothDrivingSimulation();
        }

        // NEW: floating bottom bar shown once a destination's route has been calculated and
        // drawn on the map, but before guidance actually starts — lets the driver see the
        // route + ETA/distance first and confirm, or cancel, instead of guidance beginning
        // the instant a search result is tapped.
        let pendingGuidanceDestName = '';
        function showRoutePreviewBar(destName, distanceM, durationS) {
            pendingGuidanceDestName = destName;
            const bar = document.getElementById('route-preview-bar');
            if (!bar) { beginActiveGuidance(destName); return; } // safety fallback
            const nameEl = document.getElementById('route-preview-name');
            const distEl = document.getElementById('route-preview-dist');
            const etaEl = document.getElementById('route-preview-eta');
            if (nameEl) nameEl.innerText = destName;
            if (distEl) distEl.innerText = distanceM >= 1000 ? (distanceM / 1000).toFixed(1) + ' km' : Math.round(distanceM) + ' m';
            if (etaEl) {
                const arrival = new Date(Date.now() + durationS * 1000);
                etaEl.innerText = `${String(arrival.getHours()).padStart(2, '0')}:${String(arrival.getMinutes()).padStart(2, '0')} 到着予定`;
            }
            bar.classList.remove('hidden');
        }

        function hideRoutePreviewBar() {
            const bar = document.getElementById('route-preview-bar');
            if (bar) bar.classList.add('hidden');
        }

        function confirmStartGuidance() {
            playBeep();
            beginActiveGuidance(pendingGuidanceDestName || currentDestName || '目的地');
        }

        // NEW: cancels a route that was only ever previewed (案内開始 never pressed) — clears
        // the drawn route and destination entirely rather than leaving a route on the map
        // with no way to get rid of it.
        function cancelRoutePreview() {
            playBeep();
            hideRoutePreviewBar();
            if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
            destinationPos = null;
            currentDestName = '';
            const banner = document.getElementById('top-route-banner');
            if (banner) banner.classList.add('hidden');
            const simSpeedBadge = document.getElementById('btn-sim-speed');
            if (simSpeedBadge) simSpeedBadge.classList.add('hidden');
            speakGuidance('目的地の設定を取り消しました。');
        }

        // NEW: stops guidance even while it's actively running (previously there was no way
        // to cancel a drive already in progress short of picking an entirely new destination).
        function stopGuidance() {
            playBeep();
            if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
            if (routePolyline) { map.removeLayer(routePolyline); routePolyline = null; }
            destinationPos = null;
            currentDestName = '';
            simCoords = [];
            simSteps = [];
            simTraveledM = 0;
            simCurrentSpeedMps = 0;
            updateSafetyMonitor(0);

            const banner = document.getElementById('top-route-banner');
            if (banner) banner.classList.add('hidden');
            const simSpeedBadge = document.getElementById('btn-sim-speed');
            if (simSpeedBadge) simSpeedBadge.classList.add('hidden');
            const jctBox = document.getElementById('junction-3d-container');
            if (jctBox) jctBox.classList.add('hidden');
            const jctListPanel = document.getElementById('jct-list-panel');
            if (jctListPanel) jctListPanel.classList.add('hidden');
            hideRoutePreviewBar();
            const stopBtn = document.getElementById('btn-stop-guidance');
            if (stopBtn) stopBtn.classList.add('hidden');
            updateMapRotation();
            speakGuidance('案内を中止しました。');
        }

        function startSmoothDrivingSimulation() {
            if (animFrameId) cancelAnimationFrame(animFrameId);
            simLastFrameTime = null;

            function animateStep(now) {
                const total = simCumDistM[simCumDistM.length - 1] || 0;

                if (simTraveledM >= total && total > 0) {
                    speakGuidance('目的地付近に到着しました。');
                    document.getElementById('junction-3d-container').classList.add('hidden');
                    const stopBtn = document.getElementById('btn-stop-guidance');
                    if (stopBtn) stopBtn.classList.add('hidden');
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

                // Rotate Car Icon Arrow + Map
                // FIXED: the car icon's own rotation now always reflects the vehicle's true
                // compass heading (in both modes) — it's the *map* that rotates in
                // "ヘディングアップ" mode (see updateMapRotation) so the travel direction always
                // points up on screen while the car icon itself stays visually fixed pointing
                // up; in "ノースアップ" mode the map stays fixed north and the car icon rotates
                // to show its real heading, as before.
                const carElem = document.getElementById('car-arrow-element');
                if (carElem) {
                    carElem.style.transform = `rotate(${currentHeading}deg)`;
                }
                updateMapRotation();
                // The small corner compass arrow continuously shows the vehicle's real travel
                // direction relative to true north (like a real compass needle), independent of
                // which map display mode is active.
                const compassArrow = document.getElementById('compass-arrow');
                if (compassArrow) compassArrow.style.transform = `rotate(${currentHeading}deg)`;

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
            if (label) label.innerText = safetyAssistOn ? 'ON' : 'OFF';
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
        // NEW: replaces cycleDriveMode() now that the mode switcher lives in 設定 as three
        // explicit buttons instead of a single top-bar badge you clicked repeatedly to cycle.
        function setDriveMode(mode) {
            playBeep();
            driveMode = mode;
            const bezel = document.getElementById('toyota-bezel');
            if (mode === 'SPORT') {
                if (bezel) bezel.classList.add('sport-mode');
                speakGuidance('スポーツモードが選択されました。レスポンスを強化します。');
            } else {
                if (bezel) bezel.classList.remove('sport-mode');
                speakGuidance(mode === 'ECO' ? 'エコモードが選択されました。環境優先走行を行います。' : 'ノーマルモードに戻りました。');
            }
            // If 設定 is currently open showing the mode picker, refresh which option looks active.
            ['NORMAL', 'SPORT', 'ECO'].forEach(m => {
                const btn = document.getElementById('drive-mode-opt-' + m);
                if (btn) btn.classList.toggle('drive-mode-opt-active', m === mode);
            });
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

        /* ====================================================================
           NEW: Gemini-style chat UI (matches the real Gemini app's look) —
           - Bottom-left mic button (triggerVoiceAgent) = voice-only entry point: opens the
             chat and immediately starts listening.
           - Right-side asteroid/sparkle icon button (openGeminiChat) = text entry point:
             opens the same chat for typing, without touching the mic.
           Both share one running conversation (geminiChatHistory) rendered as chat bubbles:
           user messages as right-aligned bubbles, model replies as plain left-aligned text
           with a small action-icon row (copy / share / read aloud / thumbs up / thumbs down
           / more) underneath, plus the standard AI-disclaimer line under the latest reply.
           ==================================================================== */
        let geminiChatHistory = []; // {role: 'user'|'model', text, isError}

        function escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        function triggerVoiceAgent() {
            playBeep();
            openGeminiChatModal();
            // 左下のマイクボタンはあくまで音声入力専用の入口 — 開いたら自動で音声認識を開始する
            setTimeout(() => startVoiceRecognition(), 300);
        }

        // NEW: the right-side asteroid/sparkle (Gemini) button — text-entry point, opens the
        // same chat without auto-starting the microphone.
        function openGeminiChat() {
            playBeep();
            openGeminiChatModal();
            setTimeout(() => { const el = document.getElementById('ai-query-input'); if (el) el.focus(); }, 50);
        }

        function openGeminiChatModal() {
            if (geminiChatHistory.length === 0) {
                geminiChatHistory.push({
                    role: 'model',
                    text: 'やあ！こんにちは！\n今日は何か調べたいことや、一緒に進めたい作業とかある？気軽になんでも聞いてね！目的地検索やエアコン設定、周辺情報の質問にもお答えできます。'
                });
            }
            const body = `
                <div id="gemini-chat-messages" class="space-y-4 pb-1"></div>
                <div class="sticky bottom-0 -mx-4 sm:-mx-5 -mb-4 sm:-mb-5 px-4 sm:px-5 pt-3 pb-4 sm:pb-5 mt-4 bg-slate-900/95 backdrop-blur border-t border-slate-800">
                    <div class="flex items-center gap-1.5 bg-slate-800 rounded-full pl-3 pr-1.5 py-1.5 border border-slate-700 focus-within:border-cyan-400 transition">
                        <button class="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-700 transition" title="添付(準備中)">
                            <span class="material-symbols-filled text-lg">add</span>
                        </button>
                        <input id="ai-query-input" type="text" placeholder="Geminiに相談" class="flex-1 bg-transparent text-sm text-white placeholder-slate-500 focus:outline-none" onkeydown="if(event.key==='Enter') submitAiQuery()">
                        <button onclick="startVoiceRecognition()" id="ai-mic-btn" class="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-300 hover:text-white hover:bg-slate-700 transition" title="音声入力">
                            <span class="material-symbols-filled text-lg">mic</span>
                        </button>
                        <button onclick="submitAiQuery()" class="w-9 h-9 shrink-0 rounded-full bg-blue-600 hover:bg-blue-500 flex items-center justify-center text-white transition" title="送信">
                            <span class="material-symbols-filled text-lg">send</span>
                        </button>
                    </div>
                </div>
            `;
            openCustomModal('Gemini', body, { fullscreen: true, hideFooter: true });
            renderGeminiChatMessages();
        }

        // NEW: renders the running conversation as chat bubbles, matching the real Gemini
        // app — user turns as right-aligned filled bubbles, model turns as plain text with
        // an action-icon row (and the standard AI disclaimer under the newest reply only).
        function renderGeminiChatMessages() {
            const el = document.getElementById('gemini-chat-messages');
            if (!el) return;
            const lastModelIdx = geminiChatHistory.reduce((acc, m, i) => m.role === 'model' ? i : acc, -1);

            el.innerHTML = geminiChatHistory.map((m, i) => {
                if (m.role === 'user') {
                    return `
                        <div class="flex justify-end">
                            <div class="bg-slate-700 text-white rounded-3xl rounded-br-lg px-4 py-2.5 max-w-[82%] text-sm leading-relaxed whitespace-pre-wrap">${escapeHtml(m.text)}</div>
                        </div>
                    `;
                }
                return `
                    <div class="space-y-2">
                        <div class="text-sm leading-relaxed whitespace-pre-wrap ${m.isError ? 'text-amber-300' : 'text-slate-100'}">${m.html || escapeHtml(m.text)}</div>
                        ${!m.pending ? `
                        <div class="flex items-center gap-3 text-slate-500">
                            <button onclick="copyGeminiMessage(${i})" class="hover:text-white transition" title="コピー"><span class="material-symbols-filled text-[19px]">content_copy</span></button>
                            <button onclick="shareGeminiMessage(${i})" class="hover:text-white transition" title="共有"><span class="material-symbols-filled text-[19px]">ios_share</span></button>
                            <button onclick="speakGeminiMessage(${i})" class="hover:text-white transition" title="読み上げ"><span class="material-symbols-filled text-[19px]">volume_up</span></button>
                            <button onclick="rateGeminiMessage(${i}, true, this)" class="gemini-rate-btn hover:text-white transition" title="高評価"><span class="material-symbols-filled text-[19px]">thumb_up</span></button>
                            <button onclick="rateGeminiMessage(${i}, false, this)" class="gemini-rate-btn hover:text-white transition" title="低評価"><span class="material-symbols-filled text-[19px]">thumb_down</span></button>
                            <button class="hover:text-white transition" title="その他"><span class="material-symbols-filled text-[19px]">more_horiz</span></button>
                        </div>
                        ${i === lastModelIdx ? '<div class="text-[10px] text-slate-500">Gemini は AI であり、不正確な情報を提示することがあります。</div>' : ''}
                        ` : ''}
                    </div>
                `;
            }).join('');
            el.scrollTop = el.scrollHeight;
        }

        function copyGeminiMessage(i) {
            playBeep();
            const msg = geminiChatHistory[i];
            if (msg && navigator.clipboard) navigator.clipboard.writeText(msg.text).catch(() => {});
        }

        function shareGeminiMessage(i) {
            playBeep();
            const msg = geminiChatHistory[i];
            if (!msg) return;
            if (navigator.share) {
                navigator.share({ text: msg.text }).catch(() => {});
            } else if (navigator.clipboard) {
                navigator.clipboard.writeText(msg.text).catch(() => {});
            }
        }

        function speakGeminiMessage(i) {
            const msg = geminiChatHistory[i];
            if (msg) speakGuidance(msg.text);
        }

        // Cosmetic feedback only (mirrors the real Gemini app's thumbs up/down) — there's no
        // backend here to actually send a rating to.
        function rateGeminiMessage(i, liked, btnEl) {
            playBeep();
            const row = btnEl.parentElement;
            if (!row) return;
            row.querySelectorAll('.gemini-rate-btn').forEach(b => b.classList.remove('text-cyan-400'));
            btnEl.classList.add('text-cyan-400');
        }

        function startVoiceRecognition() {
            playBeep();
            const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
            const micBtn = document.getElementById('ai-mic-btn');
            if (!SR) {
                pushGeminiSystemNote('この環境では音声入力を利用できません。テキストで入力してください。');
                return;
            }
            try {
                const recog = new SR();
                recog.lang = 'ja-JP';
                recog.interimResults = false;
                if (micBtn) micBtn.classList.add('text-red-400');
                recog.onresult = (e) => {
                    const input = document.getElementById('ai-query-input');
                    if (input) input.value = e.results[0][0].transcript;
                    submitAiQuery();
                };
                recog.onerror = () => {
                    pushGeminiSystemNote('音声を認識できませんでした。テキストで入力してください。');
                };
                recog.onend = () => { if (micBtn) micBtn.classList.remove('text-red-400'); };
                recog.start();
            } catch (err) {
                pushGeminiSystemNote('この環境(埋め込み画面)ではマイクにアクセスできません。テキストで入力してください。');
            }
        }

        // Adds a plain model-side note to the transcript without going through Gemini
        // (used for local-only messages: missing mic support, missing API key, etc.)
        function pushGeminiSystemNote(text, isError = true) {
            geminiChatHistory.push({ role: 'model', text, isError });
            renderGeminiChatMessages();
        }

        function submitAiQuery() {
            const input = document.getElementById('ai-query-input');
            const query = input.value.trim();
            if (!query) return;
            playBeep();
            input.value = '';

            geminiChatHistory.push({ role: 'user', text: query });
            renderGeminiChatMessages();

            // BUGFIX: previously this always hit Google with GEMINI_API_KEY exactly as
            // hard-coded in this file — if that was still the untouched placeholder text (or
            // a source edit never actually reached the deployed copy), the fetch would go
            // out anyway and come back with Google's own "API key not valid" error, which
            // reads like an unexplained bug rather than "no key is configured". A key saved
            // in 設定 is checked FIRST (see getActiveGeminiApiKey), and a clear, actionable
            // message is shown immediately, with no network round-trip.
            const apiKey = getActiveGeminiApiKey();
            if (!apiKey) {
                geminiChatHistory.push({
                    role: 'model',
                    text: 'Gemini APIキーが設定されていません。「設定」→「AIアシスタント (Gemini)」欄でご自身のAPIキーを入力・保存してください。',
                    html: 'Gemini APIキーが設定されていません。<br>「設定」→「AIアシスタント (Gemini)」欄でご自身のAPIキーを入力・保存してください。<br>' +
                        '<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="underline text-cyan-300">キーの取得はこちら (Google AI Studio・無料)</a>',
                    isError: true
                });
                renderGeminiChatMessages();
                return;
            }

            geminiChatHistory.push({ role: 'model', text: '考え中...', pending: true });
            const pendingIdx = geminiChatHistory.length - 1;
            renderGeminiChatMessages();

            // BUGFIX/NEW: the assistant's own greeting promises it can help with "目的地検索"
            // (destination search), but previously it only ever produced a spoken-style text
            // reply with no way to actually act on it — asking it to navigate somewhere just
            // got a conversational (non-)answer that read as "目的地案内できない". Gemini is
            // now instructed to flag genuine navigation requests with a "NAVIGATE: <place>"
            // marker line, which is parsed below and fed into the same real geocoding +
            // route-calculation flow the destination-search screens use.
            const context = `あなたはトヨタ車のカーナビ・AIアシスタントです。運転中に自然に読み上げられる、簡潔な日本語(2〜3文以内)で答えてください。
現在地: 緯度${currentPos[0].toFixed(4)}, 経度${currentPos[1].toFixed(4)}
目的地: ${currentDestName || '未設定'}
車内温度設定: 運転席${driverTemp}°C

もしユーザーの質問が「〜へ案内して」「〜に行きたい」「〜まで連れて行って」のような、具体的な場所への
道案内・ルート設定の依頼であれば、回答の1行目を必ず次の形式にしてください（他の文章は一切含めない）:
NAVIGATE: <場所の名前>
そうでない通常の質問には、この形式は使わず普通に回答してください。

質問: ${query}`;

            // GitHub Pages版: サーバーがいないのでブラウザから直接Gemini APIを叩く。
            // ⚠️ 設定画面で保存したGemini APIキーは、このブラウザのlocalStorageに平文で
            // 保存され、ソースからも(そのブラウザ内では)読める状態になります。
            // 個人の学習・文化祭用途などキーが漏れても実害が小さい前提での簡易実装です。
            // 本気で守りたい場合は Cloudflare Workers 等の無料サーバーレスプロキシを別途挟んでください。
            fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + apiKey, {
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
                    if (!text) {
                        geminiChatHistory[pendingIdx] = { role: 'model', text: '応答を取得できませんでした。', isError: true };
                        renderGeminiChatMessages();
                        return;
                    }

                    const navMatch = text.match(/^NAVIGATE:\s*(.+?)\s*$/m);
                    if (navMatch) {
                        handleAiNavigationRequest(navMatch[1], pendingIdx);
                        return;
                    }

                    geminiChatHistory[pendingIdx] = { role: 'model', text };
                    renderGeminiChatMessages();
                    speakGuidance(text);
                })
                .catch(err => {
                    geminiChatHistory[pendingIdx] = {
                        role: 'model',
                        text: 'エラー: AIサーバーに接続できませんでした。(' + (err && err.message ? err.message : err) + ')',
                        isError: true
                    };
                    renderGeminiChatMessages();
                });
        }

        // NEW: turns an AI-recognized navigation request into a real route, reusing the
        // same Nominatim geocoding already used everywhere else in destination search.
        function handleAiNavigationRequest(placeQuery, pendingIdx) {
            geminiChatHistory[pendingIdx] = { role: 'model', text: `${placeQuery}を検索中...`, pending: true };
            renderGeminiChatMessages();
            const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(placeQuery)}&countrycodes=jp&addressdetails=1&limit=1`;
            fetch(url)
                .then(res => res.json())
                .then(data => {
                    if (!data || data.length === 0) {
                        geminiChatHistory[pendingIdx] = { role: 'model', text: `「${placeQuery}」の場所が見つかりませんでした。目的地検索から住所や名称でお試しください。`, isError: true };
                        renderGeminiChatMessages();
                        speakGuidance(`すみません、${placeQuery}が見つかりませんでした。`);
                        return;
                    }
                    const item = data[0];
                    const name = item.display_name.split(',')[0].trim();
                    const lat = parseFloat(item.lat), lon = parseFloat(item.lon);
                    geminiChatHistory[pendingIdx] = { role: 'model', text: `✓ ${name} を目的地に設定しました。` };
                    renderGeminiChatMessages();
                    destinationPos = [lat, lon];
                    currentDestName = name;
                    recentDestinations = recentDestinations.filter(h => h.name !== name);
                    recentDestinations.unshift({ name, lat, lon });
                    if (recentDestinations.length > 8) recentDestinations.length = 8;
                    closeModal();
                    startAIRouteCalculationAnimation(name);
                })
                .catch(() => {
                    geminiChatHistory[pendingIdx] = { role: 'model', text: '場所の検索中に通信エラーが発生しました。', isError: true };
                    renderGeminiChatMessages();
                });
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
            const soundOptions = (current) => `
                <option value="default" ${current === 'default' ? 'selected' : ''}>標準 (ピッ)</option>
                <option value="soft" ${current === 'soft' ? 'selected' : ''}>ソフト</option>
                <option value="chime" ${current === 'chime' ? 'selected' : ''}>チャイム</option>
                <option value="off" ${current === 'off' ? 'selected' : ''}>オフ</option>
            `;
            const hasKey = !!getActiveGeminiApiKey();
            const body = `
                <div class="space-y-3 text-xs">
                    <!-- NEW: moved here from the top status bar's "MODE: NORMAL" badge, which
                         was contributing to the top bar getting crowded/overflowing. -->
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2">
                        <div class="font-bold text-cyan-400 text-sm border-b border-slate-800 pb-1">走行モード</div>
                        <div class="grid grid-cols-3 gap-2">
                            <button id="drive-mode-opt-NORMAL" onclick="setDriveMode('NORMAL')" class="p-2.5 rounded-xl bg-blue-900/60 border border-blue-500 text-cyan-200 font-black text-xs ${driveMode === 'NORMAL' ? 'drive-mode-opt-active' : ''}">
                                <span class="material-symbols-filled text-lg block mb-0.5">directions_car</span> NORMAL
                            </button>
                            <button id="drive-mode-opt-SPORT" onclick="setDriveMode('SPORT')" class="p-2.5 rounded-xl bg-red-900/60 border border-red-500 text-red-200 font-black text-xs ${driveMode === 'SPORT' ? 'drive-mode-opt-active' : ''}">
                                <span class="material-symbols-filled text-lg block mb-0.5">bolt</span> SPORT
                            </button>
                            <button id="drive-mode-opt-ECO" onclick="setDriveMode('ECO')" class="p-2.5 rounded-xl bg-emerald-900/60 border border-emerald-500 text-emerald-200 font-black text-xs ${driveMode === 'ECO' ? 'drive-mode-opt-active' : ''}">
                                <span class="material-symbols-filled text-lg block mb-0.5">eco</span> ECO
                            </button>
                        </div>
                    </div>

                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2">
                        <div class="font-bold text-cyan-400 text-sm border-b border-slate-800 pb-1">Toyota Safety Sense & 3D表示設定</div>
                        <div class="flex justify-between items-center py-1">
                            <span class="font-bold text-white">3Dジャンクション案内を有効化</span>
                            <input type="checkbox" ${enable3DJunction ? 'checked' : ''} onchange="toggle3DJunctionEnable(this.checked)" class="m3-switch m3-blue">
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">PDA (プロアクティブドライビングアシスト)</span>
                            <input type="checkbox" checked class="m3-switch m3-blue">
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">安全運転支援 HUD (前方衝突・車線逸脱・速度超過)</span>
                            <input type="checkbox" ${safetyAssistOn ? 'checked' : ''} onchange="toggleSafetyAssist(this.checked)" class="m3-switch m3-red">
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
                    </div>

                    <!-- NEW: sound & startup-animation customization -->
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2">
                        <div class="font-bold text-cyan-400 text-sm border-b border-slate-800 pb-1">サウンド・起動アニメーション</div>
                        <div class="flex justify-between items-center py-1">
                            <span class="font-bold text-white">ボタン操作音</span>
                            <select onchange="setAppSetting('buttonSound', this.value)" class="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-cyan-400">
                                ${soundOptions(appSettings.buttonSound)}
                            </select>
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">ナビ音声の効果音</span>
                            <select onchange="setAppSetting('navChime', this.value)" class="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-cyan-400">
                                ${soundOptions(appSettings.navChime)}
                            </select>
                        </div>
                        <div class="flex justify-between items-center py-1 border-t border-slate-800">
                            <span class="font-bold text-white">起動アニメーション</span>
                            <div class="flex items-center gap-1.5">
                                <select onchange="setAppSetting('bootAnimation', this.value)" class="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-[11px] text-white focus:outline-none focus:border-cyan-400">
                                    <option value="classic" ${appSettings.bootAnimation === 'classic' ? 'selected' : ''}>クラシック</option>
                                    <option value="radial" ${appSettings.bootAnimation === 'radial' ? 'selected' : ''}>ラジアルグロー</option>
                                    <option value="minimal" ${appSettings.bootAnimation === 'minimal' ? 'selected' : ''}>ミニマル</option>
                                </select>
                                <button onclick="closeModal(); playBootAnimation();" class="px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold text-cyan-300 flex items-center gap-1 shrink-0">
                                    <span class="material-symbols-filled text-xs">play_arrow</span> 再生
                                </button>
                            </div>
                        </div>
                    </div>

                    <!-- NEW: Gemini APIキーをアプリ内で設定できるようにする（ソースコード編集不要） -->
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2">
                        <div class="font-bold text-cyan-400 text-sm border-b border-slate-800 pb-1">AIアシスタント (Gemini)</div>
                        <div class="text-[10px] text-slate-500 leading-relaxed">
                            このブラウザだけに保存され、どこにも送信されません。取得は
                            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="underline text-cyan-300">Google AI Studio</a> から無料でできます。
                        </div>
                        <div class="flex items-center gap-1.5">
                            <input id="gemini-key-input" type="password" value="${(appSettings.geminiApiKey || '').replace(/"/g, '&quot;')}" placeholder="AIzaSy... を貼り付け" class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-2 text-[11px] text-white placeholder-slate-500 focus:outline-none focus:border-cyan-400">
                            <button onclick="toggleGeminiKeyVisibility()" id="gemini-key-toggle-btn" class="w-9 h-9 shrink-0 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 flex items-center justify-center text-slate-300" title="表示/非表示">
                                <span class="material-symbols-filled text-base">visibility</span>
                            </button>
                        </div>
                        <div class="flex items-center gap-1.5">
                            <button onclick="saveGeminiApiKey()" class="flex-1 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white font-bold text-[11px]">保存</button>
                            <button onclick="clearGeminiApiKey()" class="py-2 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 font-bold text-[11px]">削除</button>
                        </div>
                        <div id="gemini-key-status" class="text-[10px] font-bold ${hasKey ? 'text-emerald-400' : 'text-amber-400'}">
                            ${hasKey ? '✓ APIキー設定済み' : '⚠ 未設定 — AIアシスタントを使うには入力してください'}
                        </div>
                    </div>
                </div>
            `;
            openCustomModal('T-Connect 設定', body);
        }

        // NEW: applies + persists one of the sound/animation preferences above.
        function setAppSetting(key, value) {
            appSettings[key] = value;
            saveAppSettings();
            playBeep(key === 'navChime' ? 'nav' : 'click');
        }

        function toggleGeminiKeyVisibility() {
            const input = document.getElementById('gemini-key-input');
            const btn = document.getElementById('gemini-key-toggle-btn');
            if (!input) return;
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            const icon = btn && btn.querySelector('span');
            if (icon) icon.innerText = showing ? 'visibility' : 'visibility_off';
        }

        function saveGeminiApiKey() {
            playBeep();
            const input = document.getElementById('gemini-key-input');
            appSettings.geminiApiKey = input ? input.value.trim() : '';
            saveAppSettings();
            const ok = !!getActiveGeminiApiKey();
            const status = document.getElementById('gemini-key-status');
            if (status) {
                status.className = `text-[10px] font-bold ${ok ? 'text-emerald-400' : 'text-amber-400'}`;
                status.innerText = ok ? '✓ APIキーを保存しました' : '⚠ 未設定 — AIアシスタントを使うには入力してください';
            }
            speakGuidance(ok ? 'Gemini APIキーを保存しました。' : 'Gemini APIキーを削除しました。');
        }

        function clearGeminiApiKey() {
            playBeep();
            appSettings.geminiApiKey = '';
            saveAppSettings();
            const input = document.getElementById('gemini-key-input');
            if (input) input.value = '';
            const ok = !!getActiveGeminiApiKey();
            const status = document.getElementById('gemini-key-status');
            if (status) {
                status.className = `text-[10px] font-bold ${ok ? 'text-emerald-400' : 'text-amber-400'}`;
                status.innerText = ok ? '✓ APIキー設定済み' : '⚠ 未設定 — AIアシスタントを使うには入力してください';
            }
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
                    <!-- NEW: moved here from the right-side hw-strip, which now hosts the
                         Gemini launcher button instead. -->
                    <div class="flex items-center justify-between bg-slate-950 border border-slate-800 rounded-xl px-3 py-2.5 mt-1">
                        <span class="font-bold text-white text-xs">スプリット画面 (地図+情報パネル)</span>
                        <input type="checkbox" ${splitScreenOpen ? 'checked' : ''} onchange="toggleSplitScreen()" class="m3-switch m3-blue">
                    </div>
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

        // NEW: shared by openNearbyPOI (ジャンル category screen) and the AI-assisted
        // destination search fallback below, so both use one real Overpass-based nearby
        // search instead of duplicating the query logic.
        const OVERPASS_TAG_MAP = {
            convenience: 'shop=convenience',
            gas_station: 'amenity=fuel',
            ev_charge: 'amenity=charging_station',
            parking: 'amenity=parking',
            restaurant: 'amenity=restaurant',
            cafe: 'amenity=cafe',
            hospital: 'amenity=hospital',
            hotel: 'tourism=hotel',
            attraction: 'tourism=attraction'
        };
        const NEARBY_LABEL_MAP = {
            convenience: '周辺コンビニ', gas_station: 'ガソリンスタンド', ev_charge: 'EV充電スポット', parking: '周辺駐車場',
            restaurant: '周辺飲食店', cafe: '周辺カフェ', hospital: '周辺病院', hotel: '周辺ホテル', attraction: '周辺観光地'
        };

        async function fetchNearbyPOIs(type, limit = 10) {
            const tagQuery = OVERPASS_TAG_MAP[type] || OVERPASS_TAG_MAP.convenience;
            const [lat, lon] = currentPos;
            const radius = 3000;
            const query = `[out:json][timeout:15];node[${tagQuery}](around:${radius},${lat},${lon});out body ${Math.max(limit, 12)};`;
            const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);
            const res = await fetch(url);
            const data = await res.json();
            return (data.elements || [])
                .filter(el => el.lat && el.lon)
                .map(el => ({
                    name: (el.tags && el.tags.name) || NEARBY_LABEL_MAP[type] || 'スポット',
                    lat: el.lat,
                    lon: el.lon,
                    distM: haversineM(lat, lon, el.lat, el.lon)
                }))
                .sort((a, b) => a.distM - b.distM)
                .slice(0, limit);
        }

        function openNearbyPOI(type) {
            playBeep();
            const label = NEARBY_LABEL_MAP[type] || '周辺スポット';
            openCustomModal(label, `<div class="text-xs text-slate-400 p-2 flex items-center gap-2"><span class="material-symbols-filled fa-spin">progress_activity</span> 半径3km以内を検索中...</div>`);

            fetchNearbyPOIs(type, 10)
                .then(pois => {
                    if (!pois.length) {
                        openCustomModal(label, '<div class="text-xs text-slate-400 p-2">周辺3km以内に見つかりませんでした。</div>');
                        return;
                    }
                    // BUGFIX: names were only escaped for a stray single-quote (`.replace(/'/g,
                    // "\\'")`), which still breaks (and can silently corrupt the button, making
                    // it look like nothing rendered) on any place name containing a literal
                    // double-quote character, since the onclick attribute itself is
                    // double-quoted — same class of bug as the MP3 list fix. escJs() handles
                    // backslashes, single AND double quotes; escapeHtml() protects the visible
                    // label text too (e.g. names with "&" or "<").
                    const body = pois.map(p => `
                        <button onclick="closeModal(); setQuickDestination('${escJs(p.name)}', ${p.lat}, ${p.lon})" class="w-full p-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-left flex items-center justify-between mb-1.5">
                            <span class="text-xs font-bold text-white truncate mr-2">${escapeHtml(p.name)}</span>
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
            // NEW: a mid-drive reroute keeps driving immediately (autoStart) — guidance is
            // already active, so showing a fresh 案内開始 confirmation here would be strange.
            if (destinationPos) calculateAndDrawRoute(currentDestName || '目的地', { autoStart: true });
            else openDestinationCategoryMenu();
        }

        function toggleSplitScreen() {
            playBeep();
            splitScreenOpen = !splitScreenOpen;
            // NEW: this toggle is now also reachable from 表示テーマ切替 (see
            // openDisplayChangeModal), not only the hw-strip, which has since been
            // repurposed for the Gemini launcher — so the button may not exist right now.
            const btn = document.getElementById('btn-split-toggle');
            const nav = document.getElementById('dock-nav');
            if (splitScreenOpen) {
                if (btn) btn.classList.add('active');
                if (nav) nav.click();
                speakGuidance('スプリット画面表示に切り替えました。');
            } else {
                if (btn) btn.classList.remove('active');
                speakGuidance('全画面表示に切り替えました。');
            }
            // map-section's own width changes as the split panel opens/closes (its CSS
            // transition runs ~300ms) — resize the rotatable #map once that settles.
            setTimeout(sizeRotatableMap, 350);
        }

        function toggleTConnectMenu() {
            playBeep();
            const menu = document.getElementById('tconnect-menu');
            if (!menu) return;
            menu.classList.toggle('hidden');
            // BUGFIX: this used to rely purely on "absolute inset-0" (i.e. top:0), covering the
            // top status bar — including the persistent Apple Music "now playing" mini-player
            // and its play/pause button — the instant the app menu opened. Positioning it just
            // below that bar instead keeps it visible/reachable from the menu too.
            if (!menu.classList.contains('hidden')) {
                const topBar = document.getElementById('top-status-bar');
                if (topBar) menu.style.top = topBar.getBoundingClientRect().height + 'px';
            }
        }
        function closeTConnectMenu() {
            playBeep();
            const menu = document.getElementById('tconnect-menu');
            if (menu) menu.classList.add('hidden');
        }

        function openCustomModal(title, bodyHtml, opts = {}) {
            document.getElementById('modal-title').innerHTML = `<span class="material-symbols-filled" >info</span> ${title}`;
            document.getElementById('modal-body').innerHTML = bodyHtml;
            document.getElementById('app-modal').classList.remove('hidden');
            // NEW: fullscreen option — widens the modal card to fill the whole display instead
            // of the small centered card, for content-heavy screens like destination search that
            // used to feel cramped/too-tall inside the narrow default card.
            const card = document.getElementById('modal-card');
            if (card) card.classList.toggle('modal-card-fullscreen', !!opts.fullscreen);
            // NEW: some screens (like the Gemini chat) supply their own sticky bottom input
            // bar and don't need the modal's default "閉じる" footer bar competing for space.
            const footer = document.getElementById('modal-footer');
            if (footer) footer.classList.toggle('hidden', !!opts.hideFooter);
        }

        function alertModal(title, message) {
            openCustomModal(title, `<div class="text-xs leading-relaxed text-slate-200">${message}</div>`);
        }

        function closeModal() {
            playBeep();
            document.getElementById('app-modal').classList.add('hidden');
        }

// NEW: keep the radio / local-MP3 play-pause button icons in sync even when playback starts,
// pauses, or ends for reasons other than the button itself being tapped (e.g. a track finishing).
(function setupAudioElementIconSync() {
    const radioEl = document.getElementById('radio-audio-el');
    if (radioEl) {
        ['play', 'pause'].forEach(evt => radioEl.addEventListener(evt, updateRadioPlayButtonIcon));
    }
    const localEl = document.getElementById('local-audio-el');
    if (localEl) {
        ['play', 'pause', 'ended'].forEach(evt => localEl.addEventListener(evt, updateLocalPlayButtonIcon));
    }
})();

// NEW: register the service worker so the browser recognizes this as an installable PWA
// (Chrome/Android's "install app" prompt requires one; iOS's Add-to-Home-Screen doesn't need it
// but isn't hurt by it).
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(() => {});
    });
}
