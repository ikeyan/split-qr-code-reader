import { strict as assert } from "node:assert";
import {
  CameraRecording,
  type RecordingPhase,
} from "../src/camera-recording.ts";

class FakeRecorder {
  state: RecordingState = "inactive";
  mimeType = "video/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  starts = 0;
  stops = 0;
  failStart = false;
  failStop = false;
  start() {
    if (this.failStart) throw new Error("start failed");
    this.starts++;
    this.state = "recording";
  }
  stop() {
    if (this.failStop) throw new Error("stop failed");
    this.stops++;
    this.state = "inactive";
  }
  chunk(text: string) {
    this.ondataavailable?.({ data: new Blob([text], { type: this.mimeType }) });
  }
  finish() {
    this.state = "inactive";
    this.onstop?.();
  }
}
function setup() {
  const recorder = new FakeRecorder(),
    phases: RecordingPhase[] = [],
    saved: Blob[] = [];
  let errors = 0, creates = 0, failCreate = false;
  const recording = new CameraRecording({
    create: () => {
      creates++;
      if (failCreate) throw new Error("unavailable");
      return recorder as unknown as MediaRecorder;
    },
    state: (phase) => phases.push(phase),
    save: (blob) => saved.push(blob),
    error: () => errors++,
  });
  return {
    recorder,
    recording,
    phases,
    saved,
    errors: () => errors,
    creates: () => creates,
    failCreate: (value: boolean) => {
      failCreate = value;
    },
  };
}
const stream = {} as MediaStream;

Deno.test("recording waits for the final chunk and saves once before allowing another recording", async () => {
  const s = setup();
  s.recording.start(stream);
  s.recording.start(stream);
  assert.equal(s.creates(), 1);
  s.recorder.chunk("first");
  s.recorder.chunk("");
  s.recording.stop();
  s.recording.stop();
  s.recording.start(stream);
  assert.equal(s.recorder.stops, 1);
  assert.equal(s.creates(), 1);
  assert.equal(s.saved.length, 0);
  assert.equal(s.phases.at(-1), "stopping");
  s.recorder.chunk("final");
  s.recorder.finish();
  s.recorder.finish();
  assert.equal(s.saved.length, 1);
  assert.equal(await s.saved[0].text(), "firstfinal");
  assert.equal(s.saved[0].type, "video/webm");
  assert.equal(s.phases.at(-1), "idle");
  s.recording.start(stream);
  assert.equal(s.recorder.starts, 2);
  assert.equal(s.errors(), 0);
});

Deno.test("creation and start failures leave recording usable for a retry", () => {
  const s = setup();
  s.failCreate(true);
  s.recording.start(stream);
  assert.equal(s.errors(), 1);
  assert.equal(s.saved.length, 0);
  s.failCreate(false);
  s.recorder.failStart = true;
  s.recording.start(stream);
  assert.equal(s.errors(), 2);
  assert.equal(s.phases.at(-1), "idle");
  s.recorder.failStart = false;
  s.recording.start(stream);
  assert.equal(s.phases.at(-1), "recording");
});

Deno.test("an automatically ended stream saves its data and empty recordings are rejected", async () => {
  const s = setup();
  s.recording.start(stream);
  s.recorder.chunk("ended");
  s.recorder.finish();
  assert.equal(await s.saved[0].text(), "ended");
  assert.equal(s.phases.at(-1), "idle");
  s.recording.start(stream);
  s.recorder.chunk("");
  s.recorder.finish();
  assert.equal(s.saved.length, 1);
  assert.equal(s.errors(), 1);
  assert.equal(s.phases.at(-1), "idle");
});

Deno.test("recording errors stop capture, preserve final data, and release a failed stop for retry", async () => {
  const s = setup();
  s.recording.start(stream);
  s.recorder.chunk("partial");
  s.recorder.onerror?.();
  assert.equal(s.recorder.stops, 1);
  assert.equal(s.errors(), 1);
  s.recorder.chunk("tail");
  s.recorder.finish();
  assert.equal(await s.saved[0].text(), "partialtail");
  s.recording.start(stream);
  s.recorder.failStop = true;
  s.recording.stop();
  assert.equal(s.errors(), 2);
  assert.equal(s.phases.at(-1), "idle");
  s.recorder.failStop = false;
  s.recording.start(stream);
  assert.equal(s.phases.at(-1), "recording");
});
