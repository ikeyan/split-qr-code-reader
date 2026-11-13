import type { ReadResult } from "zxing-wasm/reader";
import type { Raster } from "./image-enhance.ts";
import { correctIllumination, limitRaster } from "./illumination.ts";
import { contains } from "./geometry.ts";
import type { QrCandidate } from "./curvature.ts";

type Finder = { x: number; y: number; pitch: number; count: number };
function ratio(r: number[]): boolean {
  const unit = r.reduce((a, b) => a + b, 0) / 7;
  return unit >= 1 &&
    r.every((v, i) =>
      Math.abs(v - (i === 2 ? 3 : 1) * unit) < unit * (i === 2 ? 1.5 : .75)
    );
}

/** Locate finder triples even when ZXing cannot form a decoding candidate. */
export function locateQrCandidates(
  original: Raster,
  known: ReadResult[] = [],
): QrCandidate[] {
  const image = correctIllumination(limitRaster(original), "mean"),
    { width, height, data } = image;
  const black = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height &&
    data[(y * width + x) * 4] === 0;
  const finders: Finder[] = [];
  const vertical = (x: number, y: number, max: number) => {
    const r = [0, 0, 0, 0, 0];
    let top = y, bottom = y + 1;
    while (top >= 0 && black(x, top) && r[2] < max * 15) {
      r[2]++;
      top--;
    }
    while (bottom < height && black(x, bottom) && r[2] < max * 15) {
      r[2]++;
      bottom++;
    }
    while (top >= 0 && !black(x, top) && r[1] < max * 6) {
      r[1]++;
      top--;
    }
    while (top >= 0 && black(x, top) && r[0] < max * 6) {
      r[0]++;
      top--;
    }
    while (bottom < height && !black(x, bottom) && r[3] < max * 6) {
      r[3]++;
      bottom++;
    }
    while (bottom < height && black(x, bottom) && r[4] < max * 6) {
      r[4]++;
      bottom++;
    }
    return ratio(r)
      ? {
        y: bottom - r[4] - r[3] - r[2] / 2,
        pitch: r.reduce((a, b) => a + b, 0) / 7,
      }
      : undefined;
  };
  for (let y = 0; y < height; y++) {
    const runs: { length: number; dark: boolean }[] = [];
    for (let x = 0; x <= width; x++) {
      const dark = x < width && black(x, y), last = runs.at(-1);
      if (last && last.dark === dark) {
        last.length++;
        continue;
      }
      if (runs.length >= 5) {
        const five = runs.slice(-5), r = five.map((run) => run.length);
        if (five[0].dark && ratio(r)) {
          const cx = x - r[4] - r[3] - r[2] / 2,
            pitch = r.reduce((a, b) => a + b, 0) / 7;
          const check = vertical(Math.round(cx), y, pitch);
          if (check && check.pitch / pitch > .2 && check.pitch / pitch < 5) {
            const old = finders.find((f) =>
              Math.hypot(f.x - cx, f.y - check.y) < pitch * 1.5
            );
            if (old) {
              const n = old.count;
              old.x = (old.x * n + cx) / (n + 1);
              old.y = (old.y * n + check.y) / (n + 1);
              old.pitch = (old.pitch * n + Math.max(pitch, check.pitch)) /
                (n + 1);
              old.count++;
            } else {finders.push({
                x: cx,
                y: check.y,
                pitch: Math.max(pitch, check.pitch),
                count: 1,
              });}
          }
        }
      }
      runs.push({ length: 1, dark });
      if (runs.length > 6) runs.shift();
    }
  }
  const best = finders.filter((f) =>
    f.count >= 2 && !known.some((code) => {
      const p = code.position;
      return contains([p.topLeft, p.topRight, p.bottomRight, p.bottomLeft], {
        x: f.x * original.width / width,
        y: f.y * original.height / height,
      });
    })
  ).sort((a, b) => b.count - a.count).slice(0, 20);
  const triples: { score: number; code: QrCandidate }[] = [];
  for (const a of best) {
    for (const b of best) {
      for (const c of best) {
        if (a === b || b === c || a === c) continue;
        const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - a.x, vy = c.y - a.y;
        if (ux * vy - uy * vx <= 0) continue;
        const u = Math.hypot(ux, uy),
          v = Math.hypot(vx, vy),
          pitch = (a.pitch + b.pitch + c.pitch) / 3;
        const cosine = Math.abs((ux * vx + uy * vy) / (u * v));
        if (
          cosine > .35 || u / v < .5 || u / v > 2 ||
          Math.min(u, v) < pitch * 13 ||
          Math.max(a.pitch, b.pitch, c.pitch) >
            Math.min(a.pitch, b.pitch, c.pitch) * 2
        ) continue;
        const dimension = Math.max(u, v) / pitch + 7,
          version = Math.max(1, Math.min(40, Math.round((dimension - 17) / 4))),
          size = 17 + 4 * version;
        const point = (x: number, y: number) => ({
          x: (a.x + (ux * (x - 3.5) + vx * (y - 3.5)) / (size - 7)) *
            original.width / width,
          y: (a.y + (uy * (x - 3.5) + vy * (y - 3.5)) / (size - 7)) *
            original.height / height,
        });
        const code = {
          version: String(version),
          position: {
            topLeft: point(0, 0),
            topRight: point(size, 0),
            bottomRight: point(size, size),
            bottomLeft: point(0, size),
          },
        };
        triples.push({
          score: a.count + b.count + c.count - cosine * 30,
          code,
        });
      }
    }
  }
  const codes: QrCandidate[] = [];
  for (const { code } of triples.sort((a, b) => b.score - a.score)) {
    const p = code.position.topLeft;
    if (
      !codes.some((old) =>
        Math.hypot(old.position.topLeft.x - p.x, old.position.topLeft.y - p.y) <
          20
      )
    ) codes.push(code);
    if (codes.length >= 6) break;
  }
  return codes;
}
