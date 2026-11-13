import type { ReadResult } from "zxing-wasm/reader";
import { createVideoDecoder } from "./decoder.ts";
import type { ScanMode } from "./scan.ts";

/** One worker is loaded with the page; frames and decoding data stay on the device. */
export class CameraDecoder {
  private worker: Worker | undefined;
  private fallback = createVideoDecoder();
  private next = 0;
  private requests = new Map<
    number,
    { resolve: (codes: ReadResult[]) => void; reject: (error: Error) => void }
  >();
  constructor() {
    if (typeof Worker === "undefined") return;
    try {
      const url = new URL("./camera-worker.js", document.baseURI);
      url.searchParams.set(
        "v",
        document.querySelector<HTMLMetaElement>('meta[name="build-commit"]')
          ?.content ?? "dev",
      );
      this.worker = new Worker(url, { type: "module" });
      this.worker.onmessage = (event: MessageEvent) => {
        const request = this.requests.get(event.data.id);
        if (!request) return;
        this.requests.delete(event.data.id);
        if (event.data.error) request.reject(new Error(event.data.error));
        else request.resolve(event.data.codes);
      };
      this.worker.onerror = () => {
        this.worker?.terminate();
        this.worker = undefined;
        for (const request of this.requests.values()) {
          request.reject(new Error("Camera decoder worker failed"));
        }
        this.requests.clear();
      };
    } catch {
      this.worker = undefined;
    }
  }
  private request(
    message: object,
    transfer: Transferable[] = [],
  ): Promise<ReadResult[]> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try {
        this.worker!.postMessage({ ...message, id }, transfer);
      } catch (error) {
        this.requests.delete(id);
        reject(error);
      }
    });
  }
  async reset(): Promise<void> {
    this.fallback = createVideoDecoder();
    if (this.worker) {
      try {
        await this.request({ reset: true });
      } catch {
        this.worker?.terminate();
        this.worker = undefined;
      }
    }
  }
  scan(image: ImageData, mode: ScanMode): Promise<ReadResult[]> {
    return this.worker
      ? this.request({ image, mode }, [image.data.buffer])
      : this.fallback(image, mode);
  }
  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    for (const request of this.requests.values()) {
      request.reject(new Error("Camera decoder closed"));
    }
    this.requests.clear();
  }
}
