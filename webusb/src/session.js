// One live view: USB transport -> access units -> WebCodecs -> canvas.

import { Player } from "./player.js";
import { Recorder } from "./recorder.js";
import { VideoStream } from "./stream.js";
import { GogglesUsbError, V2Connection } from "./usb.js";

const FIRST_VIDEO_TIMEOUT_MS = 10_000; // Same bounds as the Python SDK.
const IDLE_TIMEOUT_MS = 5_000;
const MAX_DECODE_BACKLOG = 90; // About 1.5 s at 60 fps: restart instead of lagging.
const DECODER_FAILURE_LIMIT = 5;

export class LiveSession extends EventTarget {
  constructor(canvas, { bootstrap = true } = {}) {
    super();
    this.canvas = canvas;
    this.bootstrap = bootstrap;
    this.connection = null;
    this.recorder = null;
    this.stopped = false;
    this.work = Promise.resolve(); // Decoder actions, applied in order.
    this.decoderFailures = [];
    this.values = {
      usb: ["checking...", false],
      goggles: ["waiting...", false],
      live: ["waiting for video...", false],
    };
    this.meter = { bytes: 0, frames: 0, since: performance.now() };
    this.stats = { fps: 0, mbps: 0, width: 0, height: 0 };
  }

  status(name, text, ready = false) {
    this.values[name] = [text, ready];
    this.dispatchEvent(new CustomEvent("status", { detail: { ...this.values } }));
  }

  note(message) {
    this.dispatchEvent(new CustomEvent("note", { detail: message }));
  }

  fail(error) {
    const detail =
      error instanceof GogglesUsbError
        ? { message: error.message, hint: error.hint }
        : { message: error?.message ?? String(error) };
    this.dispatchEvent(new CustomEvent("failure", { detail }));
    return this.stop();
  }

  async start(device) {
    this.device = device;
    this.status("usb", "plugged in", true);
    this.status("goggles", "opening the video interface...");
    try {
      this.connection = await V2Connection.open(device);
    } catch (error) {
      this.status("goggles", "not available");
      return this.fail(error);
    }
    if (this.stopped) {
      await this.connection.close();
      return;
    }
    this.status("goggles", "connected", true);
    if (this.connection.startTimedOut) {
      this.note("The video start request timed out; still waiting for video.");
    }
    this.stream = new VideoStream({ bootstrap: this.bootstrap });
    this.player = new Player(this.canvas, {
      onError: (error) => this.decoderFailed(error),
      onFrame: (frame) => this.frameDecoded(frame),
    });
    this.startedAt = this.lastDataAt = performance.now();
    this.receivedData = false;
    this.timer = setInterval(() => this.tick(), 500);
    this.connection
      .start((bytes) => this.received(bytes))
      .then(
        () => this.stop(),
        (error) => this.fail(error),
      );
  }

  received(bytes) {
    const timestamp = performance.now() * 1000;
    this.lastDataAt = performance.now();
    this.receivedData = true;
    this.meter.bytes += bytes.length;
    this.recorder?.push(bytes, timestamp);
    for (const action of this.stream.push(bytes, timestamp)) {
      this.work = this.work.then(() => this.apply(action)).catch((error) => this.fail(error));
    }
  }

  async apply(action) {
    if (this.stopped) {
      return;
    }
    if (action.kind === "configure") {
      await this.player.configure(action.config);
      this.status("live", `starting (${action.sps.width}x${action.sps.height})...`);
      return;
    }
    if (this.player.queueSize > MAX_DECODE_BACKLOG) {
      this.note("Decoding fell behind; restarting from the next picture.");
      this.player.closeDecoder();
      this.stream.reset();
      return;
    }
    this.player.decode(action);
  }

  decoderFailed(error) {
    const now = performance.now();
    this.decoderFailures = this.decoderFailures.filter((time) => now - time < 10_000);
    this.decoderFailures.push(now);
    if (this.decoderFailures.length > DECODER_FAILURE_LIMIT) {
      this.fail(new Error(`The video decoder keeps failing: ${error.message}`));
      return;
    }
    if (this.player.fallBackToSoftware()) {
      this.note("The hardware decoder failed; switching to software decoding.");
    } else {
      this.note(`Decoder error (${error.message}); restarting from the next picture.`);
    }
    this.stream.reset(); // The next picture reconfigures and restarts decoding.
  }

  frameDecoded(frame) {
    this.meter.frames += 1;
    this.stats.width = frame.displayWidth;
    this.stats.height = frame.displayHeight;
    if (!this.values.live[1]) {
      this.status("live", `playing (${frame.displayWidth}x${frame.displayHeight})`, true);
    }
  }

  tick() {
    const now = performance.now();
    const seconds = (now - this.meter.since) / 1000;
    if (seconds >= 1) {
      this.stats.fps = this.meter.frames / seconds;
      this.stats.mbps = (this.meter.bytes * 8) / seconds / 1e6;
      this.meter = { bytes: 0, frames: 0, since: now };
      const streamStats = this.stream.stats;
      this.dispatchEvent(
        new CustomEvent("stats", {
          detail: {
            ...this.stats,
            decoder: this.player.usingSoftware ? "software" : "browser default",
            start: streamStats.bootstraps ? "intra refresh (no IDR)" : streamStats.idrFrames ? "IDR" : "-",
            recording: this.recorder ? this.recorder.bytes : null,
            stream: { ...streamStats },
          },
        }),
      );
      if (this.values.live[1]) {
        const rate = this.stats.fps > 0 ? ` - ${this.stats.fps.toFixed(1)} fps` : "";
        this.status("live", `playing (${this.stats.width}x${this.stats.height})${rate}`, true);
      }
    }
    if (!this.receivedData && now - this.startedAt > FIRST_VIDEO_TIMEOUT_MS) {
      this.status(
        "live",
        "no video yet: check the live picture in the goggles, the linked air unit and the USB cable",
      );
    } else if (this.receivedData && now - this.lastDataAt > IDLE_TIMEOUT_MS) {
      this.status("live", "video stopped: check the goggles' live picture; waiting...");
    }
  }

  async startRecording() {
    if (!this.stream || this.recorder) {
      return;
    }
    this.recorder = await Recorder.create(this.stream);
  }

  async stopRecording() {
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      await recorder.stop();
    }
    return recorder;
  }

  async stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearInterval(this.timer);
    try {
      await this.stopRecording();
    } catch (error) {
      this.note(`The recording could not be saved: ${error.message}`);
    }
    await this.connection?.close();
    this.player?.close();
    this.status("live", "stopped");
    this.dispatchEvent(new CustomEvent("stopped"));
  }
}
