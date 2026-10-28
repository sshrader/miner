'use strict';
// The shared mine. The server owns the cave, every miner and every block, and ticks it forward.
// Browsers only draw what this module reports, so everyone sees the same world in the same place.

const X = 36, Z = 26, N = X * Z, LV = 4, NN = LV * N, PH = 2, FT = 1, LH = PH + FT;
const HIT_TIME = 0.35, WALK_SPEED = 2.6, FHARD = 3;
const SLOTS = Math.max(1, Math.min(16, Number(process.env.MAX_MINERS) || 12));   // most miners in the mine at once
const HARD = [0, 3, 4, 2, 0, 999];                 // hits to break: 1 rock, 2 deep rock, 3 coal, 5 edge rock
const NAMES = ['', 'rock', 'deep rock', 'coal', '', 'edge rock'];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const baseY = (l) => -l * LH;
const gl = (g) => (g / N) | 0;
const gx = (g) => (g % N) % X;
const gz = (g) => (((g % N) / X) | 0);
const wx = (g) => gx(g) - X / 2 + 0.5;
const wz = (g) => gz(g) - Z / 2 + 0.5;
const r2 = (v) => Math.round(v * 100) / 100;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = a[i]; a[i] = a[j]; a[j] = t; }
  return a;
}

// Random fill, smoothed by a cellular rule, keeping only the biggest connected cavern.
function genCave() {
  for (let tries = 1; ; tries++) {
    let open = new Uint8Array(N);
    for (let z = 0; z < Z; z++) for (let x = 0; x < X; x++) {
      open[z * X + x] = (x === 0 || z === 0 || x === X - 1 || z === Z - 1) ? 0 : (Math.random() < 0.55 ? 1 : 0);
    }
    for (let it = 0; it < 4; it++) {
      const nxt = new Uint8Array(N);
      for (let z = 1; z < Z - 1; z++) for (let x = 1; x < X - 1; x++) {
        let w = 0;
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const ox = x + dx, oz = z + dz;
          if (ox < 0 || oz < 0 || ox >= X || oz >= Z || !open[oz * X + ox]) w++;
        }
        nxt[z * X + x] = w >= 5 ? 0 : 1;
      }
      open = nxt;
    }
    const comp = new Int16Array(N).fill(-1), q = new Int32Array(N);
    let best = -1, bestSize = 0, cid = 0;
    for (let i = 0; i < N; i++) {
      if (!open[i] || comp[i] >= 0) continue;
      let qh = 0, qt = 0, size = 0;
      q[qt++] = i; comp[i] = cid;
      while (qh < qt) {
        const c = q[qh++]; size++;
        const cx = c % X, cz = (c / X) | 0;
        const nb = [cx > 0 ? c - 1 : -1, cx < X - 1 ? c + 1 : -1, cz > 0 ? c - X : -1, cz < Z - 1 ? c + X : -1];
        for (let d = 0; d < 4; d++) { const n2 = nb[d]; if (n2 >= 0 && open[n2] && comp[n2] < 0) { comp[n2] = cid; q[qt++] = n2; } }
      }
      if (size > bestSize) { bestSize = size; best = cid; }
      cid++;
    }
    if (bestSize < 280 && tries < 30) continue;
    for (let i = 0; i < N; i++) if (open[i] && comp[i] !== best) open[i] = 0;
    return open;
  }
}

// hooks.onDig(miner, info) is called for every block or floor a miner breaks. It returns a reward in lamports (0 for none).
function createWorld(hooks) {
  const grid = new Uint8Array(NN), dmg = new Uint8Array(NN), fgrid = new Uint8Array(NN), fdmg = new Uint8Array(NN);
  const claim = new Uint8Array(2 * NN);          // wall targets use g, floor targets use NN + g; value is slot + 1
  const openByLevel = [[], [], [], []];
  let spawn = [];
  const miners = new Map();                      // slot -> miner
  let outbox = [], regenT = 0, worldDirty = false;
  const stats = { blocks: 0, regens: 0 };

  function emit(ev) { outbox.push(ev); }

  function genWorld() {
    claim.fill(0);
    for (let l = 0; l < LV; l++) {
      const open = genCave(), base = l * N, thr = Math.max(2, 4 - l);
      const dist = new Int16Array(N).fill(-1), q = new Int32Array(N);
      let qh = 0, qt = 0;
      openByLevel[l] = [];
      for (let i = 0; i < N; i++) if (open[i]) { dist[i] = 0; q[qt++] = i; openByLevel[l].push(i); }
      while (qh < qt) {
        const c = q[qh++], c0 = c % X, c1 = (c / X) | 0;
        const nb = [c0 > 0 ? c - 1 : -1, c0 < X - 1 ? c + 1 : -1, c1 > 0 ? c - X : -1, c1 < Z - 1 ? c + X : -1];
        for (let d = 0; d < 4; d++) { const n2 = nb[d]; if (n2 >= 0 && dist[n2] < 0) { dist[n2] = dist[c] + 1; q[qt++] = n2; } }
      }
      for (let i = 0; i < N; i++) {
        const x = i % X, z = (i / X) | 0, g = base + i;
        const edge = x === 0 || z === 0 || x === X - 1 || z === Z - 1;
        let t;
        if (open[i]) t = 0;
        else if (edge) t = 5;
        else if (dist[i] >= thr) t = 2;
        else t = Math.random() < 0.16 + 0.03 * l ? 3 : 1;
        grid[g] = t; dmg[g] = 0;
        fgrid[g] = l === LV - 1 ? 2 : 1; fdmg[g] = 0;
      }
    }
    const cand = shuffle(openByLevel[0].slice()), picks = [];
    for (let i = 0; i < cand.length && picks.length < SLOTS; i++) {
      let ok = true;
      for (let j = 0; j < picks.length; j++) {
        if (Math.abs(picks[j] % X - cand[i] % X) + Math.abs(((picks[j] / X) | 0) - ((cand[i] / X) | 0)) < 3) { ok = false; break; }
      }
      if (ok) picks.push(cand[i]);
    }
    for (let i = 0; picks.length < SLOTS; i++) picks.push(cand[i % cand.length]);
    spawn = picks;
  }

  function resetMiner(m) {
    m.g = spawn[m.id]; m.level = 0; m.path = []; m.target = -1; m.hit = 0; m.t = 0; m.dig = false; m.moving = false;
    m.pos = { x: wx(m.g), y: 6, z: wz(m.g) };
    m.state = 'spawn';
  }

  function addMiner(addr, hue) {
    let slot = -1;
    for (let s = 0; s < SLOTS; s++) if (!miners.has(s)) { slot = s; break; }
    if (slot < 0) return null;
    const m = { id: slot, addr, hue, g: 0, level: 0, pos: null, state: 'spawn', t: 0, path: [], target: -1, hit: 0, yaw: 0, dig: false, moving: false, next: 'think' };
    resetMiner(m);
    miners.set(slot, m);
    emit({ e: 'join', id: slot, a: addr });
    return m;
  }
  function removeMiner(id) {
    const m = miners.get(id);
    if (!m) return;
    releaseClaim(m);
    miners.delete(id);
    emit({ e: 'leave', id, a: m.addr });
  }
  function releaseClaim(m) {
    if (m.target >= 0 && claim[m.target] === m.id + 1) claim[m.target] = 0;
    m.target = -1; m.dig = false;
  }
  function startRegen() {
    if (regenT > 0) return;
    regenT = 1.4;
    miners.forEach((m) => { releaseClaim(m); m.state = 'idle'; m.moving = false; });
  }

  function think(m) {
    releaseClaim(m);
    const start = m.g, dist = new Int16Array(NN).fill(-1), par = new Int32Array(NN).fill(-1), q = new Int32Array(NN);
    let qh = 0, qt = 0, anyWall = false, anyFloor = false;
    const walls = [], floorsC = [];
    dist[start] = 0; q[qt++] = start;
    while (qh < qt) {
      const cur = q[qh++], l = gl(cur), x = gx(cur), z = gz(cur);
      for (let d = 0; d < 4; d++) {
        const nx = x + DIRS[d][0], nz = z + DIRS[d][1];
        if (nx < 0 || nx >= X || nz < 0 || nz >= Z) continue;
        const ng = l * N + nz * X + nx;
        if (grid[ng] === 0) {
          if (dist[ng] < 0) { dist[ng] = dist[cur] + 1; par[ng] = cur; q[qt++] = ng; }
        } else if (grid[ng] !== 5) {
          anyWall = true;
          if (!claim[ng]) walls.push(ng, cur);
        }
      }
      if (l < LV - 1) {
        if (fgrid[cur] === 0 && grid[cur + N] === 0) {
          if (dist[cur + N] < 0) { dist[cur + N] = dist[cur] + 1; par[cur + N] = cur; q[qt++] = cur + N; }
        } else if (fgrid[cur] === 1) {
          anyFloor = true;
          if (!claim[NN + cur]) floorsC.push(NN + cur, cur);
        }
      }
      if (l > 0 && fgrid[cur - N] === 0 && grid[cur - N] === 0 && dist[cur - N] < 0) { dist[cur - N] = dist[cur] + 1; par[cur - N] = cur; q[qt++] = cur - N; }
    }
    if (!anyWall && !anyFloor) { startRegen(); return; }
    const useFloor = floorsC.length && (!walls.length || Math.random() < 0.26);
    const list = useFloor ? floorsC : walls;
    if (!list.length) { m.state = 'wait'; m.t = 0.4; m.moving = false; return; }
    const pickN = Math.min(useFloor ? 6 : 10, list.length / 2), pk = ((Math.random() * pickN) | 0) * 2;
    const target = list[pk], stand = list[pk + 1], path = [];
    let c = stand;
    while (c !== start) { path.unshift(c); c = par[c]; }
    m.path = path; m.target = target; m.hit = 0; m.dig = target >= NN;
    claim[target] = m.id + 1;
    if (path.length) { m.state = 'move'; m.moving = true; } else beginMining(m);
  }
  function beginMining(m) { m.state = 'mine'; m.moving = false; m.hit = 0; }

  function reward(m, amt, x, y, z, what) {
    emit({ e: 'reward', by: m.id, amt, x: r2(x), y: r2(y), z: r2(z), what });
  }

  function hitBlock(m, g) {
    dmg[g]++;
    emit({ e: 'hit', g, d: dmg[g], by: m.id });
    if (dmg[g] >= HARD[grid[g]]) breakBlock(m, g);
  }
  function breakBlock(m, g) {
    const type = grid[g], l = gl(g);
    grid[g] = 0; dmg[g] = 0; claim[g] = 0; m.target = -1; m.dig = false;
    stats.blocks++;
    emit({ e: 'break', g, ty: type, by: m.id });
    const amt = hooks.onDig(m, { kind: 'wall', g, type }) || 0;
    if (amt > 0) { reward(m, amt, wx(g), baseY(l) + 0.9, wz(g), NAMES[type]); m.state = 'celebrate'; m.t = 0.9; } else m.state = 'think';
  }
  function hitFloor(m, g) {
    fdmg[g]++;
    emit({ e: 'fhit', g, d: fdmg[g], by: m.id });
    if (fdmg[g] >= FHARD) breakFloor(m, g);
  }
  // Breaking a floor opens a shaft: the cell below is carved out and the miner drops to the next level.
  function breakFloor(m, g) {
    const l = gl(g), lg = g + N, x = wx(g), z = wz(g);
    let found = 0;
    fgrid[g] = 0; fdmg[g] = 0; claim[NN + g] = 0; m.target = -1; m.dig = false;
    stats.blocks++;
    emit({ e: 'fbreak', g, by: m.id });
    let amt = hooks.onDig(m, { kind: 'floor', g }) || 0;
    if (amt > 0) { reward(m, amt, x, baseY(l), z, 'the floor'); found = 1; }
    if (grid[lg] !== 0) {
      const lt = grid[lg];
      grid[lg] = 0; dmg[lg] = 0; claim[lg] = 0;
      emit({ e: 'break', g: lg, ty: lt, by: m.id });
      amt = hooks.onDig(m, { kind: 'wall', g: lg, type: lt }) || 0;
      if (amt > 0) { reward(m, amt, x, baseY(l + 1) + 0.9, z, NAMES[lt]); found = 1; }
    }
    m.state = 'descend'; m.t = 0; m.y0 = m.pos.y; m.y1 = baseY(l + 1); m.g2 = lg; m.moving = false;
    m.next = found ? 'celebrate' : 'think';
  }

  function updateMiner(m, dt) {
    switch (m.state) {
      case 'spawn': {
        m.t += dt / 1.2;
        const k = Math.min(1, m.t), e = 1 - Math.pow(1 - k, 3);
        m.pos.y = 6 * (1 - e);
        if (k >= 1) { m.pos.y = 0; m.state = 'think'; }
        break;
      }
      case 'think': think(m); break;
      case 'wait':
        m.t -= dt;
        if (m.t <= 0) m.state = 'think';
        break;
      case 'move': {
        if (!m.path.length) { beginMining(m); break; }
        const nx = m.path[0], nl = gl(nx);
        const tx = wx(nx), ty = baseY(nl), tz = wz(nx);
        const dx = tx - m.pos.x, dy = ty - m.pos.y, dz = tz - m.pos.z;
        const dd = Math.sqrt(dx * dx + dy * dy + dz * dz), step = WALK_SPEED * dt;
        m.moving = true;
        if (Math.abs(dx) + Math.abs(dz) > 0.01) m.yaw = Math.atan2(dx, dz);
        if (dd <= step) {
          m.pos.x = tx; m.pos.y = ty; m.pos.z = tz; m.g = nx; m.path.shift(); m.level = nl;
          if (!m.path.length) beginMining(m);
        } else { m.pos.x += dx / dd * step; m.pos.y += dy / dd * step; m.pos.z += dz / dd * step; }
        break;
      }
      case 'mine': {
        const tg = m.target;
        if (tg < 0) { m.state = 'think'; break; }
        if (tg < NN) {
          if (grid[tg] === 0) { m.state = 'think'; break; }
          const ddx = wx(tg) - m.pos.x, ddz = wz(tg) - m.pos.z;
          if (Math.abs(ddx) + Math.abs(ddz) > 0.01) m.yaw = Math.atan2(ddx, ddz);
        } else if (fgrid[tg - NN] !== 1) { m.state = 'think'; break; }
        m.hit += dt;
        if (m.hit >= HIT_TIME) { m.hit -= HIT_TIME; if (tg < NN) hitBlock(m, tg); else hitFloor(m, tg - NN); }
        break;
      }
      case 'descend': {
        m.t += dt / 0.8;
        const kk = Math.min(1, m.t);
        m.pos.y = m.y0 + (m.y1 - m.y0) * kk * kk;
        if (kk >= 1) {
          m.pos.y = m.y1; m.g = m.g2; m.level = gl(m.g);
          if (m.next === 'celebrate') { m.state = 'celebrate'; m.t = 0.9; } else m.state = 'think';
        }
        break;
      }
      case 'celebrate':
        m.t -= dt;
        if (m.t <= 0) m.state = 'think';
        break;
      default: break;
    }
  }

  function tick(dt) {
    if (regenT > 0) {
      regenT -= dt;
      if (regenT <= 0) {
        genWorld();
        miners.forEach(resetMiner);
        stats.regens++;
        worldDirty = true;
      }
      return;
    }
    miners.forEach((m) => updateMiner(m, dt));
  }

  const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
  function worldMsg() {
    return { t: 'world', grid: b64(grid), dmg: b64(dmg), fgrid: b64(fgrid), fdmg: b64(fdmg), spawn };
  }
  function minersSnap() {
    const out = [];
    miners.forEach((m) => out.push({ id: m.id, a: m.addr, h: m.hue, x: r2(m.pos.x), y: r2(m.pos.y), z: r2(m.pos.z), yaw: r2(m.yaw), s: m.state, lv: m.level, d: m.dig ? 1 : 0 }));
    return out;
  }
  function flush() { const ev = outbox; outbox = []; return ev; }
  function takeWorldDirty() { const d = worldDirty; worldDirty = false; return d; }

  genWorld();
  return { miners, stats, genWorld, addMiner, removeMiner, tick, worldMsg, minersSnap, flush, emit, takeWorldDirty, _grid: grid, _fgrid: fgrid, constants: { X, Z, LV, N, NN } };
}

module.exports = { createWorld, SLOTS };
