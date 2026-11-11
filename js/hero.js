// Hero scene, driven by scroll: mosaic and headline break into pixels, one small tile remains,
// then the words return around it. Canvases are tiny and scaled up with crisp pixels.
const THRESHOLDS = [0.7, 0.9, 1.08];
const CHECKER = [-0.375, 0.125, 0.375, -0.125];
// A 4×4 ordered dither spreads each colour change over many small steps, so cloud edges glide instead of popping.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => v / 16 - 0.47);
const DITHER_STRENGTH = 0.16;
const HOLE_CLEAR = 0.72;
const MIN_SCRUB_HEIGHT = 640;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const overshoot = (t) => 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2;

function seededValues(size, seed = 41) {
  let state = seed;
  return Float32Array.from({ length: size }, () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  });
}

const LATTICE = seededValues(256);
const STIR = Uint8Array.from(seededValues(256), (v) => Math.floor(v * 256));

function valueNoise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = x - xi;
  const v = y - yi;
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const at = (i, j) => LATTICE[(STIR[i & 255] + j) & 255];
  const top = at(xi, yi) + su * (at(xi + 1, yi) - at(xi, yi));
  const bottom = at(xi, yi + 1) + su * (at(xi + 1, yi + 1) - at(xi, yi + 1));
  return top + sv * (bottom - top);
}

const clouds = (x, y) => valueNoise(x, y) * 0.68 + valueNoise(x * 2.1 + 7, y * 2.1 + 3) * 0.32;

function packColor(cssColor) {
  const hex = cssColor.trim().replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

let snapshot = () => '';

// A full, undissolved mosaic frame for the "How I design" backdrop.
export const mosaicSnapshot = () => snapshot();

export function initHero() {
  const canvas = document.querySelector('.hero-texture');
  if (!canvas) return;

  const stage = document.querySelector('.hero-stage');
  const pin = document.querySelector('.hero-pin');
  const hero = document.querySelector('.hero');
  const header = document.querySelector('.site-header');
  const page = document.querySelector('.page');
  const ring = document.querySelector('.hero-ring');
  const title = hero.querySelector('h1');
  const eraser = hero.querySelector('.hero-erase');
  const tile = hero.querySelector('.hero-tile');
  const textBlocks = [...hero.querySelectorAll('h1, .lead, .hero-actions')];
  const context = canvas.getContext('2d');
  const eraserContext = eraser.getContext('2d');
  const tileContext = tile.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const wide = window.matchMedia('(min-width: 768px)');

  const styles = getComputedStyle(document.documentElement);
  const read = (name) => packColor(styles.getPropertyValue(name));
  const colors = [read('--texture-light'), read('--texture-mid'), read('--accent')];
  const background = read('--bg');

  ring.hidden = false;

  const tileImage = tileContext.createImageData(tile.width, tile.height);
  const tilePixels = new Uint32Array(tileImage.data.buffer);
  const tileScatter = seededValues(tile.width * tile.height, 977);

  const state = {
    cell: 12, cols: 0, rows: 0, coarseCols: 0, coarseRows: 0,
    width: 0, height: 0, left: 0, rail: 0, ringSize: 0, holeRadius: 0, reach: 110,
    box: { cx: 0, cy: 0, hw: 0, hh: 0, left: 0, right: 0, top: 0, bottom: 0 },
    home: { x: 0, y: 0 }, target: null, pos: null,
    time: 0, last: 0, running: false, raf: 0, inView: true, scrub: false,
    progress: 0, slot: false, tileDelta: 0,
    image: null, pixels: null, coarse: null, scatter: null, falloff: null,
    eraserImage: null, eraserPixels: null, eraserScatter: null, lastErase: -1, lastDissolve: -1,
  };

  function measure() {
    state.scrub = !reduceMotion.matches && window.innerHeight >= MIN_SCRUB_HEIGHT;
    stage.classList.toggle('is-scrub', state.scrub);
    document.documentElement.style.setProperty('--site-header', `${header.offsetHeight}px`);

    const pinRect = pin.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const height = pinRect.height;
    canvas.style.left = `${-pinRect.left}px`;
    canvas.style.width = `${width}px`;

    state.left = pinRect.left;
    state.rail = wide.matches ? page.getBoundingClientRect().left : 0;
    state.width = width;
    state.height = height;
    state.cell = wide.matches ? 12 : 8;
    // A hidden or collapsed view can measure zero; canvases still need at least one pixel.
    state.cols = Math.max(1, Math.ceil(width / state.cell));
    state.rows = Math.max(1, Math.ceil(height / state.cell));
    state.coarseCols = Math.ceil(state.cols / 2);
    state.coarseRows = Math.ceil(state.rows / 2);

    canvas.width = state.cols;
    canvas.height = state.rows;
    state.image = context.createImageData(state.cols, state.rows);
    state.pixels = new Uint32Array(state.image.data.buffer);
    state.coarse = new Float32Array(state.coarseCols * state.coarseRows);
    state.scatter = seededValues(state.cols * state.rows);

    const rects = textBlocks.map((block) => block.getBoundingClientRect());
    const pad = wide.matches ? 44 : 14;
    const left = Math.min(...rects.map((r) => r.left)) - pad;
    const right = Math.max(...rects.map((r) => r.right)) + pad;
    const boxTop = Math.min(...rects.map((r) => r.top)) - pinRect.top - pad;
    const boxBottom = Math.max(...rects.map((r) => r.bottom)) - pinRect.top + pad;
    state.box = { left, right, top: boxTop, bottom: boxBottom, cx: (left + right) / 2, cy: (boxTop + boxBottom) / 2, hw: (right - left) / 2, hh: (boxBottom - boxTop) / 2 };
    // Narrow or short windows leave little room around the text, so the mosaic edge tightens to stay visible.
    state.reach = Math.min(110, Math.max(36, Math.max(left - state.rail, boxTop) * 0.45));

    // Far pixels go first, so the mosaic collapses toward the center.
    state.falloff = new Float32Array(state.cols * state.rows);
    for (let y = 0; y < state.rows; y += 1) {
      for (let x = 0; x < state.cols; x += 1) {
        const dx = ((x + 0.5) * state.cell - width / 2) / (width / 2);
        const dy = ((y + 0.5) * state.cell - height / 2) / (height / 2);
        state.falloff[y * state.cols + x] = 1 - Math.min(1, Math.hypot(dx, dy) / 1.414);
      }
    }

    const titleRect = title.getBoundingClientRect();
    const eraserCell = wide.matches ? 10 : 7;
    const eraserCols = Math.max(1, Math.ceil((titleRect.width + 24) / eraserCell));
    const eraserRows = Math.max(1, Math.ceil((titleRect.height + 24) / eraserCell));
    if (eraser.width !== eraserCols || eraser.height !== eraserRows || !state.eraserImage) {
      eraser.width = eraserCols;
      eraser.height = eraserRows;
      state.eraserImage = eraserContext.createImageData(eraserCols, eraserRows);
      state.eraserPixels = new Uint32Array(state.eraserImage.data.buffer);
      state.eraserScatter = seededValues(eraserCols * eraserRows, 311);
      state.lastErase = -1;
    }

    state.ringSize = ring.offsetWidth;
    state.holeRadius = state.ringSize * 0.68;

    const radius = state.ringSize / 2;
    const homeX = wide.matches ? width - radius * 1.5 : width / 2;
    const lowest = height - radius - (wide.matches ? 40 : 64);
    const clearOfText = rects
      .filter((r) => r.left < homeX + radius && r.right > homeX - radius)
      .map((r) => r.bottom - pinRect.top + radius + 8);
    // On phones the ring stays right below the button.
    state.home = { x: homeX, y: wide.matches ? Math.max(lowest, ...clearOfText) : Math.max(...clearOfText) };
    state.pos = state.target && state.pos ? state.pos : { ...state.home };
    state.lastDissolve = -1;
    measureTile();
    applyScene();
  }

  // How far the tile must shift to stand alone in the middle of the headline's line.
  function measureTile() {
    const previous = tile.style.transform;
    tile.style.transform = 'none';
    const tileRect = tile.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    state.tileDelta = titleRect.left + titleRect.width / 2 - (tileRect.left + tileRect.width / 2);
    tile.style.transform = previous;
  }

  function draw(dissolve) {
    const { cell, cols, rows, coarseCols, coarseRows, coarse, pixels, scatter, falloff, box, height, reach, time, holeRadius, pos } = state;
    const coarseSize = cell * 2;
    const reveal = reduceMotion.matches ? 1 : smoothstep(0, 2.2, time);

    for (let j = 0; j < coarseRows; j += 1) {
      const py = (j + 0.5) * coarseSize;
      for (let i = 0; i < coarseCols; i += 1) {
        const px = (i + 0.5) * coarseSize;
        const n = clouds(px * 0.0052 + time * 0.032, py * 0.0078 - time * 0.02);
        // Rounded box around the text, its border torn by a faster noise so it reads as a cloud edge.
        const corner = Math.min(box.hh, 130);
        const qx = Math.abs(px - box.cx) - box.hw + corner;
        const qy = Math.abs(py - box.cy) - box.hh + corner;
        const distance = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
        const tear = (valueNoise(px * 0.013 - time * 0.018, py * 0.016 + time * 0.012) - 0.5) * reach * 1.5;
        const edge = smoothstep(0, reach, distance - n * (reach * 0.8) + tear);
        const bottomFade = smoothstep(0, Math.min(150, height * 0.16), height - py + tear);
        coarse[j * coarseCols + i] = edge * bottomFade * reveal * (0.62 + n * 0.8);
      }
    }

    const holeX = pos.x;
    const holeY = pos.y;
    const clear = holeRadius * HOLE_CLEAR;
    const hole2 = holeRadius * holeRadius;

    for (let y = 0; y < rows; y += 1) {
      // Coarse values are blended between neighbours, so shapes move by one small pixel at a time.
      const gy = Math.min(coarseRows - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(gy);
      const y1 = Math.min(coarseRows - 1, y0 + 1);
      const fy = gy - y0;
      const pixelY = (y + 0.5) * cell - holeY;
      for (let x = 0; x < cols; x += 1) {
        const index = y * cols + x;
        const gx = Math.min(coarseCols - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(gx);
        const x1 = Math.min(coarseCols - 1, x0 + 1);
        const fx = gx - x0;
        const top = coarse[y0 * coarseCols + x0] + (coarse[y0 * coarseCols + x1] - coarse[y0 * coarseCols + x0]) * fx;
        const bottom = coarse[y1 * coarseCols + x0] + (coarse[y1 * coarseCols + x1] - coarse[y1 * coarseCols + x0]) * fx;
        let value = top + (bottom - top) * fy;
        if (value > 0) {
          const pixelX = (x + 0.5) * cell - holeX;
          const d2 = pixelX * pixelX + pixelY * pixelY;
          if (d2 < hole2) {
            const dist = Math.sqrt(d2);
            value = dist < clear ? 0 : value - (1 - smoothstep(clear, holeRadius, dist)) * (0.6 + scatter[index] * 1.1);
          }
          if (dissolve > 0 && scatter[index] * 0.55 + falloff[index] * 0.45 < dissolve * 1.02) value = 0;
        }
        const checked = value + BAYER[((y & 3) << 2) | (x & 3)] * DITHER_STRENGTH;
        let color = 0;
        if (value > 0) {
          if (checked >= THRESHOLDS[2]) color = colors[2];
          else if (checked >= THRESHOLDS[1]) color = colors[1];
          else if (checked >= THRESHOLDS[0]) color = colors[0];
        }
        pixels[index] = color;
      }
    }
    context.putImageData(state.image, 0, 0);
  }

  // Background-colored squares that eat the headline; a thin accent band runs along the frontier.
  function drawEraser(amount, seedShift) {
    const atRest = amount === 0 || amount === 1;
    if (amount === state.lastErase || (!atRest && Math.abs(amount - state.lastErase) < 0.002)) return;
    state.lastErase = amount;
    const { eraserPixels, eraserScatter } = state;
    const total = eraserPixels.length;
    for (let i = 0; i < total; i += 1) {
      const value = eraserScatter[(i + seedShift) % total];
      let color = 0;
      if (amount > 0 && value < amount * 1.08) color = background;
      else if (amount > 0 && value < amount * 1.08 + 0.05) color = colors[2];
      eraserPixels[i] = color;
    }
    eraserContext.putImageData(state.eraserImage, 0, 0);
  }

  function drawTile(grow) {
    const { width, height } = tile;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (tileScatter[index] > grow * 1.05) {
          tilePixels[index] = 0;
          continue;
        }
        const n = clouds(x * 0.17 + state.time * 0.28, y * 0.2 - state.time * 0.18);
        const checked = n + CHECKER[((y & 1) << 1) | (x & 1)] * 0.06;
        tilePixels[index] = checked > 0.56 ? colors[2] : checked > 0.42 ? colors[1] : colors[0];
      }
    }
    tileContext.putImageData(tileImage, 0, 0);
  }

  // Maps scroll progress onto the five beats of the scene.
  function applyScene() {
    const p = state.progress;
    // Linear on purpose: bands of mosaic must still be there when the tile appears.
    const dissolve = clamp01((p - 0.02) / 0.4) * 0.84;
    const firstWords = smoothstep(0.06, 0.3, p);
    const lastWords = smoothstep(0.5, 0.82, p);
    const grow = smoothstep(0.24, 0.38, p);

    const slot = p >= 0.34;
    if (slot !== state.slot) {
      state.slot = slot;
      title.classList.toggle('has-tile', slot);
      measureTile();
    }

    ring.style.opacity = String(1 - smoothstep(0.02, 0.16, p));
    placeRing();

    if (dissolve < 0.84 || state.lastDissolve < 0.84) draw(dissolve);
    state.lastDissolve = dissolve;

    if (p < 0.4) drawEraser(firstWords, 0);
    else drawEraser(1 - lastWords, 37);

    tile.style.opacity = grow > 0 ? '1' : '0';
    if (grow > 0) {
      const slide = state.tileDelta * (1 - smoothstep(0.5, 0.72, p));
      tile.style.transform = `translateX(${slide}px) scale(${overshoot(grow)})`;
      drawTile(grow);
    }
  }

  function placeRing() {
    const half = state.ringSize / 2;
    ring.style.transform = `translate3d(${state.pos.x - state.left - half}px, ${state.pos.y - half}px, 0)`;
  }

  function scrollProgress() {
    if (!state.scrub) return 0;
    const rect = stage.getBoundingClientRect();
    return clamp01(-rect.top / Math.max(1, rect.height - pin.offsetHeight));
  }

  function frame(now) {
    state.raf = requestAnimationFrame(frame);
    // Until the first successful measure there is nothing to move.
    if (!state.pos) return;
    // A generous cap: on a slow start the mosaic should still appear on time.
    state.time += Math.min((now - state.last) / 1000, 0.25);
    state.last = now;
    const goal = state.target ?? state.home;
    state.pos.x += (goal.x - state.pos.x) * 0.08;
    state.pos.y += (goal.y - state.pos.y) * 0.08;
    state.progress += (scrollProgress() - state.progress) * 0.09;
    applyScene();
  }

  function sync() {
    const run = !reduceMotion.matches && !document.hidden && state.inView;
    if (run === state.running) return;
    state.running = run;
    ring.classList.toggle('is-paused', !run);
    if (run) {
      state.last = performance.now();
      state.raf = requestAnimationFrame(frame);
    } else {
      cancelAnimationFrame(state.raf);
    }
  }

  snapshot = () => {
    const held = state.progress;
    state.progress = 0;
    draw(0);
    const url = canvas.toDataURL();
    state.progress = held;
    state.lastDissolve = -1;
    return url;
  };

  window.addEventListener('pointermove', (event) => {
    if (event.pointerType !== 'mouse' || reduceMotion.matches) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // The ring stays out of the header so it never covers navigation.
    const onTexture = y >= header.offsetHeight && y <= state.height;
    const overText = x > state.box.left && x < state.box.right && y > state.box.top && y < state.box.bottom;
    state.target = onTexture && !overText ? { x, y } : null;
  }, { passive: true });

  document.documentElement.addEventListener('pointerleave', () => { state.target = null; });
  document.addEventListener('visibilitychange', sync);
  reduceMotion.addEventListener('change', () => {
    state.target = null;
    state.progress = 0;
    measure();
    state.pos = { ...state.home };
    sync();
  });

  new IntersectionObserver(([entry]) => {
    state.inView = entry.isIntersecting;
    sync();
  }).observe(canvas);

  if (reduceMotion.matches) state.time = 12;
  measure();
  const resize = new ResizeObserver(() => measure());
  [hero, pin, ...textBlocks].forEach((element) => resize.observe(element));
  document.fonts.ready.then(measure);
  sync();

  // Some embedded or unfocused views deliver no animation frames until touched: never leave the hero empty.
  setTimeout(() => {
    if (state.time > 0) return;
    state.time = 2;
    applyScene();
  }, 400);
}
