/* =========================================================
   NEURAL HORIZON — script.js
   ========================================================= */
(() => {
  "use strict";

  /* ---------- 1. CONFIGURATION ---------- */
  const CONFIG = Object.freeze({
    maxDpr: 2,
    gridSpacingMin: 28,
    gridSpacingMax: 44,
    particleMin: 200,
    particleMax: 900,
    maxDisplacement: 120,
    pointerSmoothAlpha: 0.18,
    audioSmoothAlpha: 0.15,
    frameDeltaClampMs: 100,
    fpsSampleWindow: 30,
    fpsUpdateIntervalMs: 250,
    clockIntervalMs: 1000,
    tickerIntervalMs: 4500,
    diagFftSize: 2048,
    diagSmoothing: 0.8,
    maxSynthVoices: 4,
    sessionLabel: "SIM",
  });

  const TICKER_MESSAGES = [
    "CALIBRATING FIELD — STANDBY",
    "OPTICAL MATRIX SYNCHRONIZED",
    "MICRO-LATTICE COHERENCE NOMINAL",
    "SECTOR SCAN COMPLETE",
    "DEEP FIELD DRIFT WITHIN TOLERANCE",
    "PHOTONIC ARRAY ALIGNED",
    "SIGNAL PATH VERIFIED",
  ];

  const MODE_PRESETS = {
    ORBITAL: { particleVel: 0.35, pointerGain: 0.7 },
    WARP:    { particleVel: 0.80, pointerGain: 1.6 },
    SCAN:    { particleVel: 0.15, pointerGain: 0.35 },
  };

  /* ---------- 2. STATE ---------- */
  const state = {
    mode: "ORBITAL",
    isPaused: false,
    isMuted: true,
    audioEnabled: false,
    microphoneActive: false,
    micStatus: "idle",
    diagnosticsOpen: false,
    reducedMotion: false,
    distortion: 0.5,
    density: 0.6,
    sensitivity: 0.5,
    pointerX: 0.5,
    pointerY: 0.5,
    pointerActive: false,
    audio: { rms: 0, peak: 0, low: 0, mid: 0, high: 0 },
    fps: 0,
    particleCount: 0,
    startTime: performance.now(),
  };

  const rawPointer = { x: 0.5, y: 0.5, vx: 0, vy: 0, lastX: 0.5, lastY: 0.5 };

  /* ---------- 3. DOM REFERENCES ---------- */
  const dom = {
    body: document.body,
    canvas: document.getElementById("viewport-canvas"),
    diagCanvas: document.getElementById("diag-canvas"),
    viewport: document.getElementById("viewport"),
    crosshair: document.getElementById("crosshair"),
    modeBadge: document.getElementById("mode-badge"),
    hudRight: document.getElementById("hud-right"),
    sessionId: document.getElementById("session-id"),
    clock: document.getElementById("utc-clock"),
    localClock: document.getElementById("local-clock"),
    systemStatus: document.getElementById("system-status"),
    systemStatusText: document.getElementById("system-status-text"),
    live: document.getElementById("live-region"),
    tlmPtrX: document.getElementById("tlm-ptr-x"),
    tlmPtrY: document.getElementById("tlm-ptr-y"),
    tlmDisp: document.getElementById("tlm-disp"),
    tlmParticles: document.getElementById("tlm-particles"),
    tlmFps: document.getElementById("tlm-fps"),
    tlmMode: document.getElementById("tlm-mode"),
    tlmAudio: document.getElementById("tlm-audio"),
    tlmUptime: document.getElementById("tlm-uptime"),
    tlmLow: document.getElementById("tlm-low"),
    tlmMid: document.getElementById("tlm-mid"),
    tlmHigh: document.getElementById("tlm-high"),
    tlmRms: document.getElementById("tlm-rms"),
    modeButtons: Array.from(document.querySelectorAll(".mode-btn")),
    distortion: document.getElementById("ctrl-distortion"),
    density: document.getElementById("ctrl-density"),
    sensitivity: document.getElementById("ctrl-sensitivity"),
    outDistortion: document.getElementById("out-distortion"),
    outDensity: document.getElementById("out-density"),
    outSensitivity: document.getElementById("out-sensitivity"),
    btnSound: document.getElementById("btn-sound"),
    btnMic: document.getElementById("btn-mic"),
    btnDiag: document.getElementById("btn-diag"),
    btnDiagClose: document.getElementById("btn-diag-close"),
    btnPause: document.getElementById("btn-pause"),
    btnMotion: document.getElementById("btn-motion"),
    btnReset: document.getElementById("btn-reset"),
    micStatusText: document.getElementById("mic-status-text"),
    diagnostics: document.getElementById("diagnostics"),
    diagIdle: document.getElementById("diag-idle"),
    diagState: document.getElementById("diag-state"),
    diagAmp: document.getElementById("diag-amp"),
    diagPeak: document.getElementById("diag-peak"),
    diagLow: document.getElementById("diag-low"),
    diagMid: document.getElementById("diag-mid"),
    diagHigh: document.getElementById("diag-high"),
    footerSim: document.getElementById("footer-sim"),
    footerInput: document.getElementById("footer-input"),
    footerRender: document.getElementById("footer-render"),
    footerTicker: document.getElementById("footer-ticker"),
  };

  /* ---------- 4. SYNTH ENGINE ---------- */
  const Synth = (() => {
    let ctx = null;
    let master = null;
    let ambientGain = null;
    let sfxGain = null;
    let activeVoices = 0;
    let enabled = false;
    let ambientStarted = false;

    function ensureContext() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);

        // Separate buses for ambient drone and short SFX
        ambientGain = ctx.createGain();
        ambientGain.gain.value = 0.12; // Keep ambient low
        ambientGain.connect(master);

        sfxGain = ctx.createGain();
        sfxGain.gain.value = 1.0;
        sfxGain.connect(master);

      } catch (err) {
        console.warn("[synth] AudioContext unavailable:", err);
        ctx = null;
      }
      return ctx;
    }

    async function enable() {
      const c = ensureContext();
      if (!c) return false;
      if (c.state === "suspended") {
        try { await c.resume(); } catch (err) { console.warn("[synth] resume failed:", err); }
      }
      enabled = c.state === "running";
      if (enabled) {
        master.gain.cancelScheduledValues(c.currentTime);
        master.gain.setTargetAtTime(state.isMuted ? 0 : 0.6, c.currentTime, 0.05);
        
        if (!ambientStarted) {
          startAmbientDrone();
          ambientStarted = true;
        }
      }
      return enabled;
    }

    function setMuted(muted) {
      if (!ctx || !master) return;
      const target = (muted || !enabled) ? 0 : 0.6;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
    }

    // --- Ambient Space Drone ---
    function startAmbientDrone() {
      if (!ctx) return;
      const t0 = ctx.currentTime;
      
      // 3 detuned oscillators creating a deep fifth chord
      const freqs = [55, 82.5, 110]; // A1, E2, A2
      const oscs = freqs.map(f => {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f;
        o.connect(ambientGain);
        o.start(t0);
        return o;
      });

      // Lowpass filter to cut out harsh highs
      const filt = ctx.createBiquadFilter();
      filt.type = "lowpass";
      filt.frequency.value = 200;
      filt.Q.value = 0.5;
      
      // LFO to modulate the filter frequency (creates a breathing effect)
      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.05; // Very slow, 20 second cycle
      
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 100; // Sweep +/- 100 Hz
      
      lfo.connect(lfoGain);
      lfoGain.connect(filt.frequency);
      
      oscs.forEach(o => {
        o.disconnect(); // Disconnect from ambientGain
        o.connect(filt); // Route through filter instead
      });
      
      filt.connect(ambientGain);
      
      lfo.start(t0);

      // Add a tiny bit of noise (solar wind)
      const bufferSize = ctx.sampleRate * 2;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuffer;
      noise.loop = true;
      
      const noiseFilt = ctx.createBiquadFilter();
      noiseFilt.type = "bandpass";
      noiseFilt.frequency.value = 400;
      noiseFilt.Q.value = 0.5;
      
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.02; // Very quiet noise
      
      noise.connect(noiseFilt);
      noiseFilt.connect(noiseGain);
      noiseGain.connect(ambientGain);
      
      noise.start(t0);
    }

    function duckAmbient(duck) {
      if (!ctx || !ambientGain) return;
      const target = duck ? 0.02 : 0.12;
      ambientGain.gain.cancelScheduledValues(ctx.currentTime);
      ambientGain.gain.setTargetAtTime(target, ctx.currentTime, 0.5);
    }

    // --- SFX ---
    function makeVoice() {
      if (!ctx) return null;
      if (activeVoices >= CONFIG.maxSynthVoices) return null;
      activeVoices++;
      return {
        stop(oscs) {
          oscs.forEach((o) => { try { o.stop(); } catch (_) {} });
          activeVoices = Math.max(0, activeVoices - 1);
        },
      };
    }

    function playActivate() {
      if (!ctx || !enabled || state.isMuted) return;
      const t0 = ctx.currentTime;
      const voice = makeVoice(); if (!voice) return;
      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();
      const gain = ctx.createGain();
      const filt = ctx.createBiquadFilter();
      oscA.type = "sine"; oscA.frequency.value = 110;
      oscB.type = "sine"; oscB.frequency.value = 165;
      filt.type = "lowpass"; filt.frequency.value = 1200; filt.Q.value = 0.7;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.5, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
      oscA.connect(gain); oscB.connect(gain);
      gain.connect(filt); filt.connect(sfxGain);
      oscA.start(t0); oscB.start(t0);
      oscA.stop(t0 + 0.25); oscB.stop(t0 + 0.25);
      oscA.onended = () => {
        try { filt.disconnect(); gain.disconnect(); } catch (_) {}
        voice.stop([oscA, oscB]);
      };
    }

    function playTransition() {
      if (!ctx || !enabled || state.isMuted) return;
      const t0 = ctx.currentTime;
      const voice = makeVoice(); if (!voice) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const filt = ctx.createBiquadFilter();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(280, t0);
      osc.frequency.exponentialRampToValueAtTime(520, t0 + 0.28);
      filt.type = "bandpass"; filt.Q.value = 2;
      filt.frequency.setValueAtTime(600, t0);
      filt.frequency.exponentialRampToValueAtTime(1400, t0 + 0.28);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
      osc.connect(filt); filt.connect(gain); gain.connect(sfxGain);
      osc.start(t0); osc.stop(t0 + 0.32);
      osc.onended = () => {
        try { filt.disconnect(); gain.disconnect(); } catch (_) {}
        voice.stop([osc]);
      };
    }

    function playAlert() {
      if (!ctx || !enabled || state.isMuted) return;
      const t0 = ctx.currentTime;
      const voice = makeVoice(); if (!voice) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square"; osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.11);
      osc.connect(gain); gain.connect(sfxGain);
      osc.start(t0); osc.stop(t0 + 0.13);
      osc.onended = () => {
        try { gain.disconnect(); } catch (_) {}
        voice.stop([osc]);
      };
    }

    function dispose() {
      if (ctx) {
        try { ctx.close(); } catch (_) {}
        ctx = null; master = null; enabled = false;
      }
    }

    return { enable, setMuted, playActivate, playTransition, playAlert, duckAmbient, dispose, isEnabled: () => enabled };
  })();

  /* ---------- 5. MIC ENGINE ---------- */
  const Mic = (() => {
    let ctx = null;
    let stream = null;
    let source = null;
    let analyser = null;
    let freqData = null;
    let timeData = null;
    let active = false;

    async function request() {
      if (!window.isSecureContext) throw { code: "insecure" };
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw { code: "unavailable" };
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw { code: "unavailable" };

      let s;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) throw { code: "denied" };
        if (err && err.name === "NotFoundError") throw { code: "unavailable" };
        throw { code: "error", error: err };
      }

      if (!ctx) ctx = new AC();
      if (ctx.state === "suspended") {
        try { await ctx.resume(); } catch (_) {}
      }

      try {
        source = ctx.createMediaStreamSource(s);
        analyser = ctx.createAnalyser();
        analyser.fftSize = CONFIG.diagFftSize;
        analyser.smoothingTimeConstant = CONFIG.diagSmoothing;
        source.connect(analyser);
        stream = s;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        timeData = new Uint8Array(analyser.fftSize);
        active = true;
        s.getAudioTracks().forEach((track) => {
          track.addEventListener("ended", () => {
            if (active) {
              stop();
              state.micStatus = "error";
              announce("Microphone stream ended unexpectedly.");
            }
          });
        });
        return true;
      } catch (err) {
        s.getTracks().forEach((t) => t.stop());
        throw { code: "error", error: err };
      }
    }

    function stop() {
      if (source) { try { source.disconnect(); } catch (_) {} source = null; }
      if (analyser) { try { analyser.disconnect(); } catch (_) {} analyser = null; }
      if (stream) {
        stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
        stream = null;
      }
      active = false;
    }

    function sample() {
      if (!active || !analyser) return null;
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);

      const bins = freqData.length;
      const loEnd = Math.floor(bins * 0.1);
      const midEnd = Math.floor(bins * 0.4);

      let sum = 0, peak = 0, lo = 0, mid = 0, hi = 0;
      for (let i = 0; i < bins; i++) {
        const v = freqData[i] / 255;
        sum += v * v;
        if (v > peak) peak = v;
        if (i < loEnd) lo += v;
        else if (i < midEnd) mid += v;
        else hi += v;
      }
      const rms = Math.sqrt(sum / bins);
      lo = lo / Math.max(1, loEnd);
      mid = mid / Math.max(1, midEnd - loEnd);
      hi = hi / Math.max(1, bins - midEnd);

      return { rms, peak, low: lo, mid, high: hi, freq: freqData, time: timeData };
    }

    return { request, stop, sample, isActive: () => active, getAnalyser: () => analyser };
  })();

  /* ---------- 6. FIELD DATA ---------- */
  const Field = (() => {
    let grid = { cols: 0, rows: 0, spacing: 32, baseX: null, baseY: null };
    let particles = { count: 0, x: null, y: null, vx: null, vy: null, seed: null };
    let view = { w: 0, h: 0, dpr: 1 };

    function rebuildGrid(w, h) {
      const spacing = Math.max(CONFIG.gridSpacingMin, Math.min(CONFIG.gridSpacingMax, Math.round(Math.min(w, h) / 22) || 32));
      const cols = Math.ceil(w / spacing) + 2;
      const rows = Math.ceil(h / spacing) + 2;
      grid.cols = cols; grid.rows = rows; grid.spacing = spacing;
      grid.baseX = new Float32Array(cols * rows);
      grid.baseY = new Float32Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          grid.baseX[idx] = (i - 0.5) * spacing;
          grid.baseY[idx] = (j - 0.5) * spacing;
        }
      }
    }

    function particleTarget(w, h) {
      const area = w * h;
      const base = Math.round(area / 1400);
      const scaled = Math.round(base * state.density);
      return Math.max(CONFIG.particleMin, Math.min(CONFIG.particleMax, scaled || CONFIG.particleMin));
    }

    function rebuildParticles(w, h) {
      const target = particleTarget(w, h);
      const x = new Float32Array(target);
      const y = new Float32Array(target);
      const vx = new Float32Array(target);
      const vy = new Float32Array(target);
      const seed = new Float32Array(target);
      let s = 12345;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      for (let i = 0; i < target; i++) {
        x[i] = rand() * w; y[i] = rand() * h;
        vx[i] = (rand() - 0.5) * 6; vy[i] = (rand() - 0.5) * 6;
        seed[i] = rand() * Math.PI * 2;
      }
      particles = { count: target, x, y, vx, vy, seed };
      state.particleCount = target;
    }

    function setView(w, h, dpr) {
      view.w = w; view.h = h; view.dpr = dpr;
      rebuildGrid(w, h);
      rebuildParticles(w, h);
    }

    function resizeParticlesIfDensityChanged() {
      const target = particleTarget(view.w, view.h);
      if (target !== particles.count) rebuildParticles(view.w, view.h);
    }

    return { setView, resizeParticlesIfDensityChanged, grid: () => grid, particles: () => particles, view: () => view };
  })();

  /* ---------- 7. RENDERER ---------- */
  const Renderer = (() => {
    let ctx = null;
    let cssW = 0, cssH = 0, dpr = 1;
    let rafId = null;
    let lastTs = 0;
    let fpsAccum = 0, fpsSamples = 0, fpsLastUpdate = 0;
    let time = 0;
    let initialized = false;

    function init() {
      if (!dom.canvas) { setStatus("error"); announce("Canvas unavailable."); return false; }
      ctx = dom.canvas.getContext("2d", { alpha: false, desynchronized: true });
      if (!ctx) { setStatus("error"); announce("Canvas 2D context unavailable."); return false; }
      initialized = true;
      return true;
    }

    function resize() {
      if (!ctx) return;
      const rect = dom.viewport.getBoundingClientRect();
      cssW = Math.max(1, Math.floor(rect.width));
      cssH = Math.max(1, Math.floor(rect.height));
      dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);
      dom.canvas.width = Math.floor(cssW * dpr);
      dom.canvas.height = Math.floor(cssH * dpr);
      dom.canvas.style.width = cssW + "px";
      dom.canvas.style.height = cssH + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      Field.setView(cssW, cssH, dpr);
      if (dom.hudRight) dom.hudRight.textContent = "GRID " + Field.grid().spacing + "PX";
    }

    function smoothPointer() {
      const a = CONFIG.pointerSmoothAlpha;
      if (!state.pointerActive) {
        state.pointerX += (0.5 - state.pointerX) * 0.02;
        state.pointerY += (0.5 - state.pointerY) * 0.02;
        return;
      }
      state.pointerX += (rawPointer.x - state.pointerX) * a;
      state.pointerY += (rawPointer.y - state.pointerY) * a;
      rawPointer.vx = (rawPointer.x - rawPointer.lastX);
      rawPointer.vy = (rawPointer.y - rawPointer.lastY);
      rawPointer.lastX = rawPointer.x;
      rawPointer.lastY = rawPointer.y;
    }

    function sampleAudioIntoState() {
      const m = Mic.sample();
      if (!m) return;
      const a = CONFIG.audioSmoothAlpha;
      state.audio.rms  += (m.rms  - state.audio.rms)  * a;
      state.audio.peak += (m.peak - state.audio.peak) * a;
      state.audio.low  += (m.low  - state.audio.low)  * a;
      state.audio.mid  += (m.mid  - state.audio.mid)  * a;
      state.audio.high += (m.high - state.audio.high) * a;
    }

    function displacePoint(bx, by, px, py, t, mode, out) {
      const preset = MODE_PRESETS[mode];
      const sensitivity = 0.3 + state.sensitivity * 1.4;
      const sigma = 120 + (1 - state.sensitivity) * 180;
      const d = Math.hypot(bx - px, by - py);
      const g = Math.exp(-(d * d) / (2 * sigma * sigma));
      const gain = state.distortion * preset.pointerGain * sensitivity * CONFIG.maxDisplacement;

      const wave = state.reducedMotion ? 0 : 1;
      const wx = Math.sin(by * 0.012 + t * 0.4) * 4 * wave;
      const wy = Math.cos(bx * 0.014 + t * 0.35) * 4 * wave;

      const dx = bx - px, dy = by - py;
      const len = Math.hypot(dx, dy) || 1;
      const pushX = (dx / len) * g * gain;
      const pushY = (dy / len) * g * gain;

      const shear = mode === "WARP" ? 1 : 0.3;
      const svx = rawPointer.vx * 400 * g * shear * state.distortion;
      const svy = rawPointer.vy * 400 * g * shear * state.distortion;

      const audioX = state.audio.mid * 25 * (mode === "SCAN" ? 0.3 : 1);
      const audioY = state.audio.high * 25 * (mode === "SCAN" ? 0.3 : 1);

      let ox = bx + wx + pushX + svx + audioX;
      let oy = by + wy + pushY + svy + audioY;
      const mdx = ox - bx, mdy = oy - by;
      const md = Math.hypot(mdx, mdy);
      if (md > CONFIG.maxDisplacement) {
        const k = CONFIG.maxDisplacement / md;
        ox = bx + mdx * k;
        oy = by + mdy * k;
      }
      out[0] = ox;
      out[1] = oy;
    }

    function renderGrid(mode, t) {
      const g = Field.grid();
      const px = state.pointerX * cssW;
      const py = state.pointerY * cssH;
      const scratch = [0, 0];
      const spacing = g.spacing;
      const cols = g.cols, rows = g.rows;

      ctx.lineWidth = 1;

      for (let j = 0; j < rows; j++) {
        ctx.beginPath();
        for (let i = 0; i < cols; i++) {
          const idx = j * cols + i;
          displacePoint(g.baseX[idx], g.baseY[idx], px, py, t, mode, scratch);
          if (i === 0) ctx.moveTo(scratch[0], scratch[1]);
          else ctx.lineTo(scratch[0], scratch[1]);
        }
        const alpha = 0.08 + (j / rows) * 0.16 + state.audio.rms * 0.15;
        ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.stroke();
      }

      for (let i = 0; i < cols; i++) {
        ctx.beginPath();
        for (let j = 0; j < rows; j++) {
          const idx = j * cols + i;
          displacePoint(g.baseX[idx], g.baseY[idx], px, py, t, mode, scratch);
          if (j === 0) ctx.moveTo(scratch[0], scratch[1]);
          else ctx.lineTo(scratch[0], scratch[1]);
        }
        const alpha = 0.06 + (i / cols) * 0.12;
        ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.stroke();
      }

      const step = Math.max(1, Math.floor(spacing / 6));
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      for (let j = 0; j < rows; j += step) {
        for (let i = 0; i < cols; i += step) {
          const idx = j * cols + i;
          displacePoint(g.baseX[idx], g.baseY[idx], px, py, t, mode, scratch);
          ctx.fillRect(scratch[0], scratch[1], 1, 1);
        }
      }
    }

    function renderOrbitRings(t) {
      const cx = cssW * 0.5;
      const cy = cssH * 0.5;
      const baseR = Math.min(cssW, cssH) * 0.18;
      const drift = Math.sin(t * 0.2) * 0.06;
      ctx.lineWidth = 1;
      for (let k = 0; k < 4; k++) {
        const r = baseR * (1 + k * 0.5 + drift * (k + 1));
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        const a = 0.12 + k * 0.04 + state.audio.low * 0.1;
        ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        ctx.stroke();
      }
      const fx = cx + Math.cos(t * 0.3) * baseR * 0.4;
      const fy = cy + Math.sin(t * 0.3) * baseR * 0.3;
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillRect(fx - 2, fy - 2, 4, 4);
      ctx.fillRect(cx - fx - 2, cy - fy - 2, 4, 4);
    }

    function renderParticles(mode, t, dt) {
      const p = Field.particles();
      const px = state.pointerX * cssW;
      const py = state.pointerY * cssH;
      const preset = MODE_PRESETS[mode];
      const speed = preset.particleVel * (state.reducedMotion ? 0.4 : 1) * (dt / 16.667);
      const sigma = 160;

      for (let i = 0; i < p.count; i++) {
        const x = p.x[i], y = p.y[i];
        const d = Math.hypot(x - px, y - py);
        const g = Math.exp(-(d * d) / (2 * sigma * sigma));
        const pointerStrength = g * state.distortion * state.sensitivity * 2.5;

        const s = p.seed[i];
        const tvx = Math.cos(t * 0.3 + s) * 0.4 * speed;
        const tvy = Math.sin(t * 0.28 + s * 1.3) * 0.4 * speed;

        const dx = x - px, dy = y - py;
        const len = Math.hypot(dx, dy) || 1;
        const tangX = -dy / len, tangY = dx / len;
        const flowX = tangX * pointerStrength * 2 + (dx / len) * pointerStrength * 0.8;
        const flowY = tangY * pointerStrength * 2 + (dy / len) * pointerStrength * 0.8;
        const audioFlow = state.audio.mid * 1.5;

        p.vx[i] += (tvx + flowX + audioFlow * (Math.random() - 0.5)) * 0.08;
        p.vy[i] += (tvy + flowY + audioFlow * (Math.random() - 0.5)) * 0.08;
        p.vx[i] *= 0.94;
        p.vy[i] *= 0.94;
        p.x[i] += p.vx[i];
        p.y[i] += p.vy[i];

        if (p.x[i] < -10) p.x[i] = cssW + 10;
        else if (p.x[i] > cssW + 10) p.x[i] = -10;
        if (p.y[i] < -10) p.y[i] = cssH + 10;
        else if (p.y[i] > cssH + 10) p.y[i] = -10;
      }

      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (let i = 0; i < p.count; i++) {
        const near = Math.hypot(p.x[i] - px, p.y[i] - py) < 120 ? 2 : 1;
        ctx.fillRect(p.x[i], p.y[i], near, near);
      }
    }

    function renderScan(t) {
      const sweepX = ((t * 0.12) % 1) * cssW;
      ctx.lineWidth = 1;

      const spacing = Math.max(20, Math.floor(cssH / 40));
      for (let y = spacing; y < cssH; y += spacing) {
        const alpha = 0.05 + 0.03 * Math.sin(y * 0.02 + t);
        ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
      }
      
      const grad = ctx.createLinearGradient(sweepX - 30, 0, sweepX + 30, 0);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.5, `rgba(255,255,255,${(0.35 + state.audio.rms * 0.4).toFixed(3)})`);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(sweepX - 30, 0, 60, cssH);

      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath(); ctx.moveTo(sweepX, 0); ctx.lineTo(sweepX, cssH); ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = "10px " + getComputedStyle(dom.body).fontFamily;
      for (let y = spacing * 4; y < cssH; y += spacing * 8) {
        ctx.fillRect(sweepX - 3, y, 6, 1);
        ctx.fillText(`${Math.round(y)}`, sweepX + 8, y + 3);
      }
    }

    function renderCrosshairMarker() {
      if (!state.pointerActive) return;
      const px = state.pointerX * cssW;
      const py = state.pointerY * cssH;
      ctx.strokeStyle = "rgba(255,255,255,0.4)";
      ctx.beginPath(); ctx.arc(px, py, 22, 0, Math.PI * 2); ctx.stroke();
    }

    function renderHud() {
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.font = "10px " + getComputedStyle(dom.body).fontFamily;
      ctx.fillText(`MODE ${state.mode} · ${state.isPaused ? "PAUSED" : "LIVE"}`, 16, cssH - 24);
    }

    function render(t, dt) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, cssW, cssH);

      const mode = state.mode;
      if (mode === "SCAN") {
        renderScan(t);
      } else {
        renderGrid(mode, t);
        if (mode === "ORBITAL") renderOrbitRings(t);
        renderParticles(mode, t, dt);
      }
      renderCrosshairMarker();
      renderHud();
    }

    function animate(ts) {
      if (!initialized) return;
      rafId = requestAnimationFrame(animate);
      if (!lastTs) lastTs = ts;
      let dt = ts - lastTs;
      lastTs = ts;
      if (dt > CONFIG.frameDeltaClampMs) dt = CONFIG.frameDeltaClampMs;
      if (document.hidden) return;

      if (!state.isPaused) {
        time += dt / 1000;
        smoothPointer();
        if (state.microphoneActive) sampleAudioIntoState();
        render(time, dt);
        
        if (dt > 0) { fpsAccum += dt; fpsSamples++; }
        if (ts - fpsLastUpdate > CONFIG.fpsUpdateIntervalMs && fpsSamples > 0) {
          const avg = fpsAccum / fpsSamples;
          state.fps = avg > 0 ? Math.round(1000 / avg) : 0;
          fpsAccum = 0; fpsSamples = 0; fpsLastUpdate = ts;
        }
      }
    }

    function start() {
      if (rafId !== null) return;
      lastTs = 0;
      fpsAccum = 0; fpsSamples = 0; fpsLastUpdate = performance.now();
      rafId = requestAnimationFrame(animate);
    }

    function stopLoop() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function setMode(m) {
      state.mode = m;
      if (dom.modeBadge) dom.modeBadge.textContent = m;
      if (dom.tlmMode) dom.tlmMode.textContent = m;
      dom.modeButtons.forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.mode === m));
      });
    }

    return { init, resize, start, stopLoop, setMode, getCtx: () => ctx, getSize: () => ({ w: cssW, h: cssH }), isRunning: () => rafId !== null };
  })();

  /* ---------- 8. DIAGNOSTICS RENDERER ---------- */
  const Diagnostics = (() => {
    let ctx = null;
    let rafId = null;
    let initialized = false;

    function init() {
      if (!dom.diagCanvas) return false;
      ctx = dom.diagCanvas.getContext("2d");
      if (!ctx) return false;
      initialized = true;
      return true;
    }

    function resize() {
      if (!ctx) return;
      const rect = dom.diagCanvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);
      dom.diagCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
      dom.diagCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function drawIdle() {
      if (!ctx) return;
      const rect = dom.diagCanvas.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    }

    function drawActive() {
      if (!ctx) return;
      const rect = dom.diagCanvas.getBoundingClientRect();
      const w = rect.width, h = rect.height;
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);

      const m = Mic.sample();
      if (!m) { drawIdle(); return; }

      const t = m.time;
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      const step = Math.max(1, Math.floor(t.length / w));
      for (let i = 0, px = 0; i < t.length; i += step, px++) {
        const v = (t[i] - 128) / 128;
        const y = h / 2 + v * (h / 2 - 8);
        if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
      }
      ctx.stroke();

      const bins = Math.min(m.freq.length, 128);
      const barW = w / bins;
      for (let i = 0; i < bins; i++) {
        const v = m.freq[i] / 255;
        const bh = v * (h / 2 - 6);
        ctx.fillStyle = `rgba(255,255,255,${(0.15 + v * 0.5).toFixed(3)})`;
        ctx.fillRect(i * barW, h - bh, Math.max(1, barW - 1), bh);
      }
    }

    function loop() {
      if (!initialized) return;
      if (!state.diagnosticsOpen) { rafId = null; return; }
      rafId = requestAnimationFrame(loop);
      if (document.hidden) return;
      if (state.micStatus === "active") drawActive(); else drawIdle();
    }

    function start() {
      if (!initialized) return;
      if (rafId !== null) return;
      rafId = requestAnimationFrame(loop);
    }

    function stop() {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    return { init, resize, start, stop, drawIdle };
  })();

  /* ---------- 9. INPUT ---------- */
  const Input = (() => {
    function onPointerMove(e) {
      const rect = dom.canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      rawPointer.x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      rawPointer.y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
      state.pointerActive = true;
      dom.crosshair.classList.add("is-visible");
      dom.crosshair.style.left = (rawPointer.x * 100) + "%";
      dom.crosshair.style.top = (rawPointer.y * 100) + "%";
    }

    function onPointerLeave() {
      state.pointerActive = false;
      dom.crosshair.classList.remove("is-visible");
    }

    function onPointerDown() {
      if (!state.audioEnabled) enableAudio(); else Synth.playActivate();
    }

    function isEditable(el) {
      if (!el) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    }

    function onKeyDown(e) {
      if (isEditable(e.target)) return;
      const k = e.key;
      if (k === "1") { setMode("ORBITAL"); e.preventDefault(); }
      else if (k === "2") { setMode("WARP"); e.preventDefault(); }
      else if (k === "3") { setMode("SCAN"); e.preventDefault(); }
      else if (k === "m" || k === "M") { toggleSound(); e.preventDefault(); }
      else if (k === "d" || k === "D") { toggleDiagnostics(); e.preventDefault(); }
      else if (k === " " || k === "Spacebar") { togglePause(); e.preventDefault(); }
      else if (k === "Escape") { if (state.diagnosticsOpen) { toggleDiagnostics(); e.preventDefault(); } }
    }

    function attach() {
      dom.canvas.addEventListener("pointermove", onPointerMove);
      dom.canvas.addEventListener("pointerleave", onPointerLeave);
      dom.canvas.addEventListener("pointercancel", onPointerLeave);
      dom.canvas.addEventListener("pointerdown", onPointerDown);
      document.addEventListener("keydown", onKeyDown);
    }

    return { attach };
  })();

  /* ---------- 10. UI CONTROLLER ---------- */
  function setStatus(newStatus, text) {
    state.status = newStatus;
    if (dom.systemStatus) dom.systemStatus.setAttribute("data-state", newStatus);
    if (dom.systemStatusText && text) dom.systemStatusText.textContent = text;
  }

  function announce(msg) {
    if (!dom.live) return;
    dom.live.textContent = "";
    setTimeout(() => { dom.live.textContent = msg; }, 20);
  }

  function setMode(m) {
    if (state.mode === m) return;
    Renderer.setMode(m);
    Synth.playTransition();
    announce(`Visualization mode: ${m}.`);
    syncUi();
  }

  function setSoundEnabled(on) {
    state.isMuted = !on;
    if (dom.btnSound) dom.btnSound.setAttribute("aria-pressed", String(on));
    if (on && !state.audioEnabled) enableAudio(); else Synth.setMuted(!on);
    if (dom.tlmAudio) dom.tlmAudio.textContent = on ? "ON" : "MUTED";
    if (!on) announce("Sound muted."); else { Synth.playActivate(); announce("Sound enabled."); }
  }

  async function enableAudio() {
    const ok = await Synth.enable();
    state.audioEnabled = ok;
    if (!ok) { announce("Audio unavailable in this browser."); return false; }
    Synth.setMuted(state.isMuted);
    Synth.playActivate();
    return true;
  }

  function toggleSound() { setSoundEnabled(state.isMuted); }

  function togglePause() {
    state.isPaused = !state.isPaused;
    if (dom.btnPause) dom.btnPause.setAttribute("aria-pressed", String(state.isPaused));
    if (dom.footerRender) dom.footerRender.textContent = state.isPaused ? "PAUSED" : "RUNNING";
    setStatus(state.isPaused ? "paused" : "active", state.isPaused ? "PAUSED" : "ACTIVE");
    announce(state.isPaused ? "Visualization paused." : "Visualization resumed.");
  }

  function toggleDiagnostics(force) {
    const open = typeof force === "boolean" ? force : !state.diagnosticsOpen;
    state.diagnosticsOpen = open;
    if (dom.diagnostics) dom.diagnostics.setAttribute("aria-expanded", String(open));
    if (dom.btnDiag) dom.btnDiag.setAttribute("aria-expanded", String(open));
    if (open) {
      Diagnostics.resize();
      Diagnostics.start();
      if (state.micStatus !== "active") Diagnostics.drawIdle();
    } else {
      Diagnostics.stop();
    }
    announce(open ? "Diagnostics panel opened." : "Diagnostics panel closed.");
  }

  async function toggleMic() {
    if (state.micStatus === "active" || state.micStatus === "requesting") {
      Mic.stop();
      state.microphoneActive = false;
      state.micStatus = "idle";
      state.audio.rms = state.audio.peak = state.audio.low = state.audio.mid = state.audio.high = 0;
      updateMicUi();
      if (dom.diagIdle) dom.diagIdle.classList.remove("is-hidden");
      Synth.duckAmbient(false); // Restore ambient volume
      Synth.playAlert();
      announce("Microphone stopped.");
      return;
    }
    state.micStatus = "requesting";
    updateMicUi();
    try {
      await Mic.request();
      state.microphoneActive = true;
      state.micStatus = "active";
      updateMicUi();
      if (dom.diagIdle) dom.diagIdle.classList.add("is-hidden");
      Synth.duckAmbient(true); // Duck ambient volume
      Synth.playTransition();
      announce("Microphone active. Diagnostics analyzing input.");
      if (!state.diagnosticsOpen) toggleDiagnostics(true);
    } catch (err) {
      Mic.stop();
      state.microphoneActive = false;
      const code = err && err.code ? err.code : "error";
      state.micStatus = code;
      updateMicUi();
      if (dom.diagIdle) dom.diagIdle.classList.remove("is-hidden");
      Synth.playAlert();
      const msg = {
        insecure: "Microphone unavailable: secure context (https or localhost) required.",
        unavailable: "Microphone unavailable in this browser or no device found.",
        denied: "Microphone permission denied by user.",
        error: "Microphone error. See console for details.",
      }[code] || "Microphone error.";
      announce(msg);
      console.warn("[mic]", err);
    }
  }

  function updateMicUi() {
    const s = state.micStatus;
    if (dom.btnMic) {
      dom.btnMic.setAttribute("aria-pressed", String(s === "active"));
      dom.btnMic.classList.toggle("is-error", s === "denied" || s === "unavailable" || s === "error" || s === "insecure");
    }
    if (dom.micStatusText) {
      const label = {
        idle: "MIC: IDLE — no microphone access requested.",
        requesting: "MIC: REQUESTING PERMISSION…",
        active: "MIC: ACTIVE — analysis running.",
        denied: "MIC: DENIED — permission refused. Non-audio features active.",
        unavailable: "MIC: UNAVAILABLE — no device or API missing.",
        insecure: "MIC: UNAVAILABLE — secure context required (https / localhost).",
        error: "MIC: ERROR — see console.",
      }[s] || ("MIC: " + s.toUpperCase());
      dom.micStatusText.textContent = label;
      dom.micStatusText.classList.toggle("is-error", s === "denied" || s === "unavailable" || s === "error" || s === "insecure");
    }
    if (dom.diagState) dom.diagState.textContent = s.toUpperCase();
    if (dom.tlmAudio) dom.tlmAudio.textContent = state.microphoneActive ? "MIC·ON" : (state.isMuted ? "MUTED" : "ON");
  }

  function toggleReducedMotion() {
    state.reducedMotion = !state.reducedMotion;
    dom.body.dataset.reducedMotion = String(state.reducedMotion);
    if (dom.btnMotion) dom.btnMotion.setAttribute("aria-pressed", String(state.reducedMotion));
    announce(state.reducedMotion ? "Reduced motion enabled." : "Reduced motion disabled.");
  }

  function resetAll() {
    state.distortion = 0.5;
    state.density = 0.6;
    state.sensitivity = 0.5;
    if (dom.distortion) dom.distortion.value = "0.5";
    if (dom.density) dom.density.value = "0.6";
    if (dom.sensitivity) dom.sensitivity.value = "0.5";
    Field.resizeParticlesIfDensityChanged();
    Renderer.resize();
    Synth.playActivate();
    announce("Parameters reset to defaults.");
    syncUi();
  }

  function syncUi() {
    if (dom.outDistortion) dom.outDistortion.textContent = state.distortion.toFixed(2);
    if (dom.outDensity) dom.outDensity.textContent = state.density.toFixed(2);
    if (dom.outSensitivity) dom.outSensitivity.textContent = state.sensitivity.toFixed(2);
    if (dom.tlmMode) dom.tlmMode.textContent = state.mode;
    if (dom.tlmParticles) dom.tlmParticles.textContent = String(state.particleCount);
    if (dom.tlmPtrX) dom.tlmPtrX.textContent = state.pointerX.toFixed(3);
    if (dom.tlmPtrY) dom.tlmPtrY.textContent = state.pointerY.toFixed(3);
    if (dom.tlmDisp) dom.tlmDisp.textContent = Math.hypot(state.pointerX - 0.5, state.pointerY - 0.5).toFixed(3);
    if (dom.tlmFps) dom.tlmFps.textContent = state.fps > 0 ? String(state.fps) : "--";
    if (dom.tlmLow) dom.tlmLow.textContent = state.audio.low.toFixed(2);
    if (dom.tlmMid) dom.tlmMid.textContent = state.audio.mid.toFixed(2);
    if (dom.tlmHigh) dom.tlmHigh.textContent = state.audio.high.toFixed(2);
    if (dom.tlmRms) dom.tlmRms.textContent = state.audio.rms.toFixed(2);
    if (dom.diagAmp) dom.diagAmp.textContent = state.audio.rms.toFixed(2);
    if (dom.diagPeak) dom.diagPeak.textContent = state.audio.peak.toFixed(2);
    if (dom.diagLow) dom.diagLow.textContent = state.audio.low.toFixed(2);
    if (dom.diagMid) dom.diagMid.textContent = state.audio.mid.toFixed(2);
    if (dom.diagHigh) dom.diagHigh.textContent = state.audio.high.toFixed(2);
  }

  function attachControls() {
    dom.modeButtons.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    if (dom.distortion) dom.distortion.addEventListener("input", (e) => { state.distortion = parseFloat(e.target.value); syncUi(); });
    if (dom.density) dom.density.addEventListener("input", (e) => {
      state.density = parseFloat(e.target.value);
      Field.resizeParticlesIfDensityChanged();
      state.particleCount = Field.particles().count;
      syncUi();
    });
    if (dom.sensitivity) dom.sensitivity.addEventListener("input", (e) => { state.sensitivity = parseFloat(e.target.value); syncUi(); });
    if (dom.btnSound) dom.btnSound.addEventListener("click", toggleSound);
    if (dom.btnMic) dom.btnMic.addEventListener("click", toggleMic);
    if (dom.btnDiag) dom.btnDiag.addEventListener("click", () => toggleDiagnostics());
    if (dom.btnDiagClose) dom.btnDiagClose.addEventListener("click", () => toggleDiagnostics(false));
    if (dom.btnPause) dom.btnPause.addEventListener("click", togglePause);
    if (dom.btnMotion) dom.btnMotion.addEventListener("click", toggleReducedMotion);
    if (dom.btnReset) dom.btnReset.addEventListener("click", resetAll);
  }

  /* ---------- 11. TELEMETRY / CLOCK / TICKER ---------- */
  let clockTimer = null;
  let tickerTimer = null;
  let telemetryTimer = null;
  let tickerIdx = 0;
  let tickerRafId = null;
  let tickerScrollPos = 0;
  let lastTickerTs = 0;

  function startClock() {
    const pad = (n) => String(n).padStart(2, "0");
    const update = () => {
      const d = new Date();
      if (dom.clock) {
        const hh = pad(d.getUTCHours()), mm = pad(d.getUTCMinutes()), ss = pad(d.getUTCSeconds());
        dom.clock.textContent = `${hh}:${mm}:${ss}`;
        dom.clock.setAttribute("title", `Coordinated Universal Time (UTC). Local: ${d.toLocaleTimeString()}`);
        dom.clock.setAttribute("aria-label", `Current UTC time ${hh}:${mm}:${ss}`);
      }
      if (dom.localClock) {
        const offsetMin = -d.getTimezoneOffset();
        const sign = offsetMin >= 0 ? "+" : "−";
        const abs = Math.abs(offsetMin);
        const offH = pad(Math.floor(abs / 60)), offM = pad(abs % 60);
        dom.localClock.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC${sign}${offH}:${offM}`;
      }
    };
    update();
    clockTimer = setInterval(update, CONFIG.clockIntervalMs);
  }

  function startTicker() {
    const updateFooter = () => {
      if (dom.footerTicker) dom.footerTicker.textContent = TICKER_MESSAGES[tickerIdx % TICKER_MESSAGES.length];
      tickerIdx++;
    };
    updateFooter();
    tickerTimer = setInterval(() => { if (!document.hidden) updateFooter(); }, CONFIG.tickerIntervalMs);

    const baseTitle = "NEURAL HORIZON — DEEP SPACE OBSERVATORY   ///   ";
    const titleString = baseTitle + baseTitle;
    
    function tickTitle(ts) {
      tickerRafId = requestAnimationFrame(tickTitle);
      if (document.hidden) { lastTickerTs = ts; return; }
      if (!lastTickerTs) lastTickerTs = ts;
      
      const dt = ts - lastTickerTs;
      lastTickerTs = ts;
      
      tickerScrollPos += dt * 0.03;
      if (tickerScrollPos >= baseTitle.length) tickerScrollPos -= baseTitle.length;
      
      const start = Math.floor(tickerScrollPos);
      document.title = titleString.substring(start, start + baseTitle.length);
    }
    tickerRafId = requestAnimationFrame(tickTitle);
  }

  function startTelemetryLoop() {
    telemetryTimer = setInterval(() => {
      if (document.hidden) return;
      syncUi();
      if (dom.tlmUptime) {
        const s = Math.floor((performance.now() - state.startTime) / 1000);
        const hh = String(Math.floor(s / 3600)).padStart(2, "0");
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
        const ss = String(s % 60).padStart(2, "0");
        dom.tlmUptime.textContent = `${hh}:${mm}:${ss}`;
      }
    }, 250);
  }

  function randomSessionId() {
    const hex = "0123456789ABCDEF";
    let out = "";
    for (let i = 0; i < 6; i++) out += hex[Math.floor(Math.random() * 16)];
    return `${CONFIG.sessionLabel}-${out}`;
  }

  /* ---------- 12. LIFECYCLE ---------- */
  let resizeObserver = null;
  let resizeRafId = null;

  function handleResize() {
    if (resizeRafId !== null) return;
    resizeRafId = requestAnimationFrame(() => { resizeRafId = null; Renderer.resize(); Diagnostics.resize(); });
  }

  function init() {
    if (dom.sessionId) dom.sessionId.textContent = randomSessionId();
    if (!Renderer.init()) setStatus("error", "ERROR");
    Diagnostics.init();
    Renderer.resize();
    Diagnostics.resize();
    Renderer.setMode(state.mode);
    Renderer.start();
    attachControls();
    Input.attach();
    syncUi();
    updateMicUi();
    
    [dom.btnMotion, dom.btnPause, dom.btnSound, dom.btnMic].forEach(b => b && b.setAttribute("aria-pressed", "false"));
    if (dom.btnDiag) dom.btnDiag.setAttribute("aria-expanded", "false");
    
    setStatus("active", "ACTIVE");
    if (dom.footerSim) dom.footerSim.textContent = "ACTIVE";
    if (dom.footerInput) dom.footerInput.textContent = "POINTER";
    if (dom.footerRender) dom.footerRender.textContent = "RUNNING";

    startClock();
    startTicker();
    startTelemetryLoop();

    if (window.ResizeObserver) {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(dom.viewport);
    } else {
      window.addEventListener("resize", handleResize);
    }
    window.addEventListener("orientationchange", handleResize);
    window.addEventListener("pagehide", teardown);

    announce("Neural Horizon online. Visualization active.");
  }

  function teardown() {
    Renderer.stopLoop();
    Diagnostics.stop();
    if (tickerRafId) cancelAnimationFrame(tickerRafId);
    if (clockTimer) clearInterval(clockTimer);
    if (tickerTimer) clearInterval(tickerTimer);
    if (telemetryTimer) clearInterval(telemetryTimer);
    if (resizeObserver) resizeObserver.disconnect();
    window.removeEventListener("orientationchange", handleResize);
    Mic.stop();
    Synth.dispose();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();