type Mark = { u: number; v: number; dark: boolean };

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
