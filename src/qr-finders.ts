import type { CameraTrace } from "./camera-trace.ts";
import type { ReadResult } from "zxing-wasm/reader";
import type { Raster } from "./image-enhance.ts";
import { correctIllumination, limitRaster } from "./illumination.ts";
import { contains } from "./geometry.ts";
import type { QrCandidate } from "./curvature.ts";

type Finder = {
  x: number;
  y: number;
  pitch: number;
  count: number;
  pitchX?: number;
  pitchY?: number;
};

/** Nested black/white/black components distinguish full finder rings from
 * accidental 1:1:3:1:1 runs in dense data. No straight QR edge is required. */
export function nestedFinders(image: Raster, loose = false): Finder[] {
  const { width, height, data } = image, length = width * height;
  const labels = new Uint32Array(length), queue = new Uint32Array(length);
  type Component = {
    dark: boolean;
    area: number;
    x: number;
    y: number;
    l: number;
    r: number;
    t: number;
    b: number;
    adjacent: Set<number>;
  };
  const components: Component[] = [{
    dark: false,
    area: 0,
    x: 0,
    y: 0,
    l: 0,
    r: 0,
    t: 0,
    b: 0,
    adjacent: new Set(),
  }];
  for (let first = 0; first < length; first++) {
    if (labels[first]) continue;
    const id = components.length,
      dark = data[first * 4] === 0,
      c: Component = {
        dark,
        area: 0,
        x: 0,
        y: 0,
        l: width,
        r: 0,
        t: height,
        b: 0,
        adjacent: new Set(),
      };
    let head = 0, tail = 1;
    queue[0] = first;
    labels[first] = id;
    while (head < tail) {
      const i = queue[head++], x = i % width, y = Math.floor(i / width);
      c.area++;
      c.x += x + .5;
      c.y += y + .5;
      c.l = Math.min(c.l, x);
      c.r = Math.max(c.r, x + 1);
      c.t = Math.min(c.t, y);
      c.b = Math.max(c.b, y + 1);
      for (
        const next of [
          x ? i - 1 : -1,
          x + 1 < width ? i + 1 : -1,
          y ? i - width : -1,
          y + 1 < height ? i + width : -1,
        ]
      ) {
        if (next >= 0 && !labels[next] && (data[next * 4] === 0) === dark) {
          labels[next] = id;
          queue[tail++] = next;
        }
      }
    }
    c.x /= c.area;
    c.y /= c.area;
    components.push(c);
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x, a = labels[i];
      for (
        const j of [x + 1 < width ? i + 1 : -1, y + 1 < height ? i + width : -1]
      ) {
        if (j < 0 || labels[j] === a) continue;
        const b = labels[j];
        components[a].adjacent.add(b);
        components[b].adjacent.add(a);
      }
    }
  }
  if (loose) {
    return components.filter((c) =>
      c.dark && c.area >= 9 && c.area < length * .015 &&
      c.area / ((c.r - c.l) * (c.b - c.t)) > .45 &&
      Math.max(c.r - c.l, c.b - c.t) < Math.min(width, height) * .2
    )
      .map((c) => ({
        x: c.x,
        y: c.y,
        pitch: Math.max(c.r - c.l, c.b - c.t) / 3,
        pitchX: (c.r - c.l) / 3,
        pitchY: (c.b - c.t) / 3,
        count: c.area,
      }))
      .sort((a, b) => b.count - a.count).slice(0, 256);
  }
  const contains = (a: Component, b: Component) =>
    a.l <= b.l && a.r >= b.r && a.t <= b.t && a.b >= b.b;
  const result: Finder[] = [];
  for (const gap of components) {
    if (gap.dark || gap.adjacent.size !== 2 || gap.area < 12) continue;
    const [a, b] = [...gap.adjacent].map((i) => components[i]).sort((a, b) =>
        a.area - b.area
      ),
      core = a,
      ring = b;
    if (
      !core.dark || !ring.dark || core.area < 9 || !contains(gap, core) ||
      !contains(ring, gap)
    ) continue;
    const ratio = gap.area / core.area, outer = ring.area / core.area;
    if (ratio < 1 || ratio > 3.2 || outer < 1.3 || outer > 4.5) continue;
    const pitch = Math.max(ring.r - ring.l, ring.b - ring.t) / 7;
    if (
      Math.hypot(core.x - gap.x, core.y - gap.y) > pitch * .65 ||
      Math.hypot(core.x - ring.x, core.y - ring.y) > pitch * .65
    ) continue;
    result.push({ x: core.x, y: core.y, pitch, count: 1000 });
  }
  return result;
}
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
  wide = false,
  trace?: CameraTrace,
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
  for (const verified of nestedFinders(image)) {
    const index = finders.findIndex((f) =>
      Math.hypot(f.x - verified.x, f.y - verified.y) < verified.pitch * 1.5
    );
    // Keep the run-based module pitch: a rotated component's bounding box
    // overestimates pitch and can select the wrong symbol version.
    if (index >= 0) finders[index].count = verified.count;
    else finders.push(verified);
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
  trace?.pass("finder");
  if (trace) {
    for (const f of best) {
      trace.marker({
        x: f.x * original.width / width,
        y: f.y * original.height / height,
      });
    }
  }
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
          cosine > (wide ? .8 : .35) || u / v < (wide ? .25 : .5) ||
          u / v > (wide ? 4 : 2) ||
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
          score: a.count + b.count + c.count - cosine * 30 - version * 2,
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
    if (codes.length >= (wide ? 24 : 6)) break;
  }
  if (trace) {
    for (const code of codes) trace.candidate(code.position, "finder");
  }
  return codes;
}
