// Page change as a pixel curtain: squares cover the screen from the click point, the next page
// opens covered and the squares clear away. Plain navigation when motion is reduced.
import { palette, reducedMotion, seededValues } from './pixel-noise.js';

const KEY = 'pixel-wipe';
const CELL = 48;
const COVER_MS = 420;
const REVEAL_MS = 560;

function overlay() {
  const canvas = document.createElement('canvas');
  canvas.className = 'pixel-wipe';
  canvas.setAttribute('aria-hidden', 'true');
  const cols = Math.ceil(window.innerWidth / CELL);
  const rows = Math.ceil(window.innerHeight / CELL);
  canvas.width = cols;
  canvas.height = rows;
  document.body.append(canvas);
  const context = canvas.getContext('2d');
  const image = context.createImageData(cols, rows);
  const pixels = new Uint32Array(image.data.buffer);
  const noise = seededValues(cols * rows, 733);
  const colors = palette();
  return { canvas, context, image, pixels, noise, colors, cols, rows };
}

// Each cell gets an order from its distance to the origin plus noise, so the curtain spreads unevenly.
function orderFor(o, originX, originY) {
  const order = new Float32Array(o.cols * o.rows);
  const max = Math.hypot(o.cols, o.rows);
  for (let y = 0; y < o.rows; y += 1) {
    for (let x = 0; x < o.cols; x += 1) {
      const i = y * o.cols + x;
      order[i] = (Math.hypot(x - originX, y - originY) / max) * 0.65 + o.noise[i] * 0.35;
    }
  }
  return order;
}

function paint(o, order, progress, covering) {
  const { pixels, colors, noise } = o;
  for (let i = 0; i < pixels.length; i += 1) {
    const on = covering ? order[i] < progress : order[i] >= progress;
    const settled = covering ? order[i] < progress - 0.18 : order[i] >= progress + 0.18;
    // Cells near the moving edge are blue, settled ones turn into the page background.
    pixels[i] = on ? (settled ? colors[3] : colors[Math.floor(noise[i] * 3)]) : 0;
  }
  o.context.putImageData(o.image, 0, 0);
}

function run(o, order, duration, covering, done) {
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    paint(o, order, covering ? t * 1.2 : t * 1.2 - 0.2, covering);
    if (t < 1) requestAnimationFrame(step);
    else done();
  };
  requestAnimationFrame(step);
}

export function initTransitions() {
  if (sessionStorage.getItem(KEY)) {
    sessionStorage.removeItem(KEY);
    if (!reducedMotion()) {
      const o = overlay();
      const order = orderFor(o, o.cols / 2, o.rows / 2);
      paint(o, order, 1.2, true);
      run(o, order, REVEAL_MS, false, () => o.canvas.remove());
    }
  }

  // Coming back through history must never show a stuck curtain.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) document.querySelectorAll('.pixel-wipe').forEach((c) => c.remove());
  });

  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-transition]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (reducedMotion()) return;
    event.preventDefault();
    const o = overlay();
    const order = orderFor(o, event.clientX / CELL, event.clientY / CELL);
    sessionStorage.setItem(KEY, '1');
    run(o, order, COVER_MS, true, () => { window.location.href = link.href; });
  });
}
