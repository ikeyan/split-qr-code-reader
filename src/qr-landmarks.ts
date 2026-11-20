import type { Surface } from "./qr-surface.ts";
import { qrFunctionMarks } from "./qr-patterns.ts";
import { readQrVersion } from "./qr-version.ts";

/** Refine the global estimate with independently located public alignment marks.
 * A cylinder seen obliquely need not have straight edges between the finders.
 * Sparse, smooth displacement interpolation lets the interior follow the paper.
 */
export function alignmentMesh(
  surface: Surface,
  value: (x: number, y: number) => number,
): Surface | undefined {
  const { size, map } = surface, version = (size - 17) / 4;
  if (version < 7) return;
  const count = Math.floor(version / 7) + 2,
    step = version === 32
      ? 26
      : Math.floor((version * 4 + count * 2 + 1) / (count * 2 - 2)) * 2;
  const centers = [6];
  for (let i = count - 2; i >= 0; i--) centers.push(size - 7 - i * step);
  const controls: { u: number; v: number; x: number; y: number }[] = [];
  let alignments = 0;
  const locate = (x: number, y: number) => {
    const u = (x + .5) / size * 2 - 1, v = (y + .5) / size * 2 - 1;
    const p = map(u, v), px = map(u + 2 / size, v), py = map(u, v + 2 / size);
    const dx = { x: px.x - p.x, y: px.y - p.y },
      dy = { x: py.x - p.x, y: py.y - p.y };
    const offsets: { x: number; y: number; dark: boolean }[] = [];
    for (let yy = -2; yy <= 2; yy++) {
      for (let xx = -2; xx <= 2; xx++) {
        const d = Math.max(Math.abs(xx), Math.abs(yy));
        const dark = d !== 1;
        for (const [sx, sy] of [[0, 0], [-.24, -.24], [.24, .24]]) {
          offsets.push({ x: xx + sx, y: yy + sy, dark });
        }
      }
    }
    const error = (a: number, b: number) => {
      let sum = 0;
      for (const o of offsets) {
        const e = value(
          p.x + (o.x + a) * dx.x + (o.y + b) * dy.x,
          p.y + (o.x + a) * dx.y + (o.y + b) * dy.y,
        ) - (o.dark ? 0 : 1);
        sum += e * e;
      }
      return sum / offsets.length;
    };
    let best = Infinity, a = 0, b = 0;
    const search = (cx: number, cy: number, radius: number, step: number) => {
      for (let y = -radius; y <= radius + 1e-6; y += step) {
        for (let x = -radius; x <= radius + 1e-6; x += step) {
          const score = error(cx + x, cy + y) +
            .0005 * ((cx + x) ** 2 + (cy + y) ** 2);
          if (score < best) {
            best = score;
            a = cx + x;
            b = cy + y;
          }
        }
      }
    };
    search(0, 0, 3.5, .5);
    search(a, b, .4, .1);
    // Random data can resemble an alignment ring. Keep only a strong match;
    // the normal QR decoder still verifies the complete corrected symbol.
    if (best > .085) return;
    controls.push({ u, v, x: a * dx.x + b * dy.x, y: a * dx.y + b * dy.y });
    alignments++;
  };
  for (const [x, y] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    controls.push({
      u: (x + .5) / size * 2 - 1,
      v: (y + .5) / size * 2 - 1,
      x: 0,
      y: 0,
    });
  }
  for (const y of centers) {
    for (const x of centers) {
      if (
        (x === 6 && y === 6) || (x === 6 && y === size - 7) ||
        (x === size - 7 && y === 6)
      ) continue;
      locate(x, y);
    }
  }
  if (alignments < 3) return;
  // Thin plate interpolation of displacements, with affine terms and a small
  // regularizer for sampling noise. Coordinates stay in the original raster.
  const kernel = (r: number) => r > 1e-12 ? r * Math.log(r) : 0;
  const n = controls.length,
    matrix = Array.from(
      { length: n + 3 },
      () => new Array<number>(n + 3).fill(0),
    );
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      matrix[i][j] = kernel(
        (controls[i].u - controls[j].u) ** 2 +
          (controls[i].v - controls[j].v) ** 2,
      );
    }
    matrix[i][i] += .001;
    for (const [k, v] of [1, controls[i].u, controls[i].v].entries()) {
      matrix[i][n + k] = matrix[n + k][i] = v;
    }
  }
  const wx = solve(matrix, [...controls.map((c) => c.x), 0, 0, 0]),
    wy = solve(matrix, [...controls.map((c) => c.y), 0, 0, 0]);
  const refined = (u: number, v: number) => {
    const p = map(u, v);
    let x = wx[n] + wx[n + 1] * u + wx[n + 2] * v,
      y = wy[n] + wy[n + 1] * u + wy[n + 2] * v;
    for (let i = 0; i < n; i++) {
      const r = kernel((u - controls[i].u) ** 2 + (v - controls[i].v) ** 2);
      x += wx[i] * r;
      y += wy[i] * r;
    }
    return { x: p.x + x, y: p.y + y };
  };
  let score = 0;
  const template = qrFunctionMarks(size);
  for (const m of template) {
    const p = refined(m.u, m.v);
    score += (value(p.x, p.y) - (m.dark ? 0 : 1)) ** 2;
  }
  score /= template.length;
  if (score > .14) return;
  // A local false match must never fold the sampling lattice.
  for (let v = -1; v <= 1; v += .2) {
    for (let u = -1; u <= 1; u += .2) {
      const p = refined(u, v),
        dx = refined(u + .01, v),
        dy = refined(u, v + .01),
        a = map(u, v),
        ax = map(u + .01, v),
        ay = map(u, v + .01);
      if (
        ((dx.x - p.x) * (dy.y - p.y) - (dx.y - p.y) * (dy.x - p.x)) *
            ((ax.x - a.x) * (ay.y - a.y) - (ax.y - a.y) * (ay.x - a.x)) <= 0
      ) return;
    }
  }
  return { ...surface, map: refined, score };
}

export function solve(a: number[][], b: number[]): number[] {
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

export function finderSurface(
  base: Surface,
  value: (x: number, y: number) => number,
): Surface | undefined {
  let size = base.size;
  const poses: number[][] = [];
  const observations: { u: number; v: number; x: number; y: number }[] = [];
  for (const [cx, cy] of [[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5]]) {
    const u = cx / size * 2 - 1,
      v = cy / size * 2 - 1,
      p = base.map(u, v),
      px = base.map(u + 2 / size, v),
      py = base.map(u, v + 2 / size);
    const initial = [p.x, p.y, px.x - p.x, px.y - p.y, py.x - p.x, py.y - p.y];
    const marks: { x: number; y: number; target: number }[] = [];
    for (let y = -3; y <= 3; y++) {
      for (let x = -3; x <= 3; x++) {
        const d = Math.max(Math.abs(x), Math.abs(y)),
          target = d === 3 || d <= 1 ? 0 : 1;
        for (const [dx, dy] of [[0, 0], [-.25, -.25], [.25, .25]]) {
          marks.push({ x: x + dx, y: y + dy, target });
        }
      }
    }
    const error = (p: number[]) =>
      marks.reduce(
        (s, m) =>
          s +
          (value(
              p[0] + p[2] * m.x + p[4] * m.y,
              p[1] + p[3] * m.x + p[5] * m.y,
            ) - m.target) ** 2,
        0,
      ) / marks.length;
    let best = Infinity, pose = initial.slice();
    // Translation and local scale are independent of the global paper pose.
    for (const sx of [.45, .65, .85, 1, 1.2]) {
      for (const sy of [.45, .65, .85, 1, 1.2]) {
        for (const hx of [-.3, 0, .3]) {
          for (const hy of [-.3, 0, .3]) {
            const p = [
              initial[0],
              initial[1],
              initial[2] * sx + initial[4] * hx,
              initial[3] * sx + initial[5] * hx,
              initial[4] * sy + initial[2] * hy,
              initial[5] * sy + initial[3] * hy,
            ];
            const score = error(p);
            if (score < best) {
              best = score;
              pose = p;
            }
          }
        }
      }
    }
    const shape = pose.slice();
    for (let y = -1.5; y <= 1.5; y += .5) {
      for (let x = -1.5; x <= 1.5; x += .5) {
        const p = shape.slice();
        p[0] += x * initial[2] + y * initial[4];
        p[1] += x * initial[3] + y * initial[5];
        const score = error(p);
        if (score < best) {
          best = score;
          pose = p;
        }
      }
    }
    let damping = .1;
    for (let pass = 0; pass < 35; pass++) {
      const normal = Array.from(
          { length: 6 },
          () => new Array<number>(6).fill(0),
        ),
        rhs = new Array<number>(6).fill(0);
      for (const m of marks) {
        const x = pose[0] + pose[2] * m.x + pose[4] * m.y,
          y = pose[1] + pose[3] * m.x + pose[5] * m.y,
          residual = value(x, y) - m.target,
          gx = (value(x + .6, y) - value(x - .6, y)) / 1.2,
          gy = (value(x, y + .6) - value(x, y - .6)) / 1.2,
          j = [gx, gy, gx * m.x, gy * m.x, gx * m.y, gy * m.y];
        for (let r = 0; r < 6; r++) {
          rhs[r] -= j[r] * residual;
          for (let c = 0; c < 6; c++) normal[r][c] += j[r] * j[c];
        }
      }
      for (let r = 0; r < 6; r++) {
        normal[r][r] += damping * (normal[r][r] + .001);
      }
      const update = solve(normal, rhs),
        trial = pose.map((v, i) => v + update[i]),
        score = error(trial);
      if (score < best) {
        pose = trial;
        best = score;
        damping = Math.max(.001, damping * .5);
      } else damping *= 5;
      if (damping > 1e6 || Math.max(...update.map(Math.abs)) < .001) break;
    }
    if (best > .12) return;
    poses.push(pose);
  }
  const copies = [poses[1], poses[2]].map((p, copy) =>
    Array.from({ length: 18 }, (_, i) => {
      const a = -7 + i % 3,
        b = -3 + Math.floor(i / 3),
        x = copy ? b : a,
        y = copy ? a : b;
      return [[0, 0], [-.2, -.2], [.2, .2]].reduce(
        (s, [dx, dy]) =>
          s +
          value(
              p[0] + p[2] * (x + dx) + p[4] * (y + dy),
              p[1] + p[3] * (x + dx) + p[5] * (y + dy),
            ) / 3,
        0,
      );
    })
  );
  const version = readQrVersion(copies);
  if (version) size = 17 + 4 * version;
  // Small patches supply both the finder center and its local tangent frame.
  for (
    const [i, [cx, cy]] of [[3.5, 3.5], [size - 3.5, 3.5], [3.5, size - 3.5]]
      .entries()
  ) {
    const pose = poses[i], u = cx / size * 2 - 1, v = cy / size * 2 - 1;
    for (const [x, y] of [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]]) {
      observations.push({
        u: u + x * 2 / size,
        v: v + y * 2 / size,
        x: pose[0] + pose[2] * x + pose[4] * y,
        y: pose[1] + pose[3] * x + pose[5] * y,
      });
    }
  }
  const origin = base.map(0, 0),
    corner = base.map(1, 1),
    scale = Math.hypot(corner.x - origin.x, corner.y - origin.y);
  const marks = qrFunctionMarks(size);
  let bestSurface: Surface | undefined;
  // Project a cylinder through an unconstrained camera matrix. Its axis and
  // curvature are hypotheses; the three measured finder tangent frames supply
  // the constraints. Off-center bends are absorbed by the camera pose.
  for (const vertical of [true, false]) {
    for (const angle of [.4, .6, .8, 1, 1.2, 1.4]) {
      const basis = (u: number, v: number) => {
        const t = vertical ? v : u, h = vertical ? u : v;
        return [
          1,
          h,
          Math.sin(angle * t) / angle,
          (1 - Math.cos(angle * t)) / angle,
        ];
      };
      const normal = Array.from(
          { length: 11 },
          () => new Array<number>(11).fill(0),
        ),
        rhs = new Array<number>(11).fill(0);
      for (const p of observations) {
        const b = basis(p.u, p.v),
          x = (p.x - origin.x) / scale,
          y = (p.y - origin.y) / scale;
        for (
          const [row, target] of [
            [[...b, 0, 0, 0, 0, -x * b[1], -x * b[2], -x * b[3]], x],
            [[0, 0, 0, 0, ...b, -y * b[1], -y * b[2], -y * b[3]], y],
          ] as [number[], number][]
        ) {
          for (let i = 0; i < 11; i++) {
            rhs[i] += row[i] * target;
            for (let j = 0; j < 11; j++) {
              normal[i][j] += row[i] * row[j];
            }
          }
        }
      }
      for (let i = 0; i < 11; i++) {
        normal[i][i] += 1e-8;
      }
      const p = solve(normal, rhs);
      const map = (u: number, v: number) => {
        const b = basis(u, v), d = 1 + p[8] * b[1] + p[9] * b[2] + p[10] * b[3];
        return {
          x: origin.x + scale * b.reduce((s, v, i) => s + v * p[i], 0) / d,
          y: origin.y + scale * b.reduce((s, v, i) => s + v * p[i + 4], 0) / d,
        };
      };
      let sane = true;
      for (let v = -1; v <= 1 && sane; v += .25) {
        for (let u = -1; u <= 1 && sane; u += .25) {
          const p = map(u, v),
            dx = map(u + .01, v),
            dy = map(u, v + .01),
            a = base.map(u, v),
            ax = base.map(u + .01, v),
            ay = base.map(u, v + .01);
          sane = Number.isFinite(p.x) && Number.isFinite(p.y) &&
            Math.hypot(p.x - a.x, p.y - a.y) < scale * .5 &&
            ((dx.x - p.x) * (dy.y - p.y) - (dx.y - p.y) * (dy.x - p.x)) *
                  ((ax.x - a.x) * (ay.y - a.y) - (ax.y - a.y) * (ay.x - a.x)) >
              0;
        }
      }
      if (!sane) continue;
      let score = 0;
      for (const m of marks) {
        const p = map(m.u, m.v);
        score += (value(p.x, p.y) - (m.dark ? 0 : 1)) ** 2;
      }
      score /= marks.length;
      if (!bestSurface || score < bestSurface.score) {
        bestSurface = { ...base, size, map, score, fromFinders: true };
      }
    }
  }
  return bestSurface;
}
