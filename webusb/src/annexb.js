// Incremental Annex B splitter: USB reads can end anywhere inside a NAL unit.

export const START_CODE = Uint8Array.of(0, 0, 0, 1);

export class AnnexBSplitter {
  constructor() {
    this.buffer = new Uint8Array(0);
    this.scanFrom = 0; // Bytes before this offset contain no unseen start code.
    this.nalStart = -1; // Payload offset of the NAL unit being collected.
  }

  /** Append bytes and return every NAL unit completed by them (without start codes). */
  push(chunk) {
    const merged = new Uint8Array(this.buffer.length + chunk.length);
    merged.set(this.buffer);
    merged.set(chunk, this.buffer.length);
    this.buffer = merged;

    const nals = [];
    const data = this.buffer;
    let index = Math.max(this.scanFrom, 0);
    while (index + 2 < data.length) {
      if (data[index + 2] > 1) {
        index += 3;
      } else if (data[index] === 0 && data[index + 1] === 0 && data[index + 2] === 1) {
        if (this.nalStart >= 0) {
          const nal = trimTrailingZeros(data.subarray(this.nalStart, index));
          if (nal.length) {
            nals.push(nal.slice());
          }
        }
        this.nalStart = index + 3;
        index += 3;
      } else {
        index += 1;
      }
    }
    // Keep the open NAL unit (or, before the first start code, only a possible
    // partial start code). The scan resumes where it stopped: the last two
    // unchecked positions can still begin a start code split across reads.
    const keepFrom = this.nalStart >= 0 ? this.nalStart : Math.max(0, data.length - 2);
    this.buffer = data.slice(keepFrom);
    this.scanFrom = Math.max(0, index - keepFrom);
    if (this.nalStart >= 0) {
      this.nalStart = 0;
    }
    return nals;
  }

  /** Return the final NAL unit at the end of a stream. */
  flush() {
    let nal = null;
    if (this.nalStart >= 0) {
      const tail = trimTrailingZeros(this.buffer.subarray(this.nalStart));
      nal = tail.length ? tail.slice() : null;
    }
    this.buffer = new Uint8Array(0);
    this.scanFrom = 0;
    this.nalStart = -1;
    return nal;
  }
}

function trimTrailingZeros(nal) {
  // A NAL unit ends with its RBSP stop bit, so trailing zero bytes belong to
  // the next four-byte start code or to trailing_zero_8bits.
  let end = nal.length;
  while (end > 0 && nal[end - 1] === 0) {
    end -= 1;
  }
  return nal.subarray(0, end);
}

/** Serialize NAL units as an Annex B byte stream with four-byte start codes. */
export function joinAnnexB(nals) {
  const size = nals.reduce((total, nal) => total + START_CODE.length + nal.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const nal of nals) {
    out.set(START_CODE, offset);
    out.set(nal, offset + START_CODE.length);
    offset += START_CODE.length + nal.length;
  }
  return out;
}
