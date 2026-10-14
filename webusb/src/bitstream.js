// Bit-level helpers for H.264 RBSP data: emulation prevention and Exp-Golomb codes.

/** Remove emulation prevention bytes (00 00 03 -> 00 00). */
export function toRbsp(bytes) {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out[length++] = byte;
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, length);
}

/** Insert emulation prevention bytes so the payload never contains 00 00 0x (x <= 3). */
export function toEbsp(rbsp) {
  const out = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

export class BitstreamError extends Error {}

export class BitReader {
  constructor(bytes, bitOffset = 0) {
    this.bytes = bytes;
    this.position = bitOffset;
  }

  get bitsLeft() {
    return this.bytes.length * 8 - this.position;
  }

  u1() {
    if (this.position >= this.bytes.length * 8) {
      throw new BitstreamError("Read past the end of the RBSP");
    }
    const bit = (this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1;
    this.position += 1;
    return bit;
  }

  u(bits) {
    let value = 0;
    for (let index = 0; index < bits; index += 1) {
      value = value * 2 + this.u1();
    }
    return value;
  }

  ue() {
    let leadingZeros = 0;
    while (this.u1() === 0) {
      leadingZeros += 1;
      if (leadingZeros > 31) {
        throw new BitstreamError("Invalid Exp-Golomb code");
      }
    }
    return 2 ** leadingZeros - 1 + this.u(leadingZeros);
  }

  se() {
    const code = this.ue();
    return code & 1 ? (code + 1) / 2 : code === 0 ? 0 : -code / 2;
  }

  skip(bits) {
    this.position += bits;
  }
}

export class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.used = 0;
  }

  u1(bit) {
    this.current = (this.current << 1) | (bit & 1);
    this.used += 1;
    if (this.used === 8) {
      this.bytes.push(this.current);
      this.current = 0;
      this.used = 0;
    }
  }

  u(bits, value) {
    for (let index = bits - 1; index >= 0; index -= 1) {
      this.u1(Math.floor(value / 2 ** index) & 1);
    }
  }

  ue(value) {
    const code = value + 1;
    const length = Math.floor(Math.log2(code));
    this.u(length, 0);
    this.u(length + 1, code);
  }

  se(value) {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
  }

  /** rbsp_trailing_bits(): a stop bit, then zero bits up to the byte boundary. */
  trailing() {
    this.u1(1);
    while (this.used !== 0) {
      this.u1(0);
    }
  }

  toBytes() {
    if (this.used !== 0) {
      throw new BitstreamError("BitWriter is not byte aligned");
    }
    return Uint8Array.from(this.bytes);
  }
}

/** Overwrite `bits` bits at `bitOffset` in place. */
export function writeBits(bytes, bitOffset, bits, value) {
  for (let index = 0; index < bits; index += 1) {
    const position = bitOffset + index;
    const mask = 1 << (7 - (position & 7));
    const bit = Math.floor(value / 2 ** (bits - 1 - index)) & 1;
    if (bit) {
      bytes[position >> 3] |= mask;
    } else {
      bytes[position >> 3] &= ~mask;
    }
  }
}
