// WebCodecs H.264 decoding and canvas rendering of the latest picture.

export class DecoderError extends Error {}

export class Player {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onError?: (error: Error) => void, onFrame?: (frame: VideoFrame) => void}} hooks
   */
  constructor(canvas, { onError = () => {}, onFrame = () => {} } = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false, desynchronized: true });
    this.onError = onError;
    this.onFrame = onFrame;
    this.decoder = null;
    this.config = null;
    this.hardwareAcceleration = "no-preference";
    this.latest = null;
    this.drawScheduled = false;
    this.framesDecoded = 0;
  }

  get queueSize() {
    return this.decoder?.decodeQueueSize ?? 0;
  }

  get usingSoftware() {
    return this.hardwareAcceleration === "prefer-software";
  }

  async configure(config) {
    this.closeDecoder();
    let candidate = { ...config, hardwareAcceleration: this.hardwareAcceleration };
    let support = await VideoDecoder.isConfigSupported(candidate);
    if (!support.supported && !this.usingSoftware) {
      this.hardwareAcceleration = "prefer-software";
      candidate = { ...config, hardwareAcceleration: this.hardwareAcceleration };
      support = await VideoDecoder.isConfigSupported(candidate);
    }
    if (!support.supported) {
      throw new DecoderError(`This browser cannot decode this H.264 stream (${config.codec}).`);
    }
    this.config = config;
    const decoder = new VideoDecoder({
      output: (frame) => this.output(frame),
      error: (error) => {
        if (this.decoder === decoder) {
          this.decoder = null;
          this.onError(error);
        }
      },
    });
    decoder.configure(support.config);
    this.decoder = decoder;
  }

  /** After a hardware decoder failure, retry with the browser's software decoder. */
  fallBackToSoftware() {
    if (this.usingSoftware) {
      return false;
    }
    this.hardwareAcceleration = "prefer-software";
    return true;
  }

  decode({ type, data, timestamp }) {
    if (!this.decoder || this.decoder.state !== "configured") {
      return false;
    }
    this.decoder.decode(new EncodedVideoChunk({ type, data, timestamp }));
    return true;
  }

  output(frame) {
    this.framesDecoded += 1;
    this.onFrame(frame);
    this.latest?.close(); // Show the newest picture; never build a display backlog.
    this.latest = frame;
    if (!this.drawScheduled) {
      this.drawScheduled = true;
      requestAnimationFrame(() => this.draw());
    }
  }

  draw() {
    this.drawScheduled = false;
    const frame = this.latest;
    if (!frame) {
      return;
    }
    this.latest = null;
    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }
    this.context.drawImage(frame, 0, 0, frame.displayWidth, frame.displayHeight);
    frame.close();
  }

  closeDecoder() {
    const decoder = this.decoder;
    this.decoder = null;
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
  }

  close() {
    this.closeDecoder();
    this.latest?.close();
    this.latest = null;
  }
}
