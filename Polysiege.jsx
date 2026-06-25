import React, { useRef, useEffect, useState, useCallback } from "react";

/* =========================================================================
   POLYSIEGE — minimalist dark tower defense
   ========================================================================= */

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const PALETTE = {
  bgGrid: "#101824",
  core: "#dff4f2",
  coreGlow: "rgba(94,227,224,0.35)",
  projectile: { standard: "#9be8e6", heavy: "#f2c94c", piercing: "#c792ff", overcharged: "#ff7a5e" },
  ring: "rgba(94,227,224,0.12)",
};

/* -------------------------------------------------------------------------
   Sound — tiny synthesized SFX via Web Audio, no external asset files.
   Lazily created on first user gesture (autoplay policy compliant).
   ------------------------------------------------------------------------- */
const SFX = {
  ctx: null,
  enabled: true,
  lastShotAt: 0,

  ensure() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  },

  // oscillator with a soft attack (avoids clicking) + exponential decay,
  // routed through a lowpass to tame harsh upper harmonics on square/saw
  tone(freq, dur, type = "sine", gain = 0.08, glideTo = null, filterFreq = 4000) {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t0 + dur);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(filterFreq, t0);
    const attack = Math.min(0.012, dur * 0.25);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(filter);
    filter.connect(amp);
    amp.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },

  // filtered noise burst, used for explosions / impacts / texture
  noiseBurst(dur, gain = 0.12, filterFreq = 1200, filterType = "lowpass") {
    if (!this.enabled) return;
    const ctx = this.ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(filterFreq, t0);
    if (filterType === "lowpass") filter.frequency.exponentialRampToValueAtTime(80, t0 + dur);
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, t0);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(amp);
    amp.connect(ctx.destination);
    src.start(t0);
  },

  shoot() {
    // throttle so a maxed-out fire rate doesn't become a buzz
    const now = performance.now();
    if (now - this.lastShotAt < 40) return;
    this.lastShotAt = now;
    // a clean, soft "tick" — triangle wave dropping in pitch (not rising),
    // very short and quiet since this fires constantly. A faint high-passed
    // noise tap adds a touch of mechanical snap without any harsh buzz.
    this.tone(360, 0.045, "triangle", 0.05, 190, 2200);
    this.noiseBurst(0.02, 0.025, 5000, "highpass");
  },

  explode(enemy) {
    // bigger enemies (more sides / higher tier) get a slightly lower,
    // beefier hit so the strongest enemies feel like a bigger event
    const tierFactor = clamp((enemy && enemy.sides ? enemy.sides : 4) / 10, 0.3, 1);
    this.noiseBurst(0.2 + tierFactor * 0.12, 0.14, 1700 - tierFactor * 700);
    this.tone(180 - tierFactor * 60, 0.16, "sine", 0.07, 70, 1200);
  },

  breach() {
    this.tone(110, 0.24, "triangle", 0.1, 48, 600);
    this.noiseBurst(0.16, 0.09, 700);
  },

  waveClear() {
    this.tone(440, 0.11, "sine", 0.06, 660, 3000);
    setTimeout(() => this.tone(660, 0.16, "sine", 0.06, 880, 3000), 90);
  },

  upgrade() {
    this.tone(500, 0.08, "sine", 0.06, 740, 3500);
  },

  denied() {
    // deliberately dull and low so it never reads as another shot
    this.tone(180, 0.09, "sine", 0.035, 130, 800);
  },

  death() {
    this.tone(180, 0.55, "triangle", 0.09, 45, 500);
    this.noiseBurst(0.3, 0.06, 400);
  },
};

function playSound(kind, payload) {
  try {
    if (kind === "shoot") SFX.shoot();
    else if (kind === "explode") SFX.explode(payload);
    else if (kind === "breach") SFX.breach();
    else if (kind === "waveClear") SFX.waveClear();
    else if (kind === "upgrade") SFX.upgrade();
    else if (kind === "denied") SFX.denied();
    else if (kind === "death") SFX.death();
  } catch (e) {
    // audio is best-effort; never let it break gameplay
  }
}

// tier list — every enemy is a regular polygon; later tiers add sides
// rather than switching to a different kind of shape.
// splitLevel > 0 means: on death, break into childCount smaller copies
// with splitLevel - 1 (which may split again if > 0).
const ENEMY_TYPES = [
  { shape: "poly", sides: 3,  color: "#7d93a8", glow: "rgba(125,147,168,0.55)", hpMul: 1,    spdMul: 1.18, scoreMul: 1,    name: "Scout",       unlockWave: 1,  splitLevel: 0 },
  { shape: "poly", sides: 4,  color: "#e0a458", glow: "rgba(224,164,88,0.55)",  hpMul: 2.4,  spdMul: 0.95, scoreMul: 1.5,  name: "Bulwark",     unlockWave: 2,  splitLevel: 0 },
  { shape: "poly", sides: 5,  color: "#e0626c", glow: "rgba(224,98,108,0.6)",   hpMul: 4.2,  spdMul: 0.9,  scoreMul: 2,    name: "Render",      unlockWave: 4,  splitLevel: 0 },
  { shape: "poly", sides: 6,  color: "#a866e0", glow: "rgba(168,102,224,0.6)",  hpMul: 7.5,  spdMul: 0.78, scoreMul: 2.8,  name: "Warden",      unlockWave: 6,  splitLevel: 0 },
  { shape: "poly", sides: 5,  color: "#ff9d4d", glow: "rgba(255,157,77,0.6)",   hpMul: 9,    spdMul: 0.82, scoreMul: 2.4,  name: "Cleaver",     unlockWave: 8,  splitLevel: 1, childCount: 2 },
  { shape: "poly", sides: 7,  color: "#52d0a0", glow: "rgba(82,208,160,0.6)",   hpMul: 12.5, spdMul: 0.7,  scoreMul: 3.8,  name: "Monolith",    unlockWave: 9,  splitLevel: 0 },
  { shape: "poly", sides: 8,  color: "#ff8c5a", glow: "rgba(255,140,90,0.6)",   hpMul: 20,   spdMul: 0.62, scoreMul: 5.2,  name: "Sentinel",    unlockWave: 12, splitLevel: 0 },
  { shape: "poly", sides: 9,  color: "#ff5e8c", glow: "rgba(255,94,140,0.6)",   hpMul: 32,   spdMul: 0.95, scoreMul: 7,    name: "Harbinger",   unlockWave: 16, splitLevel: 0 },
  { shape: "poly", sides: 10, color: "#f2e25e", glow: "rgba(242,226,94,0.65)",  hpMul: 50,   spdMul: 0.5,  scoreMul: 9.5,  name: "Eclipse",     unlockWave: 20, splitLevel: 0 },
  { shape: "poly", sides: 6,  color: "#ff4d6d", glow: "rgba(255,77,109,0.7)",   hpMul: 70,   spdMul: 0.55, scoreMul: 11,   name: "Fracture",    unlockWave: 22, splitLevel: 2, childCount: 2 },
  { shape: "poly", sides: 11, color: "#8fa3ff", glow: "rgba(143,163,255,0.65)", hpMul: 95,   spdMul: 0.42, scoreMul: 14,   name: "Aberration",  unlockWave: 28, splitLevel: 0 },
  { shape: "poly", sides: 7,  color: "#5effc1", glow: "rgba(94,255,193,0.65)",  hpMul: 60,   spdMul: 0.7,  scoreMul: 16,   name: "Swarmcaller", unlockWave: 35, splitLevel: 1, childCount: 3, childSpeedMul: 1.55 },
];

const ROUND_NAMES = ["STANDARD", "HEAVY SHOT", "PIERCING", "OVERCHARGED"];
const ROUND_DESCRIPTIONS = [
  "balanced rate and damage",
  "+85% dmg, -55% fire rate",
  "passes through 2 extra enemies",
  "splash damage on impact",
];
const ROUND_KEYS = ["standard", "heavy", "piercing", "overcharged"];

const MAX_LEVELS = { hp: 20, cannon: 22, range: 12 };
// cost growth multiplier eases off once a track passes its original cap —
// otherwise the new late-game levels would be mathematically unreachable
const OLD_CAPS = { hp: 12, cannon: 14, range: 8 };
// kept as the original string intentionally — changing it would orphan
// any existing player's save under the old Polygon Siege name
const SAVE_KEY = "polygon-siege-save";

function freshTower() {
  return {
    fireRate: 320,
    damage: 14,
    range: 320,
    roundLevel: 0,
    hpLevel: 0,
    cannonLevel: 0, // combined fire-rate + damage upgrade
    rangeLevel: 0,
    angle: 0,
    recoil: 0,
  };
}

function freshCosts() {
  return { hp: 40, cannon: 50, round: 130, range: 60 };
}

function freshState() {
  return {
    hp: 100,
    maxHp: 100,
    tokens: 0,
    score: 0,
    wave: 1,
    waveActive: false,
    tower: freshTower(),
    costs: freshCosts(),
  };
}

export default function Polysiege() {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const animRef = useRef(null);
  const lastTsRef = useRef(0);

  // mutable game world lives in a ref so the render loop doesn't fight React
  const gRef = useRef({
    enemies: [],
    projectiles: [],
    particles: [],
    floaters: [],
    spawnQueue: [],
    spawnTimer: 0,
    lastShot: 0,
    shake: 0,
    time: 0,
    camX: 0,
    camY: 0,
    dragging: false,
    dragStart: { x: 0, y: 0, camX: 0, camY: 0 },
    keys: {},
  });

  const stateRef = useRef(freshState());
  const [ui, setUi] = useState(freshState());
  const [phase, setPhase] = useState("loading"); // loading | intro | playing | paused | dead
  const [hasSave, setHasSave] = useState(false);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const [muted, setMuted] = useState(false);

  const toggleMute = useCallback(() => {
    SFX.ensure();
    SFX.enabled = !SFX.enabled;
    setMuted(!SFX.enabled);
  }, []);

  const runningRef = useRef(false);

  // ---------------- persistence ----------------
  const saveGame = useCallback(async () => {
    try {
      const s = stateRef.current;
      const payload = {
        hp: s.hp, maxHp: s.maxHp, tokens: s.tokens, score: s.score,
        wave: s.wave, tower: s.tower, costs: s.costs,
        savedAt: Date.now(),
      };
      await window.storage.set(SAVE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.error("save failed", e);
    }
  }, []);

  const loadGame = useCallback(async () => {
    try {
      const res = await window.storage.get(SAVE_KEY);
      if (res && res.value) return JSON.parse(res.value);
    } catch (e) {
      // no save yet
    }
    return null;
  }, []);

  const clearSave = useCallback(async () => {
    try { await window.storage.delete(SAVE_KEY); } catch (e) {}
  }, []);

  useEffect(() => {
    (async () => {
      const saved = await loadGame();
      setHasSave(!!saved);
      setPhase("intro");
    })();
  }, [loadGame]);

  // ---------------- sizing ----------------
  useEffect(() => {
    function resize() {
      if (!wrapRef.current) return;
      const r = wrapRef.current.getBoundingClientRect();
      setDims({ w: Math.max(320, r.width), h: Math.max(320, r.height) });
    }
    resize();
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = dims.w;
    c.height = dims.h;
  }, [dims]);

  // ---------------- camera pan controls ----------------
  const PAN_RADIUS = 260;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;

    function clampCam(g) {
      const d = Math.hypot(g.camX, g.camY);
      if (d > PAN_RADIUS) {
        const k = PAN_RADIUS / d;
        g.camX *= k;
        g.camY *= k;
      }
    }

    function onDown(e) {
      const g = gRef.current;
      g.dragging = true;
      const p = e.touches ? e.touches[0] : e;
      g.dragStart = { x: p.clientX, y: p.clientY, camX: g.camX, camY: g.camY };
    }
    function onMove(e) {
      const g = gRef.current;
      if (!g.dragging) return;
      const p = e.touches ? e.touches[0] : e;
      g.camX = g.dragStart.camX + (p.clientX - g.dragStart.x);
      g.camY = g.dragStart.camY + (p.clientY - g.dragStart.y);
      clampCam(g);
    }
    function onUp() { gRef.current.dragging = false; }

    function onKeyDown(e) {
      const g = gRef.current;
      if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key)) {
        g.keys[e.key] = true;
        e.preventDefault();
      }
      if (e.key === " ") {
        e.preventDefault();
        togglePause();
      }
    }
    function onKeyUp(e) {
      gRef.current.keys[e.key] = false;
    }

    c.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    c.addEventListener("touchstart", onDown, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      c.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      c.removeEventListener("touchstart", onDown);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------- game logic ----------------

  function availableTiers(wave) {
    return ENEMY_TYPES.filter((t) => wave >= t.unlockWave);
  }

  function buildWave(n) {
    const tiers = availableTiers(n);
    const maxIdx = tiers.length - 1;
    // single continuous ramp — gentle at the start, no hard transition
    // boundary anywhere that could create a difficulty cliff
    const count = Math.floor(6 + n * 1.3 + Math.pow(n, 1.4) * 0.25);
    const queue = [];
    for (let i = 0; i < count; i++) {
      let idx;
      const r = Math.random();
      if (r < 0.4) idx = Math.floor(rand(0, maxIdx * 0.4 + 1));
      else if (r < 0.78) idx = Math.floor(rand(0, maxIdx + 1));
      else idx = maxIdx;
      idx = clamp(idx, 0, maxIdx);
      queue.push(ENEMY_TYPES.indexOf(tiers[idx]));
    }
    return queue;
  }

  function spawnEnemy(tierIdx) {
    const g = gRef.current;
    const type = ENEMY_TYPES[tierIdx];
    const s = stateRef.current;
    const angle = rand(0, TAU);
    // world space is centered on the tower at (0,0); camera pan never affects this
    const spawnDist = Math.max(dims.w, dims.h) * 0.66 + 80;
    const x = Math.cos(angle) * spawnDist;
    const y = Math.sin(angle) * spawnDist;
    const baseHp = 20 + s.wave * 6.4;
    const hp = Math.round(baseHp * type.hpMul);
    g.enemies.push({
      x, y, tier: tierIdx,
      sides: type.sides,
      color: type.color,
      glow: type.glow,
      hp, maxHp: hp,
      speed: (25 + s.wave * 1.3) * type.spdMul,
      radius: 12 + type.sides * 1.55,
      rot: rand(0, TAU),
      rotSpeed: rand(-0.6, 0.6),
      scoreMul: type.scoreMul,
      wobble: rand(0, TAU),
      hitFlash: 0,
      name: type.name,
      splitLevel: type.splitLevel || 0,
      childCount: type.childCount || 2,
      childSpeedMul: type.childSpeedMul || 1.18,
      // tracks actual remaining power for breach damage — distinct from
      // `tier` (which stays fixed for identity/color/naming purposes even
      // after splitting) so a tiny grandchild fragment doesn't hit the
      // core as hard as the full-size parent it came from
      effectiveTier: tierIdx,
    });
  }

  // spawned when a split-capable enemy dies — smaller copies appear at the
  // parent's position, each one tier weaker in the split chain. Count and
  // speed boost are inherited so e.g. Swarmcaller's 3-fast-children twist
  // carries through correctly.
  function spawnChild(parent) {
    const g = gRef.current;
    const childHp = Math.max(6, Math.round(parent.maxHp * 0.42));
    const childRadius = Math.max(8, parent.radius * 0.66);
    const count = parent.childCount || 2;
    const speedMul = parent.childSpeedMul || 1.18;
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU);
      const offset = parent.radius * 0.5;
      g.enemies.push({
        x: parent.x + Math.cos(a) * offset,
        y: parent.y + Math.sin(a) * offset,
        tier: parent.tier,
        sides: parent.sides,
        color: parent.color,
        glow: parent.glow,
        hp: childHp,
        maxHp: childHp,
        speed: parent.speed * speedMul,
        radius: childRadius,
        rot: rand(0, TAU),
        rotSpeed: rand(-0.8, 0.8),
        scoreMul: parent.scoreMul * (0.9 / count),
        wobble: rand(0, TAU),
        hitFlash: 0,
        name: parent.name,
        splitLevel: parent.splitLevel - 1,
        childCount: parent.childCount || 2,
        childSpeedMul: parent.childSpeedMul || 1.18,
        // decays each generation so breach damage reflects this fragment's
        // actual remaining power, not the original parent's full tier
        effectiveTier: (parent.effectiveTier ?? parent.tier) * 0.42,
      });
    }
  }

  function startWave() {
    const s = stateRef.current;
    const g = gRef.current;
    g.spawnQueue = buildWave(s.wave);
    g.spawnTimer = 0;
    s.waveActive = true;
  }

  function findTarget() {
    const g = gRef.current;
    const s = stateRef.current;
    let best = null, bestD = Infinity;
    for (const e of g.enemies) {
      const d = dist(0, 0, e.x, e.y);
      if (d < s.tower.range && d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  function fireProjectile(target) {
    const g = gRef.current;
    const s = stateRef.current;
    const t = s.tower;
    const roundKey = ROUND_KEYS[t.roundLevel];
    const isHeavy = roundKey === "heavy";
    // Heavy Shot trades fire rate for a real damage multiplier — it's a
    // bigger-caliber round, not just a recolored standard shot
    const damage = isHeavy ? t.damage * 1.85 : t.damage;
    const speed = isHeavy ? 7.5 : 9.5;
    const ang = Math.atan2(target.y, target.x);
    g.projectiles.push({
      x: Math.cos(ang) * 34,
      y: Math.sin(ang) * 34,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      damage,
      kind: roundKey,
      pierce: roundKey === "piercing" ? 2 : 0,
      splash: roundKey === "overcharged",
      life: 110,
      trail: [],
    });
    t.recoil = isHeavy ? 9 : 6;
    t.angle = ang;
    playSound("shoot");
  }

  function spawnFloater(x, y, text, color) {
    gRef.current.floaters.push({ x, y, text, color, life: 50, maxLife: 50 });
  }

  function explode(enemy, reduceMotion) {
    const g = gRef.current;
    const s = stateRef.current;
    const n = reduceMotion ? 6 : 14 + enemy.sides * 2;
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(1.5, 6.5);
      g.particles.push({
        x: enemy.x, y: enemy.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(24, 46), maxLife: 46,
        color: enemy.color, size: rand(2, 4.5), kind: "spark",
      });
    }
    const shardCount = enemy.sides;
    for (let i = 0; i < shardCount; i++) {
      const a = (i / shardCount) * TAU + enemy.rot;
      const sp = rand(2, 4.5);
      g.particles.push({
        x: enemy.x + Math.cos(a) * enemy.radius * 0.4,
        y: enemy.y + Math.sin(a) * enemy.radius * 0.4,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        rot: a, rotSpeed: rand(-0.3, 0.3),
        life: rand(30, 55), maxLife: 55,
        color: enemy.color, size: enemy.radius * 0.5, kind: "shard",
      });
    }
    g.particles.push({
      x: enemy.x, y: enemy.y, vx: 0, vy: 0,
      life: 20, maxLife: 20, color: enemy.color, kind: "ring", size: enemy.radius,
    });

    // tokens are earned per enemy destroyed, scaled only by what it was —
    // not by which wave it happened to spawn in
    const gain = Math.round(8 * enemy.scoreMul);
    s.tokens += gain;
    s.score += gain * 10;
    spawnFloater(enemy.x, enemy.y, "+" + gain, enemy.color);
  }

  // single entry point for any enemy death: always explode + pay out,
  // and additionally fracture into two weaker copies if this enemy
  // still has split charges left
  function killEnemy(enemy, reduceMotion) {
    explode(enemy, reduceMotion);
    playSound("explode", enemy);
    if (enemy.splitLevel > 0) {
      spawnChild(enemy);
    }
  }

  // ---------------- upgrade purchase ----------------
  function costGrowth(key, level, steepRate, easedRate) {
    return level < OLD_CAPS[key] ? steepRate : easedRate;
  }

  const buy = useCallback((key) => {
    const s = stateRef.current;
    const t = s.tower;
    let bought = false;
    if (key === "hp" && t.hpLevel < MAX_LEVELS.hp && s.tokens >= s.costs.hp) {
      s.tokens -= s.costs.hp; t.hpLevel++;
      s.maxHp += 18; s.hp += 18;
      s.costs.hp = Math.round(s.costs.hp * costGrowth("hp", t.hpLevel, 1.46, 1.22)); bought = true;
    } else if (key === "cannon" && t.cannonLevel < MAX_LEVELS.cannon && s.tokens >= s.costs.cannon) {
      s.tokens -= s.costs.cannon; t.cannonLevel++;
      t.fireRate = Math.max(95, t.fireRate * 0.95);
      t.damage += 4.5;
      s.costs.cannon = Math.round(s.costs.cannon * costGrowth("cannon", t.cannonLevel, 1.5, 1.24)); bought = true;
    } else if (key === "range" && t.rangeLevel < MAX_LEVELS.range && s.tokens >= s.costs.range) {
      s.tokens -= s.costs.range; t.rangeLevel++;
      t.range += 34;
      s.costs.range = Math.round(s.costs.range * costGrowth("range", t.rangeLevel, 1.4, 1.2)); bought = true;
    } else if (key === "round" && t.roundLevel < ROUND_NAMES.length - 1 && s.tokens >= s.costs.round) {
      s.tokens -= s.costs.round; t.roundLevel++;
      s.costs.round = Math.round(s.costs.round * 2.4); bought = true;
    }
    if (bought) {
      setUi({ ...s, tower: { ...t } });
      saveGame();
      playSound("upgrade");
    } else {
      playSound("denied");
    }
  }, [saveGame]);

  // ---------------- pause / resume ----------------
  const togglePause = useCallback(() => {
    setPhase((p) => {
      if (p === "playing") { saveGame(); return "paused"; }
      if (p === "paused") return "playing";
      return p;
    });
  }, [saveGame]);

  const startNew = useCallback(async () => {
    SFX.ensure();
    await clearSave();
    stateRef.current = freshState();
    gRef.current = {
      enemies: [], projectiles: [], particles: [], floaters: [],
      spawnQueue: [], spawnTimer: 0, lastShot: 0, shake: 0, time: 0,
      camX: 0, camY: 0, dragging: false, dragStart: { x: 0, y: 0, camX: 0, camY: 0 }, keys: {},
    };
    setUi({ ...stateRef.current });
    setHasSave(false);
    setPhase("playing");
    startWave();
  }, [clearSave]);

  const continueGame = useCallback(async () => {
    SFX.ensure();
    const saved = await loadGame();
    const fresh = freshState();
    if (saved) {
      stateRef.current = {
        ...fresh,
        hp: saved.hp ?? fresh.hp,
        maxHp: saved.maxHp ?? fresh.maxHp,
        tokens: saved.tokens ?? fresh.tokens,
        score: saved.score ?? fresh.score,
        wave: saved.wave ?? fresh.wave,
        tower: { ...fresh.tower, ...saved.tower },
        costs: { ...fresh.costs, ...saved.costs },
        waveActive: false,
      };
    } else {
      stateRef.current = fresh;
    }
    gRef.current = {
      enemies: [], projectiles: [], particles: [], floaters: [],
      spawnQueue: [], spawnTimer: 0, lastShot: 0, shake: 0, time: 0,
      camX: 0, camY: 0, dragging: false, dragStart: { x: 0, y: 0, camX: 0, camY: 0 }, keys: {},
    };
    setUi({ ...stateRef.current });
    setPhase("playing");
    startWave();
  }, [loadGame]);

  // ---------------- main loop ----------------
  useEffect(() => {
    runningRef.current = phase === "playing";
  }, [phase]);

  useEffect(() => {
    const reduceMotion = window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let saveTimer = 0;

    function update(dt) {
      const s = stateRef.current;
      const g = gRef.current;

      // keyboard pan — camera is purely a view offset, never touches simulation coords
      const panSpeed = 0.42 * dt;
      if (g.keys.ArrowUp) g.camY += panSpeed;
      if (g.keys.ArrowDown) g.camY -= panSpeed;
      if (g.keys.ArrowLeft) g.camX += panSpeed;
      if (g.keys.ArrowRight) g.camX -= panSpeed;
      const camD = Math.hypot(g.camX, g.camY);
      if (camD > PAN_RADIUS) {
        const k = PAN_RADIUS / camD;
        g.camX *= k; g.camY *= k;
      }

      g.time += dt;

      // tower lives at fixed world origin (0,0); all entities below are world-space
      if (s.waveActive) {
        g.spawnTimer -= dt;
        if (g.spawnTimer <= 0 && g.spawnQueue.length) {
          spawnEnemy(g.spawnQueue.shift());
          // single continuous decay toward a low floor — gentle early,
          // tightening smoothly with no transition cliff
          g.spawnTimer = Math.max(140, 820 * Math.pow(0.93, s.wave));
        }
        if (!g.spawnQueue.length && !g.enemies.length) {
          s.waveActive = false;
          s.wave++;
          // wave-clear bonus — a flat reward on top of per-kill tokens so
          // the economy isn't purely "however many enemies you happened to kill"
          const waveBonus = Math.round(30 + s.wave * 6);
          s.tokens += waveBonus;
          s.score += waveBonus * 5;
          spawnFloater(0, -60, "WAVE CLEARED", "#5ee3e0");
          spawnFloater(0, -38, "+" + waveBonus + " BONUS", "#f2c94c");
          setUi({ ...s });
          saveGame();
          playSound("waveClear");
          setTimeout(() => { if (runningRef.current) startWave(); }, 1700);
        }
      }

      g.lastShot += dt;
      const effectiveFireRate = ROUND_KEYS[s.tower.roundLevel] === "heavy"
        ? s.tower.fireRate * 1.55
        : s.tower.fireRate;
      if (g.lastShot >= effectiveFireRate) {
        const target = findTarget();
        if (target) { fireProjectile(target); g.lastShot = 0; }
      }
      if (s.tower.recoil > 0) s.tower.recoil *= 0.85;

      for (let i = g.projectiles.length - 1; i >= 0; i--) {
        const p = g.projectiles[i];
        p.trail.push({ x: p.x, y: p.y });
        if (p.trail.length > 6) p.trail.shift();
        p.x += p.vx; p.y += p.vy;
        p.life--;
        if (p.life <= 0) { g.projectiles.splice(i, 1); continue; }
        for (let j = g.enemies.length - 1; j >= 0; j--) {
          const e = g.enemies[j];
          if (dist(p.x, p.y, e.x, e.y) < e.radius) {
            e.hp -= p.damage;
            e.hitFlash = 4;
            spawnFloater(e.x, e.y - e.radius, "-" + Math.round(p.damage), "#ff8c7a");

            if (p.splash) {
              // splash hits every other enemy within a small blast radius
              // at reduced damage, then the round is spent (no piercing)
              const SPLASH_RADIUS = 46;
              const SPLASH_FRACTION = 0.45;
              for (let k = g.enemies.length - 1; k >= 0; k--) {
                if (k === j) continue;
                const other = g.enemies[k];
                if (dist(p.x, p.y, other.x, other.y) < SPLASH_RADIUS) {
                  other.hp -= p.damage * SPLASH_FRACTION;
                  other.hitFlash = 4;
                  if (other.hp <= 0) {
                    killEnemy(other, reduceMotion);
                    g.enemies.splice(k, 1);
                    if (k < j) j--; // keep j valid after removing an earlier element
                  }
                }
              }
              g.particles.push({
                x: p.x, y: p.y, vx: 0, vy: 0,
                life: 16, maxLife: 16, color: PALETTE.projectile.overcharged, kind: "ring", size: SPLASH_RADIUS * 0.5,
              });
              g.projectiles.splice(i, 1);
            } else if (p.pierce > 0) {
              p.pierce--;
            } else {
              g.projectiles.splice(i, 1);
            }

            if (e.hp <= 0) {
              killEnemy(e, reduceMotion);
              g.enemies.splice(j, 1);
            }
            break;
          }
        }
      }

      for (let i = g.enemies.length - 1; i >= 0; i--) {
        const e = g.enemies[i];
        e.rot += e.rotSpeed * dt * 0.001;
        e.wobble += dt * 0.002;
        const ang = Math.atan2(-e.y, -e.x); // toward world origin
        const wob = Math.sin(e.wobble) * 0.15;
        e.x += Math.cos(ang + wob) * e.speed * dt * 0.001;
        e.y += Math.sin(ang + wob) * e.speed * dt * 0.001;
        if (e.hitFlash > 0) e.hitFlash -= dt * 0.13;

        const coreD = dist(e.x, e.y, 0, 0);
        if (coreD < 30) {
          s.hp -= 9 + (e.effectiveTier ?? e.tier) * 3.4;
          g.enemies.splice(i, 1);
          setUi({ ...s });
          if (s.hp <= 0) {
            s.hp = 0;
            g.shake = 0;
            runningRef.current = false;
            clearSave();
            setPhase("dead");
            setUi({ ...s });
            playSound("death");
          } else {
            g.shake = 14;
            playSound("breach");
          }
        }
      }

      for (let i = g.particles.length - 1; i >= 0; i--) {
        const pt = g.particles[i];
        pt.x += pt.vx; pt.y += pt.vy;
        pt.vx *= 0.96; pt.vy *= 0.96;
        if (pt.rotSpeed) pt.rot += pt.rotSpeed;
        pt.life--;
        if (pt.life <= 0) g.particles.splice(i, 1);
      }

      for (let i = g.floaters.length - 1; i >= 0; i--) {
        const f = g.floaters[i];
        f.y -= 0.5; f.life--;
        if (f.life <= 0) g.floaters.splice(i, 1);
      }

      if (g.shake > 0) g.shake *= 0.88;

      saveTimer += dt;
      if (saveTimer > 8000) { saveTimer = 0; saveGame(); }
    }

    function drawPolygon(ctx, x, y, radius, sides, rotation) {
      ctx.beginPath();
      for (let i = 0; i < sides; i++) {
        const a = rotation + (i / sides) * TAU;
        const px = x + Math.cos(a) * radius;
        const py = y + Math.sin(a) * radius;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }

    function traceEnemyShape(ctx, e) {
      drawPolygon(ctx, e.x, e.y, e.radius, e.sides || 3, e.rot);
    }

    function draw() {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      const W = dims.w, H = dims.h;
      const g = gRef.current;
      const s = stateRef.current;

      ctx.clearRect(0, 0, W, H);

      let ox = 0, oy = 0;
      if (g.shake > 0.3) { ox = rand(-g.shake, g.shake); oy = rand(-g.shake, g.shake); }

      // one single transform: screen center + shake + camera pan.
      // everything drawn after this point uses world coordinates,
      // with the tower fixed at world (0,0).
      ctx.save();
      ctx.translate(W / 2 + ox + g.camX, H / 2 + oy + g.camY);

      // grid (world-space, so it pans naturally with everything else)
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = PALETTE.bgGrid;
      ctx.lineWidth = 1;
      const gap = 64;
      // draw enough grid lines to cover the screen regardless of pan
      const spanX = Math.ceil(W / gap) + 2;
      const spanY = Math.ceil(H / gap) + 2;
      const startGX = Math.floor(-g.camX / gap) - spanX / 2;
      const startGY = Math.floor(-g.camY / gap) - spanY / 2;
      for (let i = 0; i <= spanX + 2; i++) {
        const x = (startGX + i) * gap;
        ctx.beginPath(); ctx.moveTo(x, -H); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let i = 0; i <= spanY + 2; i++) {
        const y = (startGY + i) * gap;
        ctx.beginPath(); ctx.moveTo(-W, y); ctx.lineTo(W, y); ctx.stroke();
      }
      ctx.restore();

      // range ring (centered on tower at world origin)
      ctx.beginPath();
      ctx.arc(0, 0, s.tower.range, 0, TAU);
      ctx.strokeStyle = PALETTE.ring;
      ctx.lineWidth = 1;
      ctx.stroke();

      // danger ring
      ctx.beginPath();
      ctx.arc(0, 0, 30, 0, TAU);
      ctx.strokeStyle = "rgba(255,107,94,0.25)";
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);

      // shockwave rings (behind enemies)
      for (const pt of g.particles) {
        if (pt.kind === "ring") {
          const t = pt.life / pt.maxLife;
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size * (1 + (1 - t) * 2.2), 0, TAU);
          ctx.strokeStyle = pt.color;
          ctx.globalAlpha = t * 0.5;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // enemies — OUTLINE ONLY (world space)
      for (const e of g.enemies) {
        const flashed = e.hitFlash > 0;
        ctx.save();
        ctx.shadowColor = e.glow;
        ctx.shadowBlur = 16;
        traceEnemyShape(ctx, e);
        ctx.lineWidth = flashed ? 3.2 : 2;
        ctx.strokeStyle = flashed ? "#ffffff" : e.color;
        ctx.stroke();
        ctx.restore();

        // split-capable enemies get a nested inner outline per remaining
        // split charge — a visual tell that this one will fracture on death
        if (e.splitLevel > 0) {
          for (let k = 0; k < e.splitLevel; k++) {
            const innerR = e.radius * (0.52 - k * 0.16);
            if (innerR < 3) continue;
            ctx.save();
            ctx.globalAlpha = flashed ? 0.9 : 0.65;
            drawPolygon(ctx, e.x, e.y, innerR, e.sides, e.rot + g.time * 0.0006 * (k + 1));
            ctx.lineWidth = 1.3;
            ctx.strokeStyle = flashed ? "#ffffff" : e.color;
            ctx.setLineDash([3, 3]);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }

        if (e.hp < e.maxHp) {
          const w = e.radius * 2;
          const ratio = clamp(e.hp / e.maxHp, 0, 1);
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(e.x - w / 2, e.y - e.radius - 10, w, 3);
          ctx.fillStyle = ratio > 0.5 ? "#5ee3e0" : ratio > 0.25 ? "#f2c94c" : "#ff6b5e";
          ctx.fillRect(e.x - w / 2, e.y - e.radius - 10, w * ratio, 3);
        }
      }

      // shard / spark particles
      for (const pt of g.particles) {
        const t = pt.life / pt.maxLife;
        if (pt.kind === "spark") {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, pt.size * t, 0, TAU);
          ctx.fillStyle = pt.color;
          ctx.globalAlpha = t;
          ctx.fill();
          ctx.globalAlpha = 1;
        } else if (pt.kind === "shard") {
          ctx.save();
          ctx.translate(pt.x, pt.y);
          ctx.rotate(pt.rot);
          ctx.globalAlpha = t;
          ctx.strokeStyle = pt.color;
          ctx.lineWidth = 1.6;
          ctx.strokeRect(-pt.size / 2, -pt.size / 2, pt.size, pt.size);
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      }

      // projectiles
      for (const p of g.projectiles) {
        const color = PALETTE.projectile[p.kind] || PALETTE.projectile.standard;
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        for (let i = 0; i < p.trail.length; i++) {
          const tp = p.trail[i];
          ctx.globalAlpha = (i / p.trail.length) * 0.5;
          ctx.beginPath();
          ctx.arc(tp.x, tp.y, p.kind === "heavy" ? 3.5 : 2, 0, TAU);
          ctx.fillStyle = color;
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.kind === "heavy" ? 4.5 : 2.6, 0, TAU);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.restore();
      }

      // core tower — pure hexagon, no barrel. Recoil reads as a brief inner pulse.
      ctx.save();
      const pulse = 1 + Math.sin(g.time * 0.003) * 0.03;
      ctx.shadowColor = PALETTE.coreGlow;
      ctx.shadowBlur = 26;
      drawPolygon(ctx, 0, 0, 26 * pulse, 6, g.time * 0.0002);
      ctx.fillStyle = "#102020";
      ctx.fill();
      ctx.strokeStyle = PALETTE.core;
      ctx.lineWidth = 2;
      ctx.stroke();

      const recoilPulse = 1 + s.tower.recoil * 0.015;
      drawPolygon(ctx, 0, 0, 15 * recoilPulse, 6, -g.time * 0.0004);
      ctx.fillStyle = PALETTE.core;
      ctx.globalAlpha = 0.85;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();

      // floaters
      ctx.font = '600 12px "JetBrains Mono", monospace';
      ctx.textAlign = "center";
      for (const f of g.floaters) {
        const t = f.life / f.maxLife;
        ctx.globalAlpha = t;
        ctx.fillStyle = f.color;
        ctx.fillText(f.text, f.x, f.y);
        ctx.globalAlpha = 1;
      }

      ctx.restore(); // end of world-space camera transform

      // off-screen enemy direction indicators — convert each enemy's
      // world position to screen space using the same camera transform
      // used above, so arrows always point at where the enemy actually is
      const margin = 18;
      const camOX = W / 2 + ox + g.camX;
      const camOY = H / 2 + oy + g.camY;
      for (const e of g.enemies) {
        const sx = camOX + e.x;
        const sy = camOY + e.y;
        if (sx < 0 || sx > W || sy < 0 || sy > H) {
          const ang = Math.atan2(sy - H / 2, sx - W / 2);
          const ex = clamp(W / 2 + Math.cos(ang) * (W / 2 - margin), margin, W - margin);
          const ey = clamp(H / 2 + Math.sin(ang) * (H / 2 - margin), margin, H - margin);
          ctx.save();
          ctx.translate(ex, ey);
          ctx.rotate(ang);
          ctx.beginPath();
          ctx.moveTo(7, 0);
          ctx.lineTo(-5, 4);
          ctx.lineTo(-5, -4);
          ctx.closePath();
          ctx.fillStyle = e.color;
          ctx.globalAlpha = 0.85;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      }
    }

    let hudSyncCounter = 0;
    function loop(ts) {
      if (!lastTsRef.current) lastTsRef.current = ts;
      let dt = ts - lastTsRef.current;
      lastTsRef.current = ts;
      dt = Math.min(dt, 40);

      if (runningRef.current) {
        update(dt);
      }
      draw();

      // keep the HUD (hp/tokens/score/wave) in sync every few frames so
      // token gains from kills show up immediately, not just at wave-end
      hudSyncCounter++;
      if (runningRef.current && hudSyncCounter % 4 === 0) {
        const s = stateRef.current;
        setUi((prev) =>
          prev.hp === s.hp && prev.tokens === s.tokens && prev.score === s.score && prev.wave === s.wave
            ? prev
            : { ...prev, hp: s.hp, maxHp: s.maxHp, tokens: s.tokens, score: s.score, wave: s.wave }
        );
      }

      animRef.current = requestAnimationFrame(loop);
    }

    animRef.current = requestAnimationFrame(loop);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      lastTsRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dims, saveGame]);

  // ---------------- derived UI ----------------
  const s = ui;
  const t = s.tower || freshTower();
  const costs = s.costs || freshCosts();
  // below this width, the two side panels can't coexist without overlap —
  // collapse to compact icon-only rows instead (see audit: 220px+240px
  // needs ~514px minimum, which exceeds common phone widths)
  const isNarrow = dims.w < 640;

  function costLabel(key, level, max) {
    if (level >= max) return "MAX";
    return String(costs[key]);
  }

  return (
    <div
      ref={wrapRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100vh",
        background: "#07090d",
        overflow: "hidden",
        fontFamily: "'JetBrains Mono', monospace",
        color: "#cfe3eb",
        userSelect: "none",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&display=swap');
        .ps-panel {
          background: rgba(10,14,20,.74);
          border: 1px solid #1b2230;
          backdrop-filter: blur(6px);
        }
        .ps-btn {
          background: transparent;
          border: 1px solid #2b6b6a;
          color: #5ee3e0;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          padding: 5px 9px;
          cursor: pointer;
          letter-spacing: .05em;
          transition: all .15s ease;
          white-space: nowrap;
        }
        .ps-btn:hover:not(:disabled) {
          background: #5ee3e0;
          color: #07090d;
          border-color: #5ee3e0;
        }
        .ps-btn:disabled { opacity: .3; cursor: not-allowed; }
        .ps-big-btn {
          background: rgba(94,227,224,0.06);
          color: #5ee3e0;
          border: 1px solid #2b6b6a;
          font-family: 'JetBrains Mono', monospace;
          font-weight: 700;
          font-size: 12px;
          letter-spacing: .08em;
          padding: 11px 26px;
          cursor: pointer;
          transition: all .15s ease;
        }
        .ps-big-btn:hover {
          background: #5ee3e0;
          color: #07090d;
          border-color: #5ee3e0;
          transform: translateY(-1px);
          box-shadow: 0 4px 18px rgba(94,227,224,.25);
        }
        .ps-ghost-btn {
          background: transparent;
          border: 1px solid #1b2230;
          color: #5d7282;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          letter-spacing: .06em;
          padding: 9px 20px;
          cursor: pointer;
          margin-top: 10px;
        }
        .ps-ghost-btn:hover { color: #cfe3eb; border-color: #5d7282; }
      `}</style>

      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%", cursor: phase === "playing" ? "grab" : "default" }}
      />

      {/* top-left status */}
      <div style={{ position: "absolute", top: 18, left: 18, display: "flex", flexDirection: isNarrow ? "row" : "column", gap: 8, minWidth: isNarrow ? "auto" : 200, maxWidth: isNarrow ? "auto" : 220 }}>
        {isNarrow ? (
          <div className="ps-panel" style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 10, pointerEvents: "none" }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4, color: "#5ee3e0" }}>
              <HeartIcon /><span style={{ fontSize: 11, fontWeight: 700 }}>{Math.max(0, Math.round(s.hp))}</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4, color: "#f2c94c" }}>
              <CoinIcon /><span style={{ fontSize: 11, fontWeight: 700 }}>{s.tokens}</span>
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 4, color: "#5ee3e0" }}>
              <StarIcon /><span style={{ fontSize: 11, fontWeight: 700 }}>{s.score}</span>
            </span>
          </div>
        ) : (
          <>
            <div className="ps-panel" style={{ padding: "12px 14px", pointerEvents: "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ color: "#5d7282", textTransform: "uppercase", fontSize: 10 }}>Health</span>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{Math.max(0, Math.round(s.hp))}</span>
              </div>
              <div style={{ marginTop: 6, height: 6, width: "100%", background: "#10151d", border: "1px solid #1b2230", position: "relative", overflow: "hidden" }}>
                <div style={{ height: "100%", width: clamp((s.hp / s.maxHp) * 100, 0, 100) + "%", background: "linear-gradient(90deg,#3ddc97,#5ee3e0)", transition: "width .25s ease" }} />
              </div>
            </div>
            <div className="ps-panel" style={{ padding: "12px 14px", pointerEvents: "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#5d7282", textTransform: "uppercase", fontSize: 10 }}>Tokens</span>
                <span style={{ color: "#f2c94c", fontWeight: 700, fontSize: 13 }}>{s.tokens}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                <span style={{ color: "#5d7282", textTransform: "uppercase", fontSize: 10 }}>Score</span>
                <span style={{ color: "#5ee3e0", fontWeight: 700, fontSize: 13 }}>{s.score}</span>
              </div>
            </div>
          </>
        )}
        {(phase === "playing" || phase === "paused") && !isNarrow && (
          <div style={{ display: "flex", gap: 8, pointerEvents: "auto" }}>
            <button
              className="ps-btn"
              style={{ flex: 1, padding: "10px 10px" }}
              onClick={togglePause}
              title="Pause (space)"
            >
              {phase === "paused" ? "▶ RESUME" : "‖ PAUSE"}
            </button>
            <button
              className="ps-btn"
              style={{ flex: 1, padding: "10px 10px", display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
              onClick={toggleMute}
              title="Toggle sound"
            >
              <SpeakerIcon muted={muted} />
              <span>{muted ? "MUTED" : "SOUND"}</span>
            </button>
          </div>
        )}
      </div>

      {/* narrow screens: icon-only pause/sound row, separate from the
          stats strip above so neither gets cramped */}
      {isNarrow && (phase === "playing" || phase === "paused") && (
        <div style={{ position: "absolute", top: 60, left: 18, display: "flex", gap: 6, pointerEvents: "auto" }}>
          <button className="ps-btn" style={{ padding: "8px 9px" }} onClick={togglePause} title="Pause (space)">
            <PauseIcon paused={phase === "paused"} />
          </button>
          <button className="ps-btn" style={{ padding: "8px 9px" }} onClick={toggleMute} title="Toggle sound">
            <SpeakerIcon muted={muted} />
          </button>
        </div>
      )}

      {/* top center: wave indicator only — kept compact so it can never
          collide with the side panels on narrow/mobile screens */}
      <div style={{ position: "absolute", top: 18, left: "50%", transform: "translateX(-50%)", pointerEvents: "none" }}>
        <div className="ps-panel" style={{ padding: "8px 22px", textAlign: "center" }}>
          <div style={{ color: "#5d7282", fontSize: 9, textTransform: "uppercase", letterSpacing: ".1em" }}>Wave</div>
          <div style={{ fontSize: 15, letterSpacing: ".1em", fontWeight: 700 }}>{String(s.wave).padStart(2, "0")}</div>
        </div>
      </div>

      {/* top right upgrades */}
      {(phase === "playing" || phase === "paused") && (
        <div style={{ position: "absolute", top: 18, right: 18, width: 240, pointerEvents: "auto" }}>
          <div className="ps-panel" style={{ padding: 14 }}>
            <UpgradeRow
              name="Hull Plating" level={t.hpLevel} max={MAX_LEVELS.hp}
              cost={costLabel("hp", t.hpLevel, MAX_LEVELS.hp)}
              disabled={t.hpLevel >= MAX_LEVELS.hp || s.tokens < costs.hp}
              onBuy={() => buy("hp")} actionLabel="+18 HP"
            />
            <UpgradeRow
              name="Main Cannon" level={t.cannonLevel} max={MAX_LEVELS.cannon}
              cost={costLabel("cannon", t.cannonLevel, MAX_LEVELS.cannon)}
              disabled={t.cannonLevel >= MAX_LEVELS.cannon || s.tokens < costs.cannon}
              onBuy={() => buy("cannon")} actionLabel="UPGRADE"
              sublabel={`${Math.round(t.damage)} dmg · ${Math.round(t.fireRate)}ms`}
            />
            <UpgradeRow
              name="Range" level={t.rangeLevel} max={MAX_LEVELS.range}
              cost={costLabel("range", t.rangeLevel, MAX_LEVELS.range)}
              disabled={t.rangeLevel >= MAX_LEVELS.range || s.tokens < costs.range}
              onBuy={() => buy("range")} actionLabel="+34 RANGE"
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: "1px solid #1b2230", gap: 8 }}>
              <div>
                <div style={{ fontSize: 11 }}>Round Type</div>
                <div style={{ fontSize: 9, color: "#5d7282", letterSpacing: ".05em" }}>{ROUND_NAMES[t.roundLevel]}</div>
                <div style={{ fontSize: 9, color: "#7a8a9a", marginTop: 1 }}>{ROUND_DESCRIPTIONS[t.roundLevel]}</div>
              </div>
              <button
                className="ps-btn"
                disabled={t.roundLevel >= ROUND_NAMES.length - 1 || s.tokens < costs.round}
                onClick={() => buy("round")}
              >
                {t.roundLevel >= ROUND_NAMES.length - 1 ? "MAXED" : `UPGRADE · ${costs.round}`}
              </button>
            </div>
          </div>

          {t.hpLevel >= MAX_LEVELS.hp && t.cannonLevel >= MAX_LEVELS.cannon &&
            t.rangeLevel >= MAX_LEVELS.range && t.roundLevel >= ROUND_NAMES.length - 1 && (
            <div className="ps-panel" style={{ marginTop: 8, padding: "10px 14px", fontSize: 10, color: "#5ee3e0", letterSpacing: ".08em", textAlign: "center" }}>
              TOWER FULLY OVERCHARGED
            </div>
          )}
        </div>
      )}

      {/* drag/pan hint */}
      {phase === "playing" && (
        <div style={{ position: "absolute", bottom: 14, left: 18, fontSize: 9, color: "#5d7282", letterSpacing: ".05em", pointerEvents: "none" }}>
          drag or use arrow keys to scout the perimeter · space to pause
        </div>
      )}

      {/* center overlays */}
      {phase === "loading" && (
        <CenterPanel>
          <div style={{ fontSize: 11, color: "#5d7282" }}>loading…</div>
        </CenterPanel>
      )}

      {phase === "intro" && (
        <CenterPanel>
          <h1 style={{ fontSize: 26, letterSpacing: ".12em", marginBottom: 6, fontWeight: 800 }}>POLYSIEGE</h1>
          <p style={{ fontSize: 11, color: "#5d7282", marginBottom: 18, lineHeight: 1.6 }}>
            Hold the core. Earn tokens from kills to reinforce<br />
            the tower. Drag to scout the perimeter.
          </p>
          {hasSave && (
            <button className="ps-big-btn" style={{ marginBottom: 10 }} onClick={continueGame}>
              CONTINUE GAME
            </button>
          )}
          <div>
            <button className="ps-big-btn" onClick={startNew}>
              {hasSave ? "START NEW GAME" : "BEGIN DEFENSE"}
            </button>
          </div>
        </CenterPanel>
      )}

      {phase === "paused" && (
        <CenterPanel>
          <h1 style={{ fontSize: 22, letterSpacing: ".12em", marginBottom: 6, fontWeight: 800 }}>PAUSED</h1>
          <p style={{ fontSize: 11, color: "#5d7282", marginBottom: 18 }}>
            Progress is saved. The siege waits.
          </p>
          <button className="ps-big-btn" onClick={togglePause}>RESUME</button>
        </CenterPanel>
      )}

      {phase === "dead" && (
        <CenterPanel>
          <h1 style={{ fontSize: 26, letterSpacing: ".12em", marginBottom: 6, fontWeight: 800, color: "#ff6b5e" }}>
            CORE BREACHED
          </h1>
          <p style={{ fontSize: 11, color: "#5d7282", marginBottom: 14 }}>The siege has ended.</p>
          <div style={{ fontSize: 11, color: "#5ee3e0", marginBottom: 18 }}>
            WAVE {s.wave} &nbsp;·&nbsp; SCORE {s.score}
          </div>
          <button className="ps-big-btn" onClick={startNew}>START NEW GAME</button>
        </CenterPanel>
      )}
    </div>
  );
}

function CenterPanel({ children }) {
  return (
    <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", pointerEvents: "auto" }}>
      <div className="ps-panel" style={{ padding: "34px 46px", textAlign: "center" }}>
        {children}
      </div>
    </div>
  );
}

// minimal geometric speaker glyph — no emoji, matches the outline-only
// aesthetic used everywhere else in the HUD
function SpeakerIcon({ muted }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M4 9.5V14.5H7.5L12.5 18.5V5.5L7.5 9.5H4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        fill="none"
      />
      {muted ? (
        <path d="M16.5 9.5L21 14.5M21 9.5L16.5 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      ) : (
        <path d="M16.3 8.2C17.4 9.2 18 10.5 18 12C18 13.5 17.4 14.8 16.3 15.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      )}
    </svg>
  );
}

// minimal icon set for the icon-only compact HUD on narrow screens —
// same outlined, currentColor convention as SpeakerIcon
function PauseIcon({ paused }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      {paused ? (
        <path d="M6 4L19 12L6 20Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
      ) : (
        <>
          <rect x="6" y="4" width="4" height="16" rx="0.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
          <rect x="14" y="4" width="4" height="16" rx="0.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
        </>
      )}
    </svg>
  );
}

function HeartIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 19C12 19 4 14.2 4 8.8C4 6.1 6.1 4 8.6 4C10 4 11.2 4.7 12 5.8C12.8 4.7 14 4 15.4 4C17.9 4 20 6.1 20 8.8C20 14.2 12 19 12 19Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function CoinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M12 8V16M9.5 9.8C9.5 8.8 10.6 8 12 8C13.4 8 14.5 8.8 14.5 9.8C14.5 12.2 9.5 11.8 9.5 14.2C9.5 15.2 10.6 16 12 16C13.4 16 14.5 15.2 14.5 14.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 4L14.5 9.5L20 10.3L16 14.2L17 19.8L12 17L7 19.8L8 14.2L4 10.3L9.5 9.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 4L19 7V12C19 16.5 16 19.3 12 20.5C8 19.3 5 16.5 5 12V7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function CrosshairIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="6.5" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="M12 2V6M12 18V22M2 12H6M18 12H22" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function RadarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.3" fill="none" opacity="0.55" />
    </svg>
  );
}

function RoundTypeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M12 3L20 8.5V15.5L12 21L4 15.5V8.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function UpgradeRow({ name, level, max, cost, disabled, onBuy, actionLabel, sublabel }) {
  const pct = clamp((level / max) * 100, 0, 100);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: "1px solid #1b2230", gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11 }}>{name}</div>
        {sublabel ? (
          <div style={{ fontSize: 9, color: "#5d7282" }}>{sublabel}</div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
            <div style={{ flex: 1, height: 4, background: "#10151d", border: "1px solid #1b2230", position: "relative", overflow: "hidden" }}>
              <div style={{ height: "100%", width: pct + "%", background: "#5ee3e0", transition: "width .2s ease" }} />
            </div>
            <span style={{ fontSize: 8, color: "#5d7282", flexShrink: 0 }}>{level}/{max}</span>
          </div>
        )}
      </div>
      <button className="ps-btn" style={{ flexShrink: 0 }} disabled={disabled} onClick={onBuy}>
        {level >= max ? "MAXED" : `${actionLabel} · ${cost}`}
      </button>
    </div>
  );
}