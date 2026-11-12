// Background quadcopter that plans around page "boxes" with A* and follows the cursor.
// Desktop: chases the mouse. Touch devices: wanders between random waypoints.
// Flight modes: LANDED -> TAKEOFF -> FLY <-> RTL -> LANDING -> LANDED (ground station in the hero).
// Everything is in viewport (CSS pixel) coordinates on a fixed full-screen canvas. The planning
// grid covers the viewport plus wherever the drone is, so it can plan its way back from off-screen.
(function () {
  const gcsEl = document.getElementById("gcs");
  const padBtn = document.getElementById("pad-btn");
  const gcsMode = document.getElementById("gcs-mode");
  const toggleBtn = document.getElementById("drone-toggle");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return; // drone UI stays hidden

  // ---------------- config ----------------
  const OBSTACLES = ".nav, .card, .terminal, .btn, .post-content pre, .post-content img";
  const CELL = 12;            // planning grid cell size (px)
  const INFLATE = 26;         // obstacle padding = drone radius + margin (px)
  const PUSH = 24;            // hard keep-out radius: a box edge closer than this shoves the drone
  const REPLAN_MS = 100;      // replanning period
  const VMAX = 520;           // px/s
  const AMAX = 1500;          // px/s^2
  const K_VEL = 6;            // velocity-loop gain (1/s)
  const PX_PER_M = 100;       // telemetry scale: 100 px = 1 m
  const TRAIL_MS = 1600;      // flight-trail lifetime
  const OFF_PAD = 120;         // grid margin around an off-screen drone (px)
  const OFF_MAX = 8000;        // never let a waiting drone drift further than this off-screen
  const IDLE_RTL_MS = 8000;    // return to launch after this long without mouse movement
  const TAKEOFF_MS = 800, LANDING_MS = 900;
  const TOUCH = window.matchMedia("(hover: none), (pointer: coarse)").matches;

  // ---------------- canvas ----------------
  const cv = document.createElement("canvas");
  cv.id = "drone-canvas";
  cv.setAttribute("aria-hidden", "true");
  document.body.prepend(cv);
  const ctx = cv.getContext("2d");
  let W = 0, H = 0, DPR = 1, cols = 0, rows = 0, ox = 0, oy = 0, cap = 0, grid = new Uint8Array(0);

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // ---------------- theme colours ----------------
  let C = {};
  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    C = { green: v("--green"), cyan: v("--cyan"), amber: v("--amber"), text: v("--text"),
          muted: v("--muted"), panel: v("--panel"), border: v("--border"),
          light: document.documentElement.getAttribute("data-theme") === "light" };
  }
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------------- occupancy grid ----------------
  const obstacleEls = Array.from(document.querySelectorAll(OBSTACLES));
  // The sticky nav never moves relative to the screen, so it is only a planning obstacle while the
  // drone is on screen (an off-screen drone must be able to fly back in behind it) and it never pushes.
  const navEl = document.querySelector(".nav");
  // Grid region = viewport, grown (in 240 px steps, to avoid constant reallocation) to include the drone.
  function buildGrid() {
    const Q = 240;
    const on = (x, y) => x >= 0 && y >= 0 && x <= W && y <= H;
    const dOn = on(d.x, d.y), gOn = !goal || on(goal.x, goal.y);
    const onScreen = dOn && gOn;   // nav only blocks when the whole trip is on screen
    // only extend beyond the screen around whichever of drone / goal is off it
    let x0 = Math.min(0, dOn ? 0 : d.x - OFF_PAD, gOn ? 0 : goal.x - OFF_PAD);
    let x1 = Math.max(W, dOn ? W : d.x + OFF_PAD, gOn ? W : goal.x + OFF_PAD);
    let y0 = Math.min(0, dOn ? 0 : d.y - OFF_PAD, gOn ? 0 : goal.y - OFF_PAD);
    let y1 = Math.max(H, dOn ? H : d.y + OFF_PAD, gOn ? H : goal.y + OFF_PAD);
    x0 = x0 < 0 ? Math.floor(x0 / Q) * Q : 0; y0 = y0 < 0 ? Math.floor(y0 / Q) * Q : 0;
    x1 = x1 > W ? W + Math.ceil((x1 - W) / Q) * Q : W; y1 = y1 > H ? H + Math.ceil((y1 - H) / Q) * Q : H;
    ox = x0; oy = y0; cols = Math.ceil((x1 - x0) / CELL); rows = Math.ceil((y1 - y0) / CELL);
    const n = cols * rows;
    if (n > cap) buffers(n);
    grid.fill(0, 0, n); rects = []; labelRects = [];
    for (const el of obstacleEls) {
      const r = el.getBoundingClientRect();
      labelRects.push(r);
      if (el === navEl) { if (!onScreen) continue; } else rects.push(r);
      if (r.width === 0 || r.bottom < y0 - INFLATE || r.top > y1 + INFLATE || r.right < x0 - INFLATE || r.left > x1 + INFLATE) continue;
      const c0 = Math.max(0, Math.floor((r.left - INFLATE - ox) / CELL));
      const c1 = Math.min(cols - 1, Math.floor((r.right + INFLATE - ox) / CELL));
      const r0 = Math.max(0, Math.floor((r.top - INFLATE - oy) / CELL));
      const r1 = Math.min(rows - 1, Math.floor((r.bottom + INFLATE - oy) / CELL));
      for (let y = r0; y <= r1; y++) grid.fill(1, y * cols + c0, y * cols + c1 + 1);
    }
  }
  const cellOf = (x, y) => {
    const c = Math.min(cols - 1, Math.max(0, Math.floor((x - ox) / CELL)));
    const r = Math.min(rows - 1, Math.max(0, Math.floor((y - oy) / CELL)));
    return r * cols + c;
  };
  const centre = (i) => [ox + (i % cols + 0.5) * CELL, oy + (Math.floor(i / cols) + 0.5) * CELL];
  let rects = [], labelRects = [];
  const rawBlocked = (x, y) => labelRects.some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  const blockedAt = (x, y) => x < ox || y < oy || x >= ox + cols * CELL || y >= oy + rows * CELL || grid[cellOf(x, y)] === 1;

  // Boxes move when the page scrolls (the drone lives in screen space). If a box edge sweeps
  // into the drone's keep-out radius, shove the drone out to the nearest free spot and kill the
  // velocity component pointing into the box, so it looks pushed rather than overlapped.
  const inKeepOut = (x, y) => rects.some((r) => r.width > 0 &&
    x > r.left - PUSH && x < r.right + PUSH && y > r.top - PUSH && y < r.bottom + PUSH);
  // offscreenOK: a waiting drone may be shoved out of view instead of being squeezed along edges.
  function pushOut(offscreenOK) {
    if (!inKeepOut(d.x, d.y)) return false;
    let best = null, bd = Infinity;
    const consider = (x, y) => {
      if (!offscreenOK && (x < 12 || y < 12 || x > W - 12 || y > H - 12)) return;
      if (inKeepOut(x, y)) return;
      const dd = Math.hypot(x - d.x, y - d.y);
      if (dd < bd) { bd = dd; best = [x, y]; }
    };
    for (const r of rects) {
      if (!(r.width > 0 && d.x > r.left - PUSH && d.x < r.right + PUSH && d.y > r.top - PUSH && d.y < r.bottom + PUSH)) continue;
      const L = r.left - PUSH - 0.5, R = r.right + PUSH + 0.5, T = r.top - PUSH - 0.5, B = r.bottom + PUSH + 0.5;
      consider(L, d.y); consider(R, d.y); consider(d.x, T); consider(d.x, B);
      consider(L, T); consider(R, T); consider(L, B); consider(R, B);
    }
    if (!best) { const i = nearestFree(cellOf(d.x, d.y)); if (i < 0) return false; best = centre(i); bd = Math.hypot(best[0] - d.x, best[1] - d.y); }
    if (bd > 0) {
      const nx = (best[0] - d.x) / bd, ny = (best[1] - d.y) / bd, vn = d.vx * nx + d.vy * ny;
      if (vn < 0) { d.vx -= vn * nx; d.vy -= vn * ny; }
    }
    d.x = best[0]; d.y = best[1];
    return true;
  }

  // nearest free cell (BFS), used when the cursor or the drone sits inside an obstacle
  let bfsSeen = new Uint8Array(0), bfsQ = new Int32Array(0);
  function nearestFree(i) {
    if (grid[i] === 0) return i;
    bfsSeen.fill(0, 0, cols * rows);
    let h = 0, t = 0; bfsQ[t++] = i; bfsSeen[i] = 1;
    while (h < t) {
      const k = bfsQ[h++], x = k % cols, y = (k / cols) | 0;
      const nb = [k - 1, k + 1, k - cols, k + cols];
      const ok = [x > 0, x < cols - 1, y > 0, y < rows - 1];
      for (let j = 0; j < 4; j++) {
        if (!ok[j] || bfsSeen[nb[j]]) continue;
        if (grid[nb[j]] === 0) return nb[j];
        bfsSeen[nb[j]] = 1; bfsQ[t++] = nb[j];
      }
    }
    return -1;
  }

  // ---------------- A* (8-connected, octile, no corner cutting) ----------------
  let G = new Float32Array(0), F = new Float32Array(0), parent = new Int32Array(0), stamp = new Uint32Array(0), closed = new Uint32Array(0);
  let heap = new Int32Array(0), hn = 0, gen = 0;
  function buffers(n) {
    cap = n; grid = new Uint8Array(n);
    G = new Float32Array(n); F = new Float32Array(n); parent = new Int32Array(n);
    stamp = new Uint32Array(n); closed = new Uint32Array(n); heap = new Int32Array(n * 8);
    bfsSeen = new Uint8Array(n); bfsQ = new Int32Array(n); gen = 0;
  }
  function push(i) {
    let k = hn++; heap[k] = i;
    while (k > 0) { const p = (k - 1) >> 1; if (F[heap[p]] <= F[heap[k]]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  }
  function pop() {
    const top = heap[0]; heap[0] = heap[--hn]; let k = 0;
    for (;;) {
      const l = 2 * k + 1, r = l + 1; let m = k;
      if (l < hn && F[heap[l]] < F[heap[m]]) m = l;
      if (r < hn && F[heap[r]] < F[heap[m]]) m = r;
      if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m;
    }
    return top;
  }
  const SQ2 = Math.SQRT2;
  function astar(s, g) {
    gen++; hn = 0;
    const gx = g % cols, gy = (g / cols) | 0;
    const hfun = (i) => { const dx = Math.abs(i % cols - gx), dy = Math.abs(((i / cols) | 0) - gy); return dx + dy + (SQ2 - 2) * Math.min(dx, dy); };
    G[s] = 0; F[s] = hfun(s); parent[s] = -1; stamp[s] = gen; push(s);
    while (hn > 0) {
      const k = pop();
      if (closed[k] === gen) continue;
      closed[k] = gen;
      if (k === g) {
        const out = []; for (let i = g; i !== -1; i = parent[i]) out.push(i);
        return out.reverse();
      }
      const x = k % cols, y = (k / cols) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (grid[n] || closed[n] === gen) continue;
        if (dx && dy && (grid[y * cols + nx] || grid[ny * cols + x])) continue; // no corner cutting
        const ng = G[k] + (dx && dy ? SQ2 : 1);
        if (stamp[n] !== gen || ng < G[n]) {
          stamp[n] = gen; G[n] = ng; F[n] = ng + hfun(n); parent[n] = k; push(n);
        }
      }
    }
    return null;
  }

  // line of sight on the grid (sampled), then greedy string-pulling for any-angle paths
  function los(ax, ay, bx, by) {
    const d = Math.hypot(bx - ax, by - ay), n = Math.ceil(d / (CELL / 3));
    for (let i = 1; i <= n; i++) { const t = i / n; if (blockedAt(ax + (bx - ax) * t, ay + (by - ay) * t)) return false; }
    return true;
  }
  function smooth(pts) {
    if (pts.length <= 2) return pts;
    const out = [pts[0]]; let a = 0;
    while (a < pts.length - 1) {
      let b = a + 1;
      while (b + 1 < pts.length && los(pts[a][0], pts[a][1], pts[b + 1][0], pts[b + 1][1])) b++;
      out.push(pts[b]); a = b;
    }
    return out;
  }

  // ---------------- state ----------------
  const d = { x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, yaw: -Math.PI / 2, prop: 0 };
  let goal = null, path = [], status = "HOVER", trail = [], lastPlan = 0, wanderHold = 0, scrolled = false;
  let holdAfterPush = false;   // after being shoved, wait until the cursor is over free space again
  window.addEventListener("scroll", () => { scrolled = true; }, { passive: true });
  let lastSX = window.scrollX, lastSY = window.scrollY;
  const inView = () => d.x >= 0 && d.y >= 0 && d.x <= W && d.y <= H;
  const isWaiting = () => holdAfterPush && status === "WAIT";

  // flight mode + ground station
  let mode = "FLY", modeT = 0, alt = 1;
  let cursor = null, lastMoveT = performance.now(), wantFly = false;
  let manualHold = false;      // landed via a pad click: stay down until the pad is clicked again
  let wanderCount = 0;
  const padPt = () => {
    if (!padBtn || !gcsEl || gcsEl.hidden) return null;
    const r = padBtn.getBoundingClientRect();
    return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  };
  const MODE_TEXT = { LANDED: "LANDED", TAKEOFF: "TAKEOFF", FLY: "IN FLIGHT", RTL: "RTL", LANDING: "LANDING" };
  function setMode(m, t) {
    mode = m; modeT = t;
    if (gcsMode) gcsMode.textContent = MODE_TEXT[m] + (m === "LANDED" && manualHold ? " · click pad to launch" : "");
    if (padBtn) {
      const launch = m === "LANDED" && manualHold;
      const label = launch ? "Launch the drone" : "Return the drone to its launch pad (RTL)";
      padBtn.setAttribute("aria-label", label); padBtn.title = label;
    }
  }
  function startRTL(manual, t) {
    if (!padPt()) return;
    if (manual) manualHold = true;
    holdAfterPush = false; wantFly = false;
    if (mode === "FLY") setMode("RTL", t);
    // aborting a takeoff: descend from the current altitude without a jump
    else if (mode === "TAKEOFF") { setMode("LANDING", t); modeT = t - (1 - alt) * LANDING_MS; }
    else setMode(mode, modeT);   // refresh the readout / pad label
  }

  function spawn(t) {
    const p = padPt();
    d.vx = d.vy = d.ax = d.ay = 0; trail = []; path = []; holdAfterPush = false;
    if (p) { d.x = p.x; d.y = p.y; alt = 0; setMode("LANDED", t); return; }
    const i = nearestFree(cellOf(W * 0.85, H * 0.75));
    const [x, y] = i >= 0 ? centre(i) : [W / 2, H / 2];
    d.x = x; d.y = y; alt = 1; setMode("FLY", t);
  }

  function randomFreeGoal() {
    for (let k = 0; k < 60; k++) {
      const x = 40 + Math.random() * (W - 80), y = 80 + Math.random() * (H - 120);
      if (!blockedAt(x, y) && Math.hypot(x - d.x, y - d.y) > 160) return { x, y };
    }
    return null;
  }

  function plan() {
    if (!goal) { path = []; status = "HOVER"; return; }
    if (holdAfterPush) {
      if (grid[cellOf(goal.x, goal.y)]) { path = []; status = "WAIT"; return; }
      holdAfterPush = false;   // fly back from wherever it waited (the grid covers off-screen space)
    }
    const s = nearestFree(cellOf(d.x, d.y));
    const g = nearestFree(cellOf(goal.x, goal.y));
    if (s < 0 || g < 0) { path = []; status = "NO PATH"; return; }
    let gp = [goal.x, goal.y];
    if (grid[cellOf(goal.x, goal.y)]) gp = centre(g); // cursor is over a box: stop at its edge
    if (s === g) { path = [[d.x, d.y], gp]; status = Math.hypot(gp[0] - d.x, gp[1] - d.y) < 16 ? "HOVER" : "TRACK"; return; }
    const cells = astar(s, g);
    if (!cells) { path = []; status = "NO PATH"; return; }
    const pts = cells.map(centre);
    pts[0] = [d.x, d.y]; pts[pts.length - 1] = gp;
    path = smooth(pts);
    status = Math.hypot(gp[0] - d.x, gp[1] - d.y) < 16 ? "HOVER" : "TRACK";
  }

  // ---------------- input ----------------
  // Follow a real mouse whenever one moves (even on devices that start in wander mode).
  let wander = TOUCH;
  window.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    wander = false; cursor = { x: e.clientX, y: e.clientY }; lastMoveT = performance.now();
    if (!manualHold) wantFly = true;
  }, { passive: true });
  // cursor leaves the window -> return to launch
  document.addEventListener("mouseout", (e) => { if (!e.relatedTarget) startRTL(false, performance.now()); });
  if (padBtn) padBtn.addEventListener("click", () => {
    const t = performance.now();
    if (mode === "LANDED") {         // on the pad: the click toggles "stay landed" / "launch"
      manualHold = !manualHold; wantFly = !manualHold; setMode("LANDED", t);
    } else startRTL(true, t);
  });

  // ---------------- control + render loop ----------------
  let last = 0, raf = 0;
  function frame(t) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.033, last ? (t - last) / 1000 : 0.016); last = t;
    const p = padPt();
    const sdx = window.scrollX - lastSX, sdy = window.scrollY - lastSY;
    lastSX = window.scrollX; lastSY = window.scrollY;

    // ---- on the ground / vertical phases: the drone sits on the pad (which scrolls with the page)
    if (mode === "LANDED" || mode === "TAKEOFF" || mode === "LANDING") {
      if (!p) { alt = 1; setMode("FLY", t); }
      else {
        if (mode === "LANDED") {
          d.x = p.x; d.y = p.y; alt = 0;
          const go = !manualHold && (wantFly || (wander && t - modeT > 3000));
          wantFly = false;
          if (go) setMode("TAKEOFF", t);
        } else if (mode === "TAKEOFF") {
          d.x = p.x; d.y = p.y; alt = Math.min(1, (t - modeT) / TAKEOFF_MS);
          if (alt >= 1) { lastMoveT = performance.now(); wanderCount = 0; goal = null; setMode("FLY", t); }
        } else {
          const k = Math.min(1, (t - modeT) / LANDING_MS);
          d.x += (p.x - d.x) * Math.min(1, dt * 10); d.y += (p.y - d.y) * Math.min(1, dt * 10);
          alt = 1 - k;
          if (k >= 1) { d.x = p.x; d.y = p.y; setMode("LANDED", t); }
        }
        d.vx = d.vy = d.ax = d.ay = 0; path = []; status = mode; trail = [];
        d.prop += dt * (8 + 52 * alt);
        buildGrid();
        draw(t, 0, p);
        return;
      }
    }

    // ---- airborne: pick the goal for this mode
    if (mode === "RTL") {
      if (!p) setMode("FLY", t);
      else if (wantFly && !manualHold) setMode("FLY", t);   // mouse moved: cancel an automatic RTL
      else goal = { x: p.x, y: p.y };
    }
    wantFly = false;
    if (mode === "FLY") {
      if (wander) {
        if (status === "NO PATH" || status === "WAIT") { goal = null; holdAfterPush = false; }
        if (!goal || Math.hypot(goal.x - d.x, goal.y - d.y) < 24) {
          if (!wanderHold) wanderHold = t + 900 + Math.random() * 1200;
          if (t > wanderHold) {
            wanderHold = 0;
            if (goal) wanderCount++;
            if (wanderCount >= 3 && p) { startRTL(false, t); goal = { x: p.x, y: p.y }; }
            else goal = randomFreeGoal();
          }
        }
      } else {
        goal = cursor;
        if (p && performance.now() - lastMoveT > IDLE_RTL_MS) startRTL(false, t);
      }
    }

    buildGrid();                       // boxes may have moved (scroll, reveal animations)
    // While waiting, the drone sticks to the page: scrolling carries it with the content
    // (possibly out of view) instead of letting boxes shove it along their edges.
    if (isWaiting() && (sdx || sdy)) {
      d.x -= sdx; d.y -= sdy;
      for (const q of trail) { q.x -= sdx; q.y -= sdy; }   // the trail scrolls with it
      d.x = Math.min(W + OFF_MAX, Math.max(-OFF_MAX, d.x)); d.y = Math.min(H + OFF_MAX, Math.max(-OFF_MAX, d.y));
    }
    const pushNow = () => pushOut(true);   // a box may shove the drone off-screen; it plans its way back
    let shoved = pushNow();
    if (shoved) holdAfterPush = true;
    if (scrolled || shoved || t - lastPlan > REPLAN_MS) { plan(); lastPlan = t; scrolled = false; }

    // pick the furthest of the next few waypoints that is in line of sight
    let tx = d.x, ty = d.y, remaining = 0;
    if (path.length >= 2) {
      let j = 1;
      for (let k = Math.min(path.length - 1, 4); k > 1; k--) if (los(d.x, d.y, path[k][0], path[k][1])) { j = k; break; }
      tx = path[j][0]; ty = path[j][1];
      remaining = Math.hypot(tx - d.x, ty - d.y);
      for (let k = j; k < path.length - 1; k++) remaining += Math.hypot(path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]);
    }

    // velocity loop with a braking speed profile; slightly under-damped feel near the goal
    // far off-screen (invisible) the drone may fly up to 3x faster, easing to normal at the screen edge
    const out = Math.hypot(Math.max(-d.x, 0, d.x - W), Math.max(-d.y, 0, d.y - H));
    const boost = 1 + 2 * Math.min(1, out / 400), vmax = VMAX * boost, amax = AMAX * boost;
    const ex = tx - d.x, ey = ty - d.y, e = Math.hypot(ex, ey);
    const vdes = Math.min(vmax, Math.sqrt(2 * amax * 0.45 * remaining), remaining * 4.5);
    const vdx = e > 0.5 ? (ex / e) * vdes : 0, vdy = e > 0.5 ? (ey / e) * vdes : 0;
    let ax = K_VEL * (vdx - d.vx), ay = K_VEL * (vdy - d.vy);
    const am = Math.hypot(ax, ay); if (am > amax) { ax *= amax / am; ay *= amax / am; }
    // first-order lag on acceleration so the attitude (tilt) changes smoothly
    d.ax += (ax - d.ax) * Math.min(1, dt * 14); d.ay += (ay - d.ay) * Math.min(1, dt * 14);
    d.vx += d.ax * dt; d.vy += d.ay * dt;
    const wasInView = inView();
    d.x += d.vx * dt; d.y += d.vy * dt;
    // stay on screen while flying, unless waiting or heading home to an off-screen pad
    const homeOff = mode === "RTL" && p && (p.y < 0 || p.y > H || p.x < 0 || p.x > W);
    if (wasInView && !isWaiting() && !homeOff) {
      d.x = Math.min(W - 12, Math.max(12, d.x)); d.y = Math.min(H - 12, Math.max(12, d.y));
    }
    if (pushNow()) { shoved = true; holdAfterPush = true; }   // never end a frame inside a keep-out zone

    const speed = Math.hypot(d.vx, d.vy);
    if (speed > 40) {
      let dy = Math.atan2(d.vy, d.vx) - d.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      d.yaw += dy * Math.min(1, dt * 3);
    }
    d.prop += dt * 60;
    alt = 1;

    // touchdown: over the pad and slow enough
    if (mode === "RTL" && p && Math.hypot(p.x - d.x, p.y - d.y) < 10 && speed < 60) setMode("LANDING", t);

    trail.push({ x: d.x, y: d.y, t, brk: shoved });
    while (trail.length && t - trail[0].t > TRAIL_MS) trail.shift();

    draw(t, speed, p);
  }

  function drawPad(t, p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.globalAlpha = 0.55; ctx.strokeStyle = C.cyan; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, 26, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([3, 4]); ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(0, 0, 19, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.6; ctx.fillStyle = C.muted;
    ctx.font = '700 15px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("H", 0, 1);
    // landing lights: green when landed, blinking amber during takeoff / RTL / landing, dim in flight
    const busy = mode === "TAKEOFF" || mode === "RTL" || mode === "LANDING";
    const on = !busy || Math.floor(t / 250) % 2 === 0;
    ctx.fillStyle = mode === "LANDED" ? C.green : busy ? C.amber : C.muted;
    ctx.globalAlpha = mode === "FLY" ? 0.35 : on ? 0.95 : 0.2;
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + k * Math.PI / 2;
      ctx.beginPath(); ctx.arc(Math.cos(a) * 31, Math.sin(a) * 31, 2.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function draw(t, speed, p) {
    ctx.clearRect(0, 0, W, H);
    if (p) drawPad(t, p);
    const airborne = mode === "FLY" || mode === "RTL";
    const bob = airborne && speed < 30 ? Math.sin(t / 420) * 1.5 : 0;
    const px = d.x, py = d.y + bob;

    // planned path (faint dotted)
    if (airborne && path.length >= 2 && status === "TRACK") {
      ctx.save();
      ctx.setLineDash([2, 6]); ctx.lineWidth = 1.2; ctx.strokeStyle = C.cyan; ctx.globalAlpha = 0.35;
      ctx.beginPath(); ctx.moveTo(px, py);
      for (let k = 1; k < path.length; k++) ctx.lineTo(path[k][0], path[k][1]);
      ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 0.5;
      const [gx, gy] = path[path.length - 1];
      ctx.beginPath(); ctx.arc(gx, gy, 4, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    // flight trail (fading)
    ctx.save(); ctx.lineWidth = 1.6; ctx.strokeStyle = C.green;
    for (let k = 1; k < trail.length; k++) {
      if (trail[k].brk) continue;   // no segment across a push
      ctx.globalAlpha = 0.35 * (1 - (t - trail[k].t) / TRAIL_MS);
      ctx.beginPath(); ctx.moveTo(trail[k - 1].x, trail[k - 1].y); ctx.lineTo(trail[k].x, trail[k].y); ctx.stroke();
    }
    ctx.restore();

    // altitude: shadow separates and the drone grows slightly as it climbs
    const sc = 0.72 + 0.28 * alt;
    if (alt > 0.02) {
      ctx.save(); ctx.globalAlpha = (C.light ? 0.12 : 0.35) * Math.min(1, alt * 3); ctx.fillStyle = "#000";
      ctx.beginPath(); ctx.ellipse(px + 7 * alt, py + 10 * alt, 16 * sc, 14 * sc, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // drone: tilt = foreshortening along the acceleration direction
    const am = Math.hypot(d.ax, d.ay), tilt = Math.min(0.5, am / AMAX * 0.5);
    const tdir = Math.atan2(d.ay, d.ax);
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(sc, sc);
    ctx.rotate(tdir); ctx.scale(1 - tilt * 0.45, 1); ctx.rotate(-tdir);
    ctx.rotate(d.yaw);
    ctx.globalAlpha = C.light ? 0.75 : 0.8;
    ctx.shadowColor = C.green; ctx.shadowBlur = C.light ? 0 : 8;
    ctx.strokeStyle = C.green; ctx.lineWidth = 2;
    const L = 15, R = 7.5;
    const arms = [Math.PI / 4, 3 * Math.PI / 4, 5 * Math.PI / 4, 7 * Math.PI / 4];
    ctx.beginPath();
    for (const a of arms) { ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * L, Math.sin(a) * L); }
    ctx.stroke();
    ctx.lineWidth = 1.2;
    arms.forEach((a, i) => {
      const mx = Math.cos(a) * L, my = Math.sin(a) * L;
      ctx.globalAlpha = 0.18; ctx.fillStyle = C.cyan;
      ctx.beginPath(); ctx.arc(mx, my, R, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.8; ctx.strokeStyle = C.cyan;
      const sp = d.prop * (i % 2 ? 1 : -1);
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(sp) * R, my + Math.sin(sp) * R);
      ctx.lineTo(mx - Math.cos(sp) * R, my - Math.sin(sp) * R);
      ctx.stroke();
    });
    ctx.shadowBlur = 0; ctx.globalAlpha = 0.95;
    ctx.fillStyle = C.panel; ctx.strokeStyle = C.green; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.rect(-5, -4, 10, 8); ctx.fill(); ctx.stroke();
    // nose LED (front) + blinking nav LED
    ctx.fillStyle = C.green; ctx.beginPath(); ctx.arc(6.5, 0, 1.6, 0, Math.PI * 2); ctx.fill();
    if (Math.floor(t / 500) % 2 === 0) { ctx.fillStyle = "#ff4d4d"; ctx.beginPath(); ctx.arc(-6.5, 0, 1.6, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();

    // telemetry label (hidden while parked on the pad)
    if (mode === "LANDED") return;
    const v = (speed / PX_PER_M).toFixed(1);
    const psi = String(Math.round(((d.yaw * 180 / Math.PI) + 90 + 360) % 360)).padStart(3, "0");
    const l1 = `v ${v} m/s · ψ ${psi}°`;
    const wp = `A* ${Math.max(0, path.length - 1)} wp`;
    const l2 = !airborne ? mode : mode === "RTL" ? (status === "TRACK" ? `RTL · ${wp}` : `RTL · ${status}`) : status === "TRACK" ? wp : status;
    ctx.save();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    const w = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 10;
    // place the label in the first corner that is on-screen and not over a box
    const spots = [[px + 24, py - 34], [px - 24 - w, py - 34], [px + 24, py + 10], [px - 24 - w, py + 10]];
    const free = ([x, y]) => x > 4 && y > 4 && x + w < W - 4 && y + 28 < H - 4 &&
      ![[x, y], [x + w, y], [x, y + 28], [x + w, y + 28], [x + w / 2, y + 14]].some(([a, b]) => rawBlocked(a, b));
    let [lx, ly] = spots.find(free) || spots[0];
    ctx.globalAlpha = 0.7; ctx.fillStyle = C.panel; ctx.strokeStyle = C.border;
    ctx.beginPath(); ctx.rect(lx, ly, w, 28); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = C.muted; ctx.fillText(l1, lx + 5, ly + 11);
    ctx.fillStyle = status === "NO PATH" || status === "WAIT" || mode !== "FLY" ? C.amber : C.green; ctx.fillText(l2, lx + 5, ly + 23);
    ctx.restore();
  }

  // ---------------- lifecycle + on/off toggle ----------------
  function start() { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } }
  function stop() { cancelAnimationFrame(raf); raf = 0; }
  let enabled = true;
  try { enabled = localStorage.getItem("drone") !== "off"; } catch (e) {}
  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem("drone", on ? "on" : "off"); } catch (e) {}
    cv.hidden = !on;
    if (gcsEl) gcsEl.hidden = !on;
    if (toggleBtn) {
      toggleBtn.textContent = on ? "[drone: on]" : "[drone: off]";
      toggleBtn.setAttribute("aria-pressed", String(on));
      toggleBtn.setAttribute("aria-label", on ? "Turn the background drone off" : "Turn the background drone on");
    }
    if (on) { manualHold = false; wantFly = false; buildGrid(); spawn(performance.now()); start(); }
    else { stop(); ctx.clearRect(0, 0, W, H); }
  }
  if (toggleBtn) {
    toggleBtn.closest("li").hidden = false;
    toggleBtn.addEventListener("click", () => setEnabled(!enabled));
  }
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : enabled && start()));
  window.addEventListener("resize", () => { resize(); buildGrid(); plan(); });

  readColors(); resize();
  setEnabled(enabled);
})();
