import {accept, assemble, type Assembly, type Outcome, type Part} from './assemble.ts';

export type PartUpdate = {
  state: Assembly;
  outcome: Outcome;
  status: 'incomplete' | 'checksum-error' | 'complete';
  bytes?: Uint8Array;
};

/** Calculate the entire transition before any camera or UI side effects. */
export function takePart(state: Assembly, part: Part, onComplete: () => void): PartUpdate {
  const decision = accept(state, part);
  const assembled = assemble(decision.state);
  if (decision.outcome === 'accepted' && assembled.status === 'complete') onComplete();
  return {...decision, ...assembled};
}
