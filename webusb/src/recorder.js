// Save the live view as an Annex B .h264 file that ordinary players can open.
//
// The file is the decoder input of an independent VideoStream: it starts at a
// key picture (a synthetic grey IDR if the goggles send none), so VLC, ffplay
// or ffmpeg don't need special flags to show it.

import { VideoStream } from "./stream.js";

function fileName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `dji-goggles-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.h264`
  );
}

export class Recorder {
  constructor(name, writable, source) {
    this.name = name;
    this.writable = writable; // FileSystemWritableFileStream, or null to download at the end
    this.parts = [];
    this.bytes = 0;
    this.writing = Promise.resolve();
    this.error = null;
    this.stream = new VideoStream();
    this.stream.adoptParameterSets(source);
  }

  /** Ask where to save when the browser supports it; otherwise keep the file in memory. */
  static async create(source) {
    const name = fileName();
    let writable = null;
    if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: "H.264 video", accept: { "video/h264": [".h264"] } }],
      });
      writable = await handle.createWritable();
    }
    return new Recorder(name, writable, source);
  }

  push(bytes, timestamp) {
    for (const action of this.stream.push(bytes, timestamp)) {
      if (action.kind === "chunk") {
        this.write(action.data);
      }
    }
  }

  write(data) {
    this.bytes += data.length;
    if (!this.writable) {
      this.parts.push(data);
      return;
    }
    this.writing = this.writing
      .then(() => this.writable.write(data))
      .catch((error) => {
        this.error ??= error;
      });
  }

  async stop() {
    for (const action of this.stream.flush(performance.now() * 1000)) {
      if (action.kind === "chunk") {
        this.write(action.data);
      }
    }
    if (this.writable) {
      await this.writing;
      await this.writable.close();
      if (this.error) {
        throw this.error;
      }
      return;
    }
    const url = URL.createObjectURL(new Blob(this.parts, { type: "video/h264" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: this.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    this.parts = [];
  }
}
