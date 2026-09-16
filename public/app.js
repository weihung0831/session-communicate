const $ = s => document.querySelector(s);
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ACTIVE_MS = 3 * 60 * 1000;

const S = {
  data: null,
  messages: [],
  nodes: new Map(),
  pairs: new Map(),
  flights: [],
  ripples: [],
  bubbles: [],
  particles: [],
  stars: [],
  known: new Map(),
  firedSig: new Map(),
  hover: null,
  initialized: false,
  lastActivity: null,
  w: 0,
  h: 0,
  frame: 0,
};

function hue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function color(name, a = 1, l = 58, s = 70) { return `hsla(${hue(name)} ${s}% ${l}% / ${a})`; }
function pairKey(a, b) { return [a, b].sort().join('|'); }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOut(t) { return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function rand(a, b) { return a + Math.random() * (b - a); }
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - new Date(ts)) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
  return `${Math.floor(s / 86400)} 天前`;
}

function resize() {
  const r = canvas.getBoundingClientRect();
  S.w = r.width;
  S.h = r.height;
  canvas.width = Math.round(r.width * DPR);
  canvas.height = Math.round(r.height * DPR);
  seedStars();
  layout();
}
window.addEventListener('resize', resize);

function seedStars() {
  const n = Math.round((S.w * S.h) / 9000);
  S.stars = Array.from({ length: n }, () => ({
    x: Math.random() * S.w, y: Math.random() * S.h,
    r: rand(0.4, 1.6), a: rand(0.15, 0.6), sp: rand(0.02, 0.08), ph: rand(0, Math.PI * 2),
  }));
}

function layout() {
  const names = [...S.nodes.keys()].filter(n => !S.nodes.get(n).dying);
  const cx = S.w / 2, cy = S.h / 2 + 16;
  const R = names.length <= 1 ? 0 : Math.max(110, Math.min(S.w, S.h) * 0.36);
  names.forEach((n, i) => {
    const node = S.nodes.get(n);
    node.angle0 = -Math.PI / 2 + (i / names.length) * Math.PI * 2;
    node.r = node.r || 36;
    node.R = R;
    node.cx = cx;
    node.cy = cy;
    if (node.x == null) {
      node.x = cx;
      node.y = cy;
    }
  });
}

function spawnNode(name, live) {
  const node = {
    name, live, x: null, y: null, tx: 0, ty: 0, angle0: 0, R: 0, cx: 0, cy: 0,
    scale: 0, vscale: 0, bump: 0, glow: 0, lastRecv: 0, born: performance.now() + Math.random() * 300,
    phase: Math.random() * Math.PI * 2, dying: false,
  };
  S.nodes.set(name, node);
  return node;
}

function rebuildNodes() {
  const live = new Map();
  for (const s of S.data.sessions) if (s.live) live.set(s.name, s.live);
  let changed = false;
  for (const [n, node] of S.nodes) {
    if (!live.has(n) && !S.flights.some(f => f.a === node || f.b === node) && !node.dying) { node.dying = true; changed = true; }
    if (live.has(n) && node.dying) { node.dying = false; changed = true; }
  }
  for (const [n, lv] of live) {
    if (!S.nodes.has(n)) { spawnNode(n, lv); changed = true; }
    S.nodes.get(n).live = lv;
  }
  if (changed) layout();

  S.pairs.clear();
  for (const m of S.messages) {
    const k = pairKey(m.from.name, m.to.name);
    const p = S.pairs.get(k) || { count: 0, last: null, lastFrom: null, flow: 0 };
    p.count++;
    if (!p.last || new Date(m.ts) > new Date(p.last)) { p.last = m.ts; p.lastFrom = m.from.name; }
    S.pairs.set(k, p);
  }
  S.lastActivity = S.messages.length ? S.messages[S.messages.length - 1].ts : null;
}

function ensureNode(name) {
  if (!S.nodes.has(name)) { spawnNode(name, null); layout(); }
  const n = S.nodes.get(name);
  if (n.dying) { n.dying = false; layout(); }
  return n;
}

function fire(m) {
  const a = ensureNode(m.from.name), b = ensureNode(m.to.name);
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  S.flights.push({ m, a, b, t0: performance.now(), dur: REDUCED ? 500 : Math.min(2000, 1000 + len * 1.4), trail: [], emitted: 0 });
  a.bump = 1;
  a.glow = 1;
  burst(a.x, a.y, m.from.name, 10, 1.2);
}

function flightCtrl(f) {
  const dx = f.b.x - f.a.x, dy = f.b.y - f.a.y;
  const side = f.a.name < f.b.name ? 1 : -1;
  return { x: (f.a.x + f.b.x) / 2 - dy * 0.22 * side, y: (f.a.y + f.b.y) / 2 + dx * 0.22 * side };
}

function bez(a, c, b, t) {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function burst(x, y, name, n, speed) {
  if (REDUCED) return;
  for (let i = 0; i < n; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = rand(0.4, 2.2) * speed;
    S.particles.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: rand(500, 1100), size: rand(1, 3), name, drag: 0.985 });
  }
}

function arrive(f) {
  f.b.bump = 1.6;
  f.b.glow = 1.2;
  f.b.white = 0.5;
  f.b.lastRecv = Date.now();
  const failed = f.m.status === 'failed';
  const now = performance.now();
  S.ripples.push({ x: f.b.x, y: f.b.y, r0: f.b.r, t0: now, name: f.m.from.name, failed, big: true });
  S.ripples.push({ x: f.b.x, y: f.b.y, r0: f.b.r, t0: now + 140, name: f.m.from.name, failed });
  burst(f.b.x, f.b.y, f.m.from.name, 28, 2.4);
  const text = f.m.summary || f.m.body.split('\n')[0];
  S.bubbles.push({ node: f.b, text: text.slice(0, 40) + (text.length > 40 ? '…' : ''), t0: performance.now(), dur: 20000, name: f.m.from.name });
}

function delivered(m) {
  const b = S.nodes.get(m.to.name);
  if (!b) return;
  S.ripples.push({ x: b.x, y: b.y, r0: b.r, t0: performance.now(), name: m.from.name, thin: true });
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBackground(now) {
  const { w, h } = S;
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, '#0c1019');
  g.addColorStop(1, '#05070b');
  ctx.fillStyle = g;
  ctx.fillRect(-40, -40, w + 80, h + 80);

  if (!REDUCED) {
    const blobs = [
      { x: 0.25 + 0.08 * Math.sin(now / 9000), y: 0.35 + 0.1 * Math.cos(now / 11000), hue: 215, r: 0.5 },
      { x: 0.75 + 0.1 * Math.cos(now / 13000), y: 0.65 + 0.08 * Math.sin(now / 8000), hue: 285, r: 0.45 },
      { x: 0.55 + 0.12 * Math.sin(now / 15000 + 2), y: 0.2 + 0.06 * Math.cos(now / 10000 + 1), hue: 165, r: 0.4 },
    ];
    ctx.globalCompositeOperation = 'lighter';
    for (const b of blobs) {
      const bx = b.x * w, by = b.y * h, br = b.r * Math.min(w, h);
      const bg = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      bg.addColorStop(0, `hsla(${b.hue} 70% 45% / 0.07)`);
      bg.addColorStop(1, 'hsla(0 0% 0% / 0)');
      ctx.fillStyle = bg;
      ctx.fillRect(bx - br, by - br, br * 2, br * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  for (const s of S.stars) {
    if (!REDUCED) {
      s.y -= s.sp;
      if (s.y < -2) { s.y = h + 2; s.x = Math.random() * w; }
    }
    const tw = REDUCED ? 1 : 0.6 + 0.4 * Math.sin(now / 900 + s.ph);
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(200,210,235,${s.a * tw})`;
    ctx.fill();
  }
}

function updateNodes(now) {
  const rot = 0;
  for (const [name, n] of S.nodes) {
    const bob = REDUCED ? 0 : Math.sin(now / 1400 + n.phase) * 4;
    const a = n.angle0 + rot;
    n.tx = n.cx + n.R * Math.cos(a);
    n.ty = n.cy + n.R * Math.sin(a) + bob;
    n.x += (n.tx - n.x) * 0.1;
    n.y += (n.ty - n.y) * 0.1;
    const target = n.dying ? 0 : now > n.born ? 1 : 0;
    const k = 0.09, damp = 0.72;
    n.vscale = (n.vscale + (target - n.scale) * k) * damp;
    n.scale += n.vscale;
    if (n.dying && n.scale < 0.02 && Math.abs(n.vscale) < 0.01) { S.nodes.delete(name); layout(); }
    n.bump *= 0.9;
    n.glow *= 0.955;
    n.white = (n.white || 0) * 0.86;
  }
}

function drawEdges(now, wall) {
  const maxEdge = Math.max(1, ...[...S.pairs.values()].map(p => p.count));
  let activePairs = 0;
  let talkingPairs = 0;
  for (const [k, p] of S.pairs) {
    const [na, nb] = k.split('|');
    const a = S.nodes.get(na), b = S.nodes.get(nb);
    if (!a || !b || a.scale < 0.05 || b.scale < 0.05) continue;
    const age = wall - new Date(p.last);
    const active = age < ACTIVE_MS;
    const fade = active ? 1 - age / ACTIVE_MS : 0;
    const hl = S.hover && (S.hover === na || S.hover === nb);
    const weight = Math.log1p(p.count) / Math.log1p(maxEdge);
    const from = S.nodes.get(p.lastFrom) || a;
    const to = from === a ? b : a;

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = hl ? 'rgba(160,190,255,.5)' : `rgba(255,255,255,${0.04 + 0.12 * weight})`;
    ctx.lineWidth = 1 + 2.5 * weight;
    ctx.stroke();

    if (active) {
      activePairs++;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const grad = ctx.createLinearGradient(from.x, from.y, to.x, to.y);
      grad.addColorStop(0, color(from.name, 0.1 + 0.5 * fade));
      grad.addColorStop(1, color(from.name, 0.6 + 0.4 * fade));
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2 + 3 * fade;
      ctx.shadowColor = color(from.name);
      ctx.shadowBlur = 16 * fade;
      ctx.stroke();
      ctx.restore();
    }

    if (active) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const talking = (a.live && a.live.status === 'busy') || (b.live && b.live.status === 'busy');
      const label = talking ? `正在溝通 · ${ago(p.last)}` : `剛聊過 · ${ago(p.last)}`;
      if (talking) talkingPairs++;
      ctx.font = '600 11px -apple-system, system-ui';
      const tw = ctx.measureText(label).width + 18;
      const pulse = REDUCED ? 0 : 0.5 + 0.5 * Math.sin(now / 500);
      ctx.fillStyle = 'rgba(7,9,14,.85)';
      roundRect(mx - tw / 2, my - 11, tw, 22, 11);
      ctx.fill();
      ctx.strokeStyle = talking ? `rgba(245,181,68,${0.5 + 0.45 * pulse})` : 'rgba(255,255,255,.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = talking ? '#f5b544' : 'rgba(232,234,240,.75)';
      ctx.textAlign = 'center';
      ctx.fillText(label, mx, my + 4);
    }
  }
  const el = $('#modeLabel');
  el.textContent = talkingPairs ? `正在溝通 ${talkingPairs} 組` : '即時';
  el.classList.toggle('active', talkingPairs > 0);
}

function drawParticles(now, dt) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const keep = [];
  for (const p of S.particles) {
    {
      p.life += dt;
      if (p.life >= p.max) continue;
      p.x += p.vx * dt / 16;
      p.y += p.vy * dt / 16;
      p.vx *= p.drag;
      p.vy *= p.drag;
      const k = 1 - p.life / p.max;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * k, 0, Math.PI * 2);
      ctx.fillStyle = color(p.name, 0.9 * k);
      ctx.fill();
      keep.push(p);
    }
  }
  S.particles = keep.length > 900 ? keep.slice(keep.length - 900) : keep;
  ctx.restore();
}

function drawRipples(now) {
  S.ripples = S.ripples.filter(r => now - r.t0 < 1100);
  for (const r of S.ripples) {
    if (now < r.t0) continue;
    const p = (now - r.t0) / 1100;
    const e = easeOut(p);
    ctx.beginPath();
    ctx.arc(r.x, r.y, (r.r0 || 36) + e * (r.big ? 110 : 70), 0, Math.PI * 2);
    ctx.strokeStyle = r.failed ? `rgba(255,92,108,${1 - p})` : color(r.name, (1 - p) * (r.thin ? 0.5 : 0.9));
    ctx.lineWidth = (r.thin ? 1.5 : r.big ? 4 : 2.5) * (1 - p);
    ctx.stroke();
  }
}

function drawFlights(now) {
  for (const f of S.flights) {
    const p = Math.min(1, (now - f.t0) / f.dur);
    const c = flightCtrl(f);
    const pos = bez(f.a, c, f.b, easeInOut(p));
    f.trail.push(pos);
    if (f.trail.length > 30) f.trail.shift();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 1; i < f.trail.length; i++) {
      const k = i / f.trail.length;
      ctx.beginPath();
      ctx.moveTo(f.trail[i - 1].x, f.trail[i - 1].y);
      ctx.lineTo(f.trail[i].x, f.trail[i].y);
      ctx.strokeStyle = color(f.m.from.name, 0.05 + 0.6 * k);
      ctx.lineWidth = 1 + 8 * k;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    if (!REDUCED && p > 0.02 && p < 0.98) {
      const want = Math.floor(p * 40);
      while (f.emitted < want) {
        f.emitted++;
        S.particles.push({ x: pos.x, y: pos.y, vx: rand(-0.8, 0.8), vy: rand(-0.8, 0.8), life: 0, max: rand(300, 700), size: rand(0.8, 2), name: f.m.from.name, drag: 0.97 });
      }
    }
    const halo = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 28);
    halo.addColorStop(0, color(f.m.from.name, 0.7));
    halo.addColorStop(1, color(f.m.from.name, 0));
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 28, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = color(f.m.from.name);
    ctx.shadowBlur = 24;
    ctx.fill();
    ctx.shadowBlur = 0;

    const lab = f.m.summary;
    if (lab && p > 0.1 && p < 0.9) {
      const k = Math.min(1, (p - 0.1) / 0.12) * Math.min(1, (0.9 - p) / 0.12);
      ctx.globalAlpha = k;
      ctx.font = '12px -apple-system, system-ui';
      ctx.textAlign = 'center';
      const label = lab.slice(0, 26) + (lab.length > 26 ? '…' : '');
      const tw = ctx.measureText(label).width + 18;
      ctx.fillStyle = 'rgba(7,9,14,.88)';
      roundRect(pos.x - tw / 2, pos.y - 40 + (1 - k) * 8, tw, 24, 12);
      ctx.fill();
      ctx.strokeStyle = color(f.m.from.name, 0.6);
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#e8eaf0';
      ctx.fillText(label, pos.x, pos.y - 23 + (1 - k) * 8);
      ctx.globalAlpha = 1;
    }
    if (p >= 1) { f.done = true; arrive(f); }
  }
  S.flights = S.flights.filter(f => !f.done);
}

const fitCache = new Map();
function fitName(name) {
  if (fitCache.has(name)) return fitCache.get(name);
  const MAX_R = 50, MIN_R = 36;
  const measure = (t, size) => { ctx.font = `600 ${size}px -apple-system, system-ui`; return ctx.measureText(t).width; };
  let size = 14;
  let lines = [name];
  let w = measure(name, size);
  if (w / 2 + 16 > MAX_R) {
    const parts = name.split(/(?<=[-_ ])/);
    if (parts.length > 1) {
      let best = null;
      for (let i = 1; i < parts.length; i++) {
        const a = parts.slice(0, i).join('').trim(), b = parts.slice(i).join('').trim();
        const ww = Math.max(measure(a, size), measure(b, size));
        if (!best || ww < best.w) best = { w: ww, lines: [a, b] };
      }
      lines = best.lines;
      w = best.w;
    }
    while (w / 2 + 14 > MAX_R && size > 10) { size -= 1; w = Math.max(...lines.map(l => measure(l, size))); }
  }
  const r = Math.min(MAX_R, Math.max(MIN_R, w / 2 + 16, lines.length > 1 ? 44 : 0));
  const out = { r, size, lines };
  fitCache.set(name, out);
  return out;
}

function drawNodes(now, wall) {
  ctx.textAlign = 'center';
  for (const n of S.nodes.values()) {
    if (n.scale <= 0.01) continue;
    const sc = n.scale;
    const fit = fitName(n.name);
    const base = fit.r;
    n.r = base * sc;
    const r = (base + 7 * n.bump) * sc;
    const busy = n.live && n.live.status === 'busy';
    const selected = S.hover === n.name;

    ctx.save();
    ctx.translate(n.x, n.y);

    if (n.live) {
      const pulse = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(now / (busy ? 260 : 1100) + n.phase);
      ctx.beginPath();
      ctx.arc(0, 0, r + 7 + pulse * 5, 0, Math.PI * 2);
      ctx.strokeStyle = busy ? `rgba(245,181,68,${0.3 + 0.45 * pulse})` : `rgba(61,220,132,${0.22 + 0.3 * pulse})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      if (busy && !REDUCED) {
        ctx.save();
        ctx.rotate(now / 900);
        ctx.setLineDash([14, 10]);
        ctx.beginPath();
        ctx.arc(0, 0, r + 15, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(245,181,68,.45)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();
        for (let i = 0; i < 3; i++) {
          const a = now / 700 + n.phase + (i / 3) * Math.PI * 2;
          const rr = r + 15;
          const sx = Math.cos(a) * rr, sy = Math.sin(a) * rr * 0.55;
          ctx.beginPath();
          ctx.arc(sx, sy, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = '#ffd77a';
          ctx.shadowColor = '#f5b544';
          ctx.shadowBlur = 12;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
    }

    const glow = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.4);
    glow.addColorStop(0, color(n.name, 0.35 + 0.5 * n.glow));
    glow.addColorStop(1, color(n.name, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2);
    ctx.fill();

    const body = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
    body.addColorStop(0, color(n.name, 1, 68));
    body.addColorStop(1, color(n.name, 1, 40));
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = body;
    ctx.shadowColor = color(n.name);
    ctx.shadowBlur = 14 + 34 * n.glow + (selected ? 22 : 0);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (n.white > 0.02) {
      ctx.fillStyle = `rgba(255,255,255,${n.white * 0.85})`;
      ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.globalAlpha = Math.min(1, sc);
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${Math.round(fit.size * sc)}px -apple-system, system-ui`;
    ctx.shadowColor = 'rgba(0,0,0,.5)';
    ctx.shadowBlur = 4;
    const lh = fit.size * 1.25 * sc;
    fit.lines.forEach((line, i) => ctx.fillText(line, 0, (i - (fit.lines.length - 1) / 2) * lh + fit.size * 0.36 * sc));
    ctx.shadowBlur = 0;
    ctx.font = '12px -apple-system, system-ui';
    if (n.live) {
      const justGot = wall - n.lastRecv < ACTIVE_MS;
      ctx.fillStyle = busy ? '#f5b544' : '#3ddc84';
      ctx.fillText(busy ? (justGot ? '處理剛收到的訊息' : '工作中') : '閒置', 0, r + 30);
    }
    ctx.restore();
  }
}

function drawBubbles(now) {
  S.bubbles = S.bubbles.filter(b => now - b.t0 < b.dur);
  const perNode = new Map();
  for (const b of S.bubbles) {
    const p = (now - b.t0) / b.dur;
    const inK = Math.min(1, p / 0.08);
    const alpha = p < 0.08 ? easeOut(inK) : p > 0.82 ? (1 - p) / 0.18 : 1;
    const idx = perNode.get(b.node) || 0;
    perNode.set(b.node, idx + 1);
    ctx.font = '12px -apple-system, system-ui';
    const tw = ctx.measureText(b.text).width + 22;
    const x = Math.min(S.w - tw - 8, Math.max(8, b.node.x - tw / 2));
    const y = b.node.y - (b.node.r || 36) - 34 - idx * 32 - (1 - easeOut(inK)) * 14;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = 'rgba(18,22,32,.96)';
    ctx.strokeStyle = color(b.name, 0.9);
    ctx.lineWidth = 1.5;
    roundRect(x, y, tw, 26, 13);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8eaf0';
    ctx.textAlign = 'left';
    ctx.fillText(b.text, x + 11, y + 17);
    ctx.textAlign = 'center';
    ctx.globalAlpha = 1;
  }
}

let lastT = performance.now();
function draw(now) {
  const dt = Math.min(50, now - lastT);
  lastT = now;
  const wall = Date.now();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawBackground(now);
  updateNodes(now);

  if (!S.nodes.size) {
    ctx.fillStyle = 'rgba(125,133,154,.9)';
    ctx.font = '15px -apple-system, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('目前沒有在線的 session', S.w / 2, S.h / 2);
  } else {
    drawEdges(now, wall);
    drawParticles(now, dt);
    drawRipples(now);
    drawFlights(now);
    drawNodes(now, wall);
    drawBubbles(now);
  }

  if (cardNode) {
    if (!S.nodes.has(cardNode.name)) closeCard();
    else if ((S.frame & 3) === 0) placeCard();
  }
  if ((S.frame++ & 15) === 0) {
    $('#clock').textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false });
    $('#activity').textContent = S.lastActivity ? `上一則訊息：${ago(S.lastActivity)}` : '';
  }
  requestAnimationFrame(draw);
}

const card = $('#card');
let cardNode = null;
let cardTimer = null;

function sessionIdOf(name) {
  const s = (S.data && S.data.sessions || []).find(x => x.live && x.name === name);
  return s ? s.sessionId : null;
}

function escHtml(t) { return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function placeCard() {
  if (!cardNode) return;
  const n = cardNode;
  const cw = card.offsetWidth || 360, ch = card.offsetHeight || 200;
  const r = (n.r || 40) + 46;
  let x, y, ox, oy;
  if (n.y - r - ch >= 12) { x = n.x - cw / 2; y = n.y - r - ch; oy = '100%'; }
  else if (n.y + r + ch <= S.h - 12) { x = n.x - cw / 2; y = n.y + r; oy = '0%'; }
  else if (n.x + r + cw <= S.w - 12) { x = n.x + r; y = n.y - ch / 2; oy = '50%'; }
  else { x = n.x - r - cw; y = n.y - ch / 2; oy = '50%'; }
  x = Math.max(12, Math.min(S.w - cw - 12, x));
  y = Math.max(12, Math.min(S.h - ch - 12, y));
  card.style.left = x + 'px';
  card.style.top = y + 'px';
  card.style.setProperty('--ox', `${Math.max(0, Math.min(100, ((n.x - x) / cw) * 100))}%`);
  card.style.setProperty('--oy', oy);
}

async function refreshCard() {
  if (!cardNode) return;
  const n = cardNode;
  const id = sessionIdOf(n.name);
  const busy = n.live && n.live.status === 'busy';
  $('#cardName').textContent = n.name;
  $('#cardName').style.color = color(n.name, 1, 72);
  const st = $('#cardStatus');
  st.textContent = n.live ? (busy ? '工作中' : '閒置') : '已離線';
  st.className = 'card-status ' + (busy ? 'busy' : 'idle');
  if (!id) { $('#cardBody').innerHTML = '<div class="none">這個 session 已經不在線上，看不到它在做什麼。</div>'; placeCard(); return; }
  let a;
  try { a = await (await fetch(`/api/activity?session=${encodeURIComponent(id)}`, { cache: 'no-store' })).json(); } catch { return; }
  if (!cardNode || cardNode !== n) return;
  const secs = [];
  const sec = (lab, val, ts, cls = '') => secs.push(`<div class="sec" style="--i:${secs.length}"><div class="lab">${lab}${ts ? `<span class="when">${ago(ts)}</span>` : ''}</div><div class="val ${cls}">${escHtml(val)}</div></div>`);
  if (busy && a.runningTool) sec('正在做', a.runningTool.label, a.runningTool.ts, 'run');
  else if (a.lastTool) sec(busy ? '正在做' : '最後一個動作', a.lastTool.label, a.lastTool.ts, busy ? 'run' : '');
  if (a.lastText) sec(busy ? '剛剛說' : '最後說的話', a.lastText.text, a.lastText.ts);
  const src = [a.lastPrompt && { ...a.lastPrompt, lab: '使用者交代' }, a.lastIncoming && { ...a.lastIncoming, lab: `${a.lastIncoming.from} 傳來` }].filter(Boolean).sort((x, y) => new Date(y.ts) - new Date(x.ts))[0];
  if (src) sec(src.lab, src.text, src.ts);
  if (a.cwd) secs.push(`<div class="sec" style="--i:${secs.length}"><div class="lab">工作目錄</div><div class="cwd">${escHtml(a.cwd.replace(/^\/Users\/[^/]+/, '~'))}</div></div>`);
  $('#cardBody').innerHTML = secs.join('') || '<div class="none">還沒有任何活動紀錄。</div>';
  placeCard();
}

function openCard(n) {
  cardNode = n;
  card.hidden = false;
  card.style.animation = 'none';
  void card.offsetWidth;
  card.style.animation = '';
  refreshCard();
  clearInterval(cardTimer);
  cardTimer = setInterval(refreshCard, 3000);
}

function closeCard() {
  cardNode = null;
  card.hidden = true;
  clearInterval(cardTimer);
}

$('#cardClose').addEventListener('click', closeCard);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeCard(); });

let hoverTimer = null;
let overCard = false;
card.addEventListener('mouseenter', () => { overCard = true; clearTimeout(hoverTimer); });
card.addEventListener('mouseleave', () => { overCard = false; scheduleClose(); });
function scheduleClose() {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { if (!S.hover && !overCard) closeCard(); }, 350);
}
function onHoverChange(name) {
  if (name) {
    clearTimeout(hoverTimer);
    const n = S.nodes.get(name);
    if (cardNode !== n) openCard(n);
  } else if (cardNode) scheduleClose();
}
canvas.addEventListener('mouseleave', () => { S.hover = null; scheduleClose(); });

canvas.addEventListener('mousemove', e => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let hit = null;
  for (const n of S.nodes.values()) if (Math.hypot(n.x - x, n.y - y) < (n.r || 40) + 6) hit = n.name;
  const changed = hit !== S.hover;
  S.hover = hit;
  canvas.style.cursor = hit ? 'pointer' : 'default';
  if (changed) onHoverChange(hit);
});

async function load() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    S.data = await r.json();
    S.messages = S.data.messages.filter(m => m.from.name && m.to.name);
    rebuildNodes();
    const fresh = [], nowDelivered = [];
    for (const m of S.messages) {
      const prev = S.known.get(m.id);
      if (!prev) fresh.push(m);
      else if (prev !== 'delivered' && m.status === 'delivered') nowDelivered.push(m);
      S.known.set(m.id, m.status);
    }
    if (S.initialized) {
      const now = Date.now();
      const unique = fresh.filter(m => {
        const sig = `${m.from.name}|${m.to.name}|${String(m.body).replace(/\s+/g, ' ').trim()}`;
        const seen = S.firedSig.get(sig);
        S.firedSig.set(sig, now);
        return !(seen && now - seen < 120000);
      });
      for (const [sig, t] of S.firedSig) if (now - t > 600000) S.firedSig.delete(sig);
      unique.forEach((m, i) => setTimeout(() => fire(m), i * 700));
      nowDelivered.forEach(delivered);
    }
    S.initialized = true;
  } catch (e) { console.error(e); }
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('hello', () => $('#liveDot').classList.add('on'));
  es.addEventListener('change', load);
  es.onerror = () => $('#liveDot').classList.remove('on');
}

window.__nodes = () => [...S.nodes.values()].map(n => ({ name: n.name, x: n.x, y: n.y, r: n.r }));
window.__demo = (from, to) => {
  const names = [...S.nodes.keys()];
  from = from || names[0];
  to = to || names[1];
  fire({ id: 'demo-' + Date.now(), ts: new Date().toISOString(), from: { name: from }, to: { name: to }, summary: '示範訊息', body: '示範訊息', status: 'delivered' });
};

resize();
load();
connect();
setInterval(load, 5000);
requestAnimationFrame(draw);
