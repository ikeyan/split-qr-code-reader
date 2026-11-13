import { Byte, Encoder } from "@nuintun/qrcode";
import { createStructuredAppend } from "@kubohiroya/qrcode-structured-append";
import type { Raster } from "../src/image-enhance.ts";

/** Seeded fixture renderer. No dependency on the reader's curvature model.
 * A textured cylinder is rotated in 3D and perspective projected, then rasterized
 * as triangles with perspective-correct texture coordinates at 2x resolution.
 */
export function curvedPaper(seed: number, index: number) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const range = (a: number, b: number) => a + (b - a) * random();
  const version = [3, 5, 7, 9][index % 4], level = index % 3 === 0 ? "L" : "M";
  const text = `https://qr.test/${seed}/` +
    Array.from(
      { length: version * 4 },
      () => Math.floor(random() * 36).toString(36),
    ).join("");
  const structured = Math.floor(index / 4) % 2 === 1;
  const symbol = structured
    ? createStructuredAppend(new TextEncoder().encode(text.repeat(2)), {
      maxVersion: version,
      level,
    })[0]
    : undefined;
  const normal = symbol
    ? undefined
    : new Encoder({ version, level }).encode(new Byte(text));
  const size = symbol?.size ?? normal!.size;
  const dark = (x: number, y: number) =>
    symbol ? symbol.isDark(x, y) : normal!.get(x, y) === 1;
  const expected = symbol?.bytes ?? new TextEncoder().encode(text);
  const width = 600, height = 700, ss = 2, w = width * ss, h = height * ss;
  const pixels = new Float32Array(w * h);
  pixels.fill(225);
  // Receipt text-like clutter outside the code, and a dark surrounding surface.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < 70 * ss || x > 545 * ss) pixels[y * w + x] = 45;
      else if (
        y < 180 * ss && y % (16 * ss) < 7 * ss && x % (13 * ss) < 9 * ss
      ) pixels[y * w + x] = 90;
    }
  }
  const angle = range(.65, 1.2) * (Math.floor(index / 16) % 2 === 0 ? 1 : -1),
    vertical = Math.floor(index / 8) % 2 === 0;
  const yaw = range(-.22, .22),
    pitch = range(-.22, .22),
    roll = range(-.35, .35),
    distance = range(3.5, 5);
  const scale = range(145, 185) * ss,
    cx = range(285, 320) * ss,
    cy = range(405, 440) * ss;
  const project = (u: number, v: number) => {
    const t = vertical ? v : u, cross = vertical ? u : v;
    const bent = Math.sin(angle * t) / angle,
      z = (1 - Math.cos(angle * t)) / angle;
    const x = vertical ? cross : bent, y = vertical ? bent : cross;
    const xx = Math.cos(yaw) * x + Math.sin(yaw) * z,
      zz = -Math.sin(yaw) * x + Math.cos(yaw) * z;
    const yy = Math.cos(pitch) * y - Math.sin(pitch) * zz,
      depth = distance + Math.sin(pitch) * y + Math.cos(pitch) * zz;
    return {
      x: cx +
        scale * distance * (Math.cos(roll) * xx - Math.sin(roll) * yy) / depth,
      y: cy +
        scale * distance * (Math.sin(roll) * xx + Math.cos(roll) * yy) / depth,
      q: 1 / depth,
      u,
      v,
    };
  };
  type Vertex = ReturnType<typeof project>;
  const triangle = (a: Vertex, b: Vertex, c: Vertex) => {
    const det = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    for (
      let y = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
      y < Math.min(h, Math.ceil(Math.max(a.y, b.y, c.y)));
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
        x < Math.min(w, Math.ceil(Math.max(a.x, b.x, c.x)));
        x++
      ) {
        const aa =
          ((b.y - c.y) * (x + .5 - c.x) + (c.x - b.x) * (y + .5 - c.y)) / det;
        const bb =
            ((c.y - a.y) * (x + .5 - c.x) + (a.x - c.x) * (y + .5 - c.y)) / det,
          cc = 1 - aa - bb;
        if (aa < 0 || bb < 0 || cc < 0) continue;
        const q = aa * a.q + bb * b.q + cc * c.q;
        const u = (aa * a.u * a.q + bb * b.u * b.q + cc * c.u * c.q) / q,
          v = (aa * a.v * a.q + bb * b.v * b.q + cc * c.v * c.q) / q;
        const mx = Math.floor((u + 1) * (size + 8) / 2) - 4,
          my = Math.floor((v + 1) * (size + 8) / 2) - 4;
        pixels[y * w + x] =
          mx >= 0 && my >= 0 && mx < size && my < size && dark(mx, my)
            ? 50
            : 225;
      }
    }
  };
  const steps = 40;
  for (let y = 0; y < steps; y++) {
    for (let x = 0; x < steps; x++) {
      const a = project(x * 2 / steps - 1, y * 2 / steps - 1),
        b = project((x + 1) * 2 / steps - 1, y * 2 / steps - 1);
      const c = project(x * 2 / steps - 1, (y + 1) * 2 / steps - 1),
        d = project((x + 1) * 2 / steps - 1, (y + 1) * 2 / steps - 1);
      triangle(a, b, c);
      triangle(b, d, c);
    }
  }
  const data = new Uint8ClampedArray(width * height * 4),
    shadow = range(.36, .65),
    boundary = range(.3, .7),
    glare = range(8, 24);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value = 0;
      for (let dy = 0; dy < ss; dy++) {
        for (let dx = 0; dx < ss; dx++) {
          value += pixels[(y * ss + dy) * w + x * ss + dx] / (ss * ss);
        }
      }
      const light = shadow +
        (1 - shadow) /
          (1 + Math.exp(-(x / width + 0.15 * y / height - boundary) * 28));
      value = value * light +
        glare *
          Math.exp(-((x / width - .65) ** 2 + (y / height - .7) ** 2) / .04) +
        range(-9, 9);
      const i = (y * width + x) * 4;
      data[i] = value * 1.04;
      data[i + 1] = value;
      data[i + 2] = value * .88;
      data[i + 3] = 255;
    }
  }
  const center = project(0, 0);
  const point = (x: number, y: number) => {
    const p = project(
      (x + 4) / (size + 8) * 2 - 1,
      (y + 4) / (size + 8) * 2 - 1,
    );
    return { x: p.x / ss, y: p.y / ss };
  };
  return {
    image: { width, height, data } as Raster,
    expected,
    symbol,
    center: { x: center.x / ss, y: center.y / ss },
    size,
    point,
    dark,
  };
}
