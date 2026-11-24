import type { ReadResult } from "zxing-wasm/reader";
import type { Raster } from "./image-enhance.ts";
import { correctIllumination } from "./illumination.ts";
import type { QrCandidate } from "./curvature.ts";
import { qrFunctionMarks } from "./qr-patterns.ts";
import { finderTangent, timingEvidence } from "./qr-timing.ts";
export { qrFunctionMarks } from "./qr-patterns.ts";
import { alignmentMesh, finderSurface, solve } from "./qr-landmarks.ts";

type Point = { x: number; y: number };
export type Surface = {
  size: number;
  score: number;
  parameters: number[];
  fromFinders?: boolean;
  hypothesis?: number;
  map: (u: number, v: number) => Point;
};

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
  cycle?: number | readonly number[],
  initial?: { size: number; parameters: number[] },
  debug?: {
    marker(pose: number[]): void;
    reject(surface: Surface): void;
    rejectStructure?(): void;
  },
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
  const interpolate = (pixels: Float32Array, x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return 1;
    const ix = Math.floor(x),
      iy = Math.floor(y),
      fx = x - ix,
      fy = y - iy,
      i = iy * width + ix;
    return pixels[i] * (1 - fx) * (1 - fy) + pixels[i + 1] * fx * (1 - fy) +
      pixels[i + width] * (1 - fx) * fy + pixels[i + width + 1] * fx * fy;
  };
  const binaryValue = (x: number, y: number) => {
    const ix = Math.round(x), iy = Math.round(y);
    if (ix < 0 || ix >= width || iy < 0 || iy >= height) return 1;
    return binary.data[(iy * width + ix) * 4] / 255;
  };
  const enoughTiming = (map: Surface["map"], size: number) => {
    const frames = [[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5]]
      .map(([x, y]) => finderTangent(map, size, x, y));
    // The global fit is less precise than independently refined poses.
    // Only stop when all local runs offer no detectable alternation.
    return timingEvidence(frames, binaryValue) > 0;
  };
  const sizeEstimate = 17 + 4 * (Number(candidate.version) || 5);
  const position = candidate.position;
  const corners = [
    position.topLeft,
    position.topRight,
    position.bottomRight,
    position.bottomLeft,
  ];
  const pitch = corners.reduce(
    (s, p, i) =>
      s +
      Math.hypot(p.x - corners[(i + 1) % 4].x, p.y - corners[(i + 1) % 4].y),
    0,
  ) / (4 * sizeEstimate);
  const radius = Math.max(2, Math.round(pitch * .55));
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = 0; x < width; x++) {
      sum += binary.data[(y * width + x) * 4] / 255;
      integral[(y + 1) * (width + 1) + x + 1] =
        integral[y * (width + 1) + x + 1] + sum;
    }
  }
  const coarse = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const l = Math.max(0, x - radius),
        r = Math.min(width, x + radius + 1),
        t = Math.max(0, y - radius),
        b = Math.min(height, y + radius + 1),
        stride = width + 1;
      coarse[y * width + x] =
        (integral[b * stride + r] - integral[t * stride + r] -
          integral[b * stride + l] + integral[t * stride + l]) /
        ((r - l) * (b - t));
    }
  }
  let value = (x: number, y: number) => interpolate(coarse, x, y);
  const estimated = Number(candidate.version),
    versions = Number.isInteger(estimated) && estimated >= 1 && estimated <= 40
      ? [estimated, estimated - 1, estimated + 1, estimated - 2, estimated + 2]
        .filter((v) => v >= 1 && v <= 40)
      : Array.from({ length: 10 }, (_, i) => i + 1);
  let job = 0;
  for (const version of versions) {
    hypotheses: for (const start of [0, 1, 2, 3, 4]) {
      const hypothesis = job++;
      if (
        cycle !== undefined && !(typeof cycle === "number" ? [cycle] : cycle)
          .some((c) => hypothesis === c % (versions.length * 5))
      ) continue;
      const size = 17 + 4 * version,
        template = qrFunctionMarks(size),
        parameters = new Array<number>(16).fill(0);
      value = (x, y) => interpolate(coarse, x, y);
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
      if (initial?.size === size) {
        parameters.splice(0, 16, ...initial.parameters);
      }
      if (start === 0 && version >= 7 && !initial) {
        const base = {
            size,
            parameters: parameters.slice(),
            score: 0,
            hypothesis,
            map: mapper(candidate.position, parameters, size),
          },
          finder = finderSurface(
            base,
            (x, y) => interpolate(smooth, x, y),
            debug?.marker,
          );
        if (finder && !enoughTiming(finder.map, finder.size)) {
          debug?.rejectStructure?.();
        } else if (finder) {
          const mesh = alignmentMesh(
            finder,
            (x, y) => interpolate(smooth, x, y),
          );
          if (mesh || finder.score <= .14) {
            yield mesh && mesh.score < finder.score ? mesh : finder;
            if (cycle !== undefined) continue;
          } else debug?.reject(finder);
        }
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
          value = (x, y) => interpolate(smooth, x, y);
          score = evaluate();
          damping = 1;
        }
        if (pass === 45) {
          // Establish the finder pose before introducing the periodic timing line.
          if (score > .16) break;
          if (
            !enoughTiming(mapper(candidate.position, parameters, size), size)
          ) {
            debug?.rejectStructure?.();
            continue hypotheses;
          }
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
            else if (pass < 45) pass = 44;
            else break;
          }
        } else {
          parameters.splice(0, 16, ...old);
          damping *= 5;
          if (damping > 1e6) {
            if (pass < 25) pass = 24;
            else if (pass < 45) pass = 44;
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
      if (sane) {
        const surface = { size, score, map, parameters, hypothesis };
        const mesh = alignmentMesh(surface, value);
        if (mesh) yield mesh;
        if (!mesh || cycle === undefined) yield surface;
      } else debug?.reject({ size, score, map, parameters });
    }
  }
}

/** Render a small square with a quiet zone, retaining a map to the source. */
export function sampleQrSurface(
  image: Raster,
  surface: Surface,
  oversample = false,
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
      const color=Array.from(image.data.subarray(from,from+4));
      if(oversample){
        color.fill(0);let count=0;
        for(const dy of [-.2,0,.2])for(const dx of [-.2,0,.2]){
          const p=surface.map((x+.5+dx)/surface.size*2-1,(y+.5+dy)/surface.size*2-1),
            xx=Math.floor(p.x),yy=Math.floor(p.y);
          if(xx<0||yy<0||xx>=image.width||yy>=image.height)continue;
          const i=(yy*image.width+xx)*4;for(let k=0;k<4;k++)color[k]+=image.data[i+k];count++;
        }
        if(count)for(let k=0;k<4;k++)color[k]/=count;
      }
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const to =
            (((y + margin) * scale + dy) * width + (x + margin) * scale + dx) *
            4;
          data[to] = color[0];
          data[to + 1] = color[1];
          data[to + 2] = color[2];
          data[to + 3] = color[3];
        }
      }
    }
  }
  return { raster: { width, height: width, data }, point };
}
