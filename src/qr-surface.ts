import type { ReadResult } from "zxing-wasm/reader";
import type { Raster } from "./image-enhance.ts";
import { correctIllumination } from "./illumination.ts";
import type { QrCandidate } from "./curvature.ts";

type Point = { x: number; y: number };
type Mark = { u: number; v: number; dark: boolean };
type Surface = {
  size: number;
  score: number;
  map: (u: number, v: number) => Point;
};

function solve(a: number[][], b: number[]): number[] {
  const n = b.length, m = a.map((row, i) => [...row, b[i]]);
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    }
    [m[i], m[pivot]] = [m[pivot], m[i]];
    const d = m[i][i];
    if (Math.abs(d) < 1e-12) return new Array(n).fill(0);
    for (let k = i; k <= n; k++) m[i][k] /= d;
    for (let j = 0; j < n; j++) {
      if (j !== i) {
        const v = m[j][i];
        for (let k = i; k <= n; k++) m[j][k] -= v * m[i][k];
      }
    }
  }
  return m.map((row) => row[n]);
}

/** Only public QR function patterns are used to estimate the sampling lattice. */
export function qrFunctionMarks(size: number): Mark[] {
  const cells = new Map<number, boolean>();
  const put = (x: number, y: number, dark: boolean) => {
    if (x >= 0 && y >= 0 && x < size && y < size) cells.set(y * size + x, dark);
  };
  for (const [left, top] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        put(left + x, top + y, d === 3 || d <= 1);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    put(i, 6, i % 2 === 0);
    put(6, i, i % 2 === 0);
  }
  const version = (size - 17) / 4;
  if (version > 1) {
    const count = Math.floor(version / 7) + 2,
      step = version === 32
        ? 26
        : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
    const centers = [6];
    for (let i = count - 2; i >= 0; i--) centers.push(size - 7 - i * step);
    for (const y of centers) {
      for (const x of centers) {
        if (
          (x === 6 && y === 6) || (x === 6 && y === size - 7) ||
          (x === size - 7 && y === 6)
        ) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            put(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
  }
  return [...cells].flatMap(([index, dark]) =>
    [[0, 0], [-.28, -.28], [.28, .28], [-.28, .28], [.28, -.28]].map((
      [dx, dy],
    ) => ({
      u: ((index % size) + .5 + dx) / size * 2 - 1,
      v: (Math.floor(index / size) + .5 + dy) / size * 2 - 1,
      dark,
    }))
  );
}

function mapper(
  position: ReadResult["position"],
  p: number[],
  size: number,
): (u: number, v: number) => Point {
  const a = position.topLeft,
    b = position.topRight,
    c = position.bottomRight,
    d = position.bottomLeft;
  const anchor = (1 - 7 / size) ** 2;
  // Paired x/y coefficients: translation, scale, shear, axial cubic,
  // cross-axis bow, contraction, uv perspective, and axial quadratic.
  // Bow, contraction and axial cubic terms vanish at finder centers (±(1 - 7 / size)),
  // reducing their coupling with the initial pose estimate.
  return (u, v) => {
    const x = (u + p[0] + p[2] * u + p[4] * v + p[6] * u * (u * u - anchor) +
      p[8] * (anchor - v * v) + p[10] * u * (anchor - v * v) + p[12] * u * v +
      p[14] * (anchor - u * u) + 1) / 2;
    const y = (v + p[1] + p[3] * v + p[5] * u + p[7] * v * (v * v - anchor) +
      p[9] * (anchor - u * u) + p[11] * v * (anchor - u * u) + p[13] * u * v +
      p[15] * (anchor - v * v) + 1) / 2;
    return {
      x: a.x * (1 - x) * (1 - y) + b.x * x * (1 - y) + c.x * x * y +
        d.x * (1 - x) * y,
      y: a.y * (1 - x) * (1 - y) + b.y * x * (1 - y) + c.y * x * y +
        d.y * (1 - x) * y,
    };
  };
}

/** Fit a smooth local surface against finder, timing and alignment patterns.
 * Decode success, never the fitting score, decides whether a result is valid.
 */
export function* fitQrSurfaces(
  image: Raster,
  candidate: QrCandidate,
  cycle?: number,
): Generator<Surface> {
  const binary = correctIllumination(image, "mean"), { width, height } = image;
  const smooth = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          sum += binary.data[((y + dy) * width + x + dx) * 4];
        }
      }
      smooth[y * width + x] = sum / (255 * 9);
    }
  }
  const value = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return 1;
    const ix = Math.floor(x),
      iy = Math.floor(y),
      fx = x - ix,
      fy = y - iy,
      i = iy * width + ix;
    return smooth[i] * (1 - fx) * (1 - fy) + smooth[i + 1] * fx * (1 - fy) +
      smooth[i + width] * (1 - fx) * fy + smooth[i + width + 1] * fx * fy;
  };
  const estimated = Number(candidate.version),
    versions = Number.isInteger(estimated) && estimated >= 1 && estimated <= 40
      ? [estimated, estimated - 1, estimated + 1, estimated - 2, estimated + 2]
        .filter((v) => v >= 1 && v <= 40)
      : Array.from({ length: 10 }, (_, i) => i + 1);
  let job = 0;
  for (const version of versions) {
    for (const start of [0, 1, 2, 3, 4]) {
      if (
        cycle !== undefined && job++ !== cycle % (versions.length * 5)
      ) continue;
      const size = 17 + 4 * version,
        template = qrFunctionMarks(size),
        parameters = new Array<number>(16).fill(0);
      if (start) {
        // Two axis-constrained families, with either contraction sign, supplement
        // the unconstrained fit. These are starting points, not decoded templates.
        const vertical = start <= 2;
        parameters[vertical ? 7 : 6] = -.14;
        parameters[vertical ? 10 : 11] = start % 2 ? .08 : -.08;
      }
      if (estimated >= 1 && estimated <= 40) {
        parameters[2] =
          parameters[3] =
            (1 - 7 / (17 + 4 * estimated)) / (1 - 7 / size) - 1;
      }
      const finders = template.filter((m) => {
        const x = (m.u + 1) * size / 2, y = (m.v + 1) * size / 2;
        return (x < 8 && y < 8) || (x > size - 8 && y < 8) ||
          (x < 8 && y > size - 8);
      });
      let active = finders;
      const evaluate = () => {
        const map = mapper(candidate.position, parameters, size);
        let error = 0;
        for (const m of active) {
          const p = map(m.u, m.v), v = value(p.x, p.y) - (m.dark ? 0 : 1);
          error += v * v;
        }
        return error / active.length;
      };
      let score = evaluate();
      let damping = 1;
      const anchor = (1 - 7 / size) ** 2,
        a = candidate.position.topLeft,
        b = candidate.position.topRight,
        c = candidate.position.bottomRight,
        d = candidate.position.bottomLeft;
      for (let pass = 0; pass < 100; pass++) {
        if (pass === 25) {
          // Establish the finder pose before introducing the periodic timing line.
          if (score > .16) break;
          active = template;
          score = evaluate();
          damping = 1;
        }
        const map = mapper(candidate.position, parameters, size),
          normal = Array.from(
            { length: 16 },
            () => new Array<number>(16).fill(0),
          ),
          rhs = new Array<number>(16).fill(0);
        for (const m of active) {
          const { u, v } = m,
            p = map(u, v),
            residual = value(p.x, p.y) - (m.dark ? 0 : 1);
          const gx = (value(p.x + .7, p.y) - value(p.x - .7, p.y)) / 1.4,
            gy = (value(p.x, p.y + .7) - value(p.x, p.y - .7)) / 1.4;
          const bx = [
            1,
            0,
            u,
            0,
            v,
            0,
            u * (u * u - anchor),
            0,
            anchor - v * v,
            0,
            u * (anchor - v * v),
            0,
            u * v,
            0,
            anchor - u * u,
            0,
          ];
          const by = [
            0,
            1,
            0,
            v,
            0,
            u,
            0,
            v * (v * v - anchor),
            0,
            anchor - u * u,
            0,
            v * (anchor - u * u),
            0,
            u * v,
            0,
            anchor - v * v,
          ];
          let x = (u + 1) / 2, y = (v + 1) / 2;
          for (let k = 0; k < 16; k++) {
            x += parameters[k] * bx[k] / 2;
            y += parameters[k] * by[k] / 2;
          }
          const dx = {
            x: (b.x - a.x) * (1 - y) + (c.x - d.x) * y,
            y: (b.y - a.y) * (1 - y) + (c.y - d.y) * y,
          };
          const dy = {
            x: (d.x - a.x) * (1 - x) + (c.x - b.x) * x,
            y: (d.y - a.y) * (1 - x) + (c.y - b.y) * x,
          };
          const j = bx.map((co, k) =>
            (start > 0 &&
                (start <= 2 ? [6, 9, 11, 14] : [7, 8, 10, 15]).includes(k))
              ? 0
              : (gx * (dx.x * co + dy.x * by[k]) +
                gy * (dx.y * co + dy.y * by[k])) / 2
          );
          for (let r = 0; r < 16; r++) {
            rhs[r] -= j[r] * residual;
            for (let col = 0; col <= r; col++) {
              normal[r][col] += j[r] * j[col];
            }
          }
        }
        for (let r = 0; r < 16; r++) {
          for (let col = 0; col < r; col++) normal[col][r] = normal[r][col];
          // Levenberg-Marquardt damping; accept only steps that reduce the error.
          normal[r][r] += damping * (normal[r][r] + 1);
        }
        const update = solve(normal, rhs),
          max = Math.max(...update.map(Math.abs)),
          factor = Math.min(1, .06 / Math.max(max, 1e-9));
        const old = parameters.slice();
        for (let k = 0; k < 16; k++) parameters[k] += update[k] * factor;
        const next = evaluate();
        if (next < score) {
          score = next;
          damping = Math.max(.001, damping * .5);
          if (max < .0001) {
            if (pass < 25) pass = 24;
            else break;
          }
        } else {
          parameters.splice(0, 16, ...old);
          damping *= 5;
          if (damping > 1e6) {
            if (pass < 25) pass = 24;
            else break;
          }
        }
      }
      const map = mapper(candidate.position, parameters, size);
      // Reject folds, collapsed grids and excursions outside the candidate crop.
      const orientation = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x);
      let sane = parameters.every((p) =>
        Number.isFinite(p) && Math.abs(p) < .7
      );
      for (let v = -1; v <= 1 && sane; v += .5) {
        for (let u = -1; u <= 1 && sane; u += .5) {
          const p = map(u, v), dx = map(u + .01, v), dy = map(u, v + .01);
          const determinant = (dx.x - p.x) * (dy.y - p.y) -
            (dx.y - p.y) * (dy.x - p.x);
          sane = p.x >= 0 && p.y >= 0 && p.x < width && p.y < height &&
            determinant * orientation > 0;
        }
      }
      if (sane) yield { size, score, map };
    }
  }
}

/** Render a small square with a quiet zone, retaining a map to the source. */
export function sampleQrSurface(
  image: Raster,
  surface: Surface,
): { raster: Raster; point: (p: Point) => Point } {
  const scale = 6,
    margin = 4,
    width = (surface.size + margin * 2) * scale,
    data = new Uint8ClampedArray(width * width * 4);
  data.fill(255);
  const point = (p: Point) =>
    surface.map(
      (p.x / scale - margin) / surface.size * 2 - 1,
      (p.y / scale - margin) / surface.size * 2 - 1,
    );
  for (let y = 0; y < surface.size; y++) {
    for (let x = 0; x < surface.size; x++) {
      const p = point({
          x: (x + margin + .5) * scale,
          y: (y + margin + .5) * scale,
        }),
        sx = Math.round(p.x),
        sy = Math.round(p.y);
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) {
        continue;
      }
      const from = (sy * image.width + sx) * 4;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const to =
            (((y + margin) * scale + dy) * width + (x + margin) * scale + dx) *
            4;
          data[to] = image.data[from];
          data[to + 1] = image.data[from + 1];
          data[to + 2] = image.data[from + 2];
          data[to + 3] = image.data[from + 3];
        }
      }
    }
  }
  return { raster: { width, height: width, data }, point };
}
