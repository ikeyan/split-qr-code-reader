import type { Surface } from "./qr-surface.ts";
import { qrFunctionMarks } from "./qr-patterns.ts";
import { solve } from "./qr-landmarks.ts";

/** Local correction of the learned grid using public QR patterns. */
export function refineNeuralSurface(
  surface: Surface,
  value: (x: number, y: number) => number,
): Surface {
  const marks = qrFunctionMarks(surface.size),
    parameters = new Array<number>(20).fill(0);
  const basis = (
    u: number,
    v: number,
  ) => [
    1,
    u,
    v,
    u * u,
    v * v,
    u * v,
    u * u * u,
    v * v * v,
    u * u * v,
    u * v * v,
  ];
  const map = (u: number, v: number) => {
    const p = surface.map(u, v), b = basis(u, v);
    return {
      x: p.x + b.reduce((s, v, i) => s + v * parameters[i], 0),
      y: p.y + b.reduce((s, v, i) => s + v * parameters[10 + i], 0),
    };
  };
  const error = () =>
    marks.reduce((s, m) => {
      const p = map(m.u, m.v);
      return s + (value(p.x, p.y) - (m.dark ? 0 : 1)) ** 2;
    }, 0) / marks.length;
  let score = error(), damping = .1;
  if (score > .27) return { ...surface, score };
  for (let pass = 0; pass < 45; pass++) {
    const normal = Array.from(
        { length: 20 },
        () => new Array<number>(20).fill(0),
      ),
      rhs = new Array<number>(20).fill(0);
    for (const m of marks) {
      const p = map(m.u, m.v),
        b = basis(m.u, m.v),
        residual = value(p.x, p.y) - (m.dark ? 0 : 1),
        gx = (value(p.x + .7, p.y) - value(p.x - .7, p.y)) / 1.4,
        gy = (value(p.x, p.y + .7) - value(p.x, p.y - .7)) / 1.4,
        jacobian = [...b.map((v) => gx * v), ...b.map((v) => gy * v)];
      for (let i = 0; i < 20; i++) {
        rhs[i] -= jacobian[i] * residual;
        for (let j = 0; j <= i; j++) normal[i][j] += jacobian[i] * jacobian[j];
      }
    }
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < i; j++) normal[j][i] = normal[i][j];
      normal[i][i] += damping * (normal[i][i] + .01);
    }
    const update = solve(normal, rhs),
      maximum = Math.max(...update.map(Math.abs)),
      factor = Math.min(1, 1.5 / Math.max(maximum, 1e-9)),
      old = parameters.slice();
    for (let i = 0; i < 20; i++) parameters[i] += update[i] * factor;
    const next = error();
    if (next < score) {
      score = next;
      damping = Math.max(.001, damping * .5);
      if (maximum < .001) break;
    } else {
      parameters.splice(0, 20, ...old);
      damping *= 5;
      if (damping > 1e5) break;
    }
  }
  for (let v = -1; v <= 1; v += .25) {
    for (let u = -1; u <= 1; u += .25) {
      const p = map(u, v),
        x = map(u + .01, v),
        y = map(u, v + .01),
        a = surface.map(u, v),
        b = surface.map(u + .01, v),
        c = surface.map(u, v + .01);
      if (
        ((x.x - p.x) * (y.y - p.y) - (x.y - p.y) * (y.x - p.x)) *
            ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) <= 0
      ) return { ...surface, score: 1 };
    }
  }
  return { ...surface, map, score };
}
