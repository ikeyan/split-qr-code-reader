import { createVideoDecoder } from "./decoder.ts";
import type { ScanMode } from "./scan.ts";

let decode = createVideoDecoder(), queue = Promise.resolve();
globalThis.onmessage = (event: MessageEvent) => {
  const request = event.data as {
    id: number;
    reset?: boolean;
    image?: ImageData;
    mode?: ScanMode;
  };
  queue = queue.then(async () => {
    try {
      if (request.reset) {
        decode = createVideoDecoder();
        globalThis.postMessage({ id: request.id, codes: [] });
        return;
      }
      const image = request.image!;
      const codes = await decode(
        new ImageData(image.data, image.width, image.height),
        request.mode ?? "auto",
      );
      globalThis.postMessage({ id: request.id, codes });
    } catch (error) {
      globalThis.postMessage({ id: request.id, error: String(error) });
    }
  });
};
