export type Part = { index: number; total: number; parity: number; bytes: Uint8Array };
export type Outcome = 'accepted' | 'duplicate' | 'conflict' | 'invalid';
export type Assembly = { total: number; parity: number; parts: Map<number, Uint8Array> } | null;
export function accept(state: Assembly, part: Part): { state: Assembly; outcome: Outcome } {
  if (!Number.isInteger(part.index) || !Number.isInteger(part.total) || part.total < 2 || part.total > 16 || part.index < 0 || part.index >= part.total || !Number.isInteger(part.parity) || part.parity < 0 || part.parity > 255) return {state, outcome:'invalid'};
  if (state && (part.total !== state.total || part.parity !== state.parity)) return {state, outcome:'conflict'};
  const old = state?.parts.get(part.index);
  if (old) return {state, outcome: old.length === part.bytes.length && old.every((byte, i) => byte === part.bytes[i]) ? 'duplicate' : 'conflict'};
  const parts = new Map(state?.parts ?? []);
  parts.set(part.index, part.bytes.slice());
  return {state: { total: part.total, parity: part.parity, parts }, outcome:'accepted'};
}
export function assemble(state: Assembly): { status: 'incomplete' | 'checksum-error' | 'complete'; bytes?: Uint8Array } {
  if (!state || state.parts.size !== state.total) return {status:'incomplete'};
  const pieces = Array.from({length:state.total}, (_, index) => state.parts.get(index));
  if (pieces.some((piece) => !piece)) return {status:'incomplete'};
  const bytes = new Uint8Array(pieces.reduce((n, piece) => n + piece!.length, 0));
  let offset = 0, parity = 0;
  for (const piece of pieces) { bytes.set(piece!, offset); offset += piece!.length; for (const byte of piece!) parity ^= byte; }
  return parity === state.parity ? {status:'complete', bytes} : {status:'checksum-error'};
}
