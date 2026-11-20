import { GpuNetworks, type NeuralRunner } from "./nn-runtime.ts";
let pending: Promise<NeuralRunner | undefined> | undefined;
let available: boolean | undefined;
const listeners = new Set<(available: boolean | undefined) => void>();
function publish(value: boolean) {
  available = value;
  listeners.forEach((listener) => listener(value));
}
export function neuralStatus(
  listener: (available: boolean | undefined) => void,
): () => void {
  listeners.add(listener);
  listener(available);
  void neuralRunner();
  return () => listeners.delete(listener);
}
export function neuralRunner(): Promise<NeuralRunner | undefined> {
  return pending ??= GpuNetworks.create().then((runner) => {
    publish(!!runner);
    if (runner) void runner.lost.then(disableNeural);
    return runner;
  });
}
export function disableNeural() {
  pending = Promise.resolve(undefined);
  publish(false);
}
