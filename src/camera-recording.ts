export type RecordingPhase = "idle" | "recording" | "stopping";
type Recorder = Pick<
  MediaRecorder,
  | "state"
  | "mimeType"
  | "start"
  | "stop"
  | "ondataavailable"
  | "onstop"
  | "onerror"
>;

export function createCameraRecorder(stream: MediaStream): Recorder {
  const tracks = stream.getVideoTracks().filter((track) =>
    track.readyState === "live"
  );
  if (!tracks.length) throw new Error("No live camera track");
  const mimeType = ["video/webm;codecs=vp8", "video/mp4", "video/webm"].find(
    (type) => MediaRecorder.isTypeSupported(type),
  );
  return new MediaRecorder(
    new MediaStream(tracks),
    mimeType ? { mimeType } : undefined,
  );
}

/** Keep the recorder until its final dataavailable event has been flushed. */
export class CameraRecording {
  private recorder: Recorder | undefined;
  private phase: RecordingPhase = "idle";
  constructor(
    private host: {
      create: (stream: MediaStream) => Recorder;
      state: (phase: RecordingPhase) => void;
      save: (blob: Blob) => void;
      error: () => void;
    },
  ) {}

  start(stream: MediaStream): void {
    if (this.recorder) return;
    let recorder: Recorder;
    try {
      recorder = this.host.create(stream);
    } catch {
      this.host.error();
      return;
    }
    const chunks: Blob[] = [];
    const finish = () => {
      if (this.recorder !== recorder) return;
      this.recorder = undefined;
      this.setPhase("idle");
      if (chunks.length) {
        try {
          this.host.save(
            new Blob(chunks, { type: recorder.mimeType || chunks[0].type }),
          );
        } catch {
          this.host.error();
        }
      } else this.host.error();
    };
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onstop = finish;
    recorder.onerror = () => {
      this.host.error();
      this.stop();
    };
    this.recorder = recorder;
    try {
      recorder.start(1000);
      this.setPhase("recording");
    } catch {
      this.recorder = undefined;
      this.setPhase("idle");
      this.host.error();
    }
  }

  stop(): void {
    const recorder = this.recorder;
    if (!recorder || this.phase === "stopping") return;
    this.setPhase("stopping");
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      this.recorder = undefined;
      this.setPhase("idle");
      this.host.error();
    }
  }

  private setPhase(phase: RecordingPhase) {
    this.phase = phase;
    this.host.state(phase);
  }
}

export function recordingFilename(
  mimeType: string,
  commit: string,
  date = new Date(),
): string {
  const stamp =
    [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n, i) =>
      String(n).padStart(i ? 2 : 4, "0")
    ).join("") + "-" +
    [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) =>
      String(n).padStart(2, "0")
    ).join("");
  const extension = mimeType.toLowerCase().startsWith("video/mp4")
    ? "mp4"
    : "webm";
  return `qr-camera-${commit.slice(0, 12)}-${stamp}.${extension}`;
}
