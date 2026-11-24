type Brightness = (x: number, y: number) => number;
type Map = (u: number, v: number) => { x: number; y: number };

/** Extract a tangent frame at a Model 2 finder center. */
export function finderTangent(map: Map, size: number, x: number, y: number) {
  const u = 2 * x / size - 1, v = 2 * y / size - 1;
  const step = 2 / size;
  const p = map(u, v), a = map(u + step, v), b = map(u, v + step);
  return [p.x, p.y, a.x - p.x, a.y - p.y, b.x - p.x, b.y - p.y];
}

/** Score short timing runs in each finder's local frame. The full lines can
 * bend between finders. A separator followed by dark/light/dark/light is
 * shared by all Model 2 versions. */
export function timingEvidence(
  [topLeft, topRight, bottomLeft]: number[][],
  value: Brightness,
) {
  const run = (
    [x, y, ux, uy, vx, vy]: number[],
    horizontal: boolean,
    sign: number,
  ) => {
    const ax = (horizontal ? ux : vx) * sign;
    const ay = (horizontal ? uy : vy) * sign;
    const bx = horizontal ? vx : ux, by = horizontal ? vy : uy;
    let best = 0;
    for (const lateral of [2.55, 3, 3.45]) {
      const startX = x + lateral * bx, startY = y + lateral * by;
      for (const pitch of [.86, 1, 1.14]) {
        for (const shift of [-.4, 0, .4]) {
          const first = pitch * 4 + shift;
          let previous = value(startX + ax * first, startY + ay * first);
          let contrast = 1;
          for (let i = 1; i <= 4; i++) {
            const offset = first + i * pitch;
            const next = value(startX + ax * offset, startY + ay * offset);
            contrast = Math.min(contrast, (previous - next) * (i % 2 ? 1 : -1));
            previous = next;
            if (contrast <= best) break;
          }
          best = Math.max(best, contrast);
        }
      }
    }
    return best;
  };
  const strengths = [
    run(topLeft, true, 1),
    run(topLeft, false, 1),
    run(topRight, true, -1),
    run(bottomLeft, false, -1),
  ].sort((a, b) => b - a);
  // Accept two weak runs or one clean run if the other corners are blurred.
  return Math.max(strengths[0] / .48, strengths[1] / .18);
}
