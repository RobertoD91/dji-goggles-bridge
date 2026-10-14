// Turn the raw goggles byte stream into WebCodecs decoder input.
//
// USB read boundaries do not follow NAL or picture boundaries. This module
// splits NAL units, groups them into access units (one picture each), tracks
// parameter sets and decides which access unit can start decoding.

import { AnnexBSplitter, joinAnnexB } from "./annexb.js";
import { BitstreamError, toRbsp } from "./bitstream.js";
import { canBootstrap, SliceRenumberer, syntheticStart, unusedPpsId } from "./bootstrap.js";
import {
  codecString,
  firstMbInSlice,
  isVcl,
  NAL,
  nalType,
  parsePps,
  parseSliceHeader,
  parseSps,
} from "./h264.js";

// NAL unit types that begin a new access unit once the current one has a picture.
const STARTS_ACCESS_UNIT = new Set([NAL.AUD, NAL.SPS, NAL.PPS, NAL.SEI, 14, 15, 16, 17, 18]);
const HEADER_BYTES = 48; // Enough RBSP for the slice-header prefix we parse.

const sameBytes = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);

export class VideoStream {
  /**
   * @param {{bootstrap?: boolean}} options bootstrap: start without an IDR by
   *   inserting a synthetic grey IDR (see bootstrap.js). Otherwise wait for one.
   */
  constructor({ bootstrap = true } = {}) {
    this.bootstrap = bootstrap;
    this.splitter = new AnnexBSplitter();
    this.sps = new Map(); // id -> {nal, info}
    this.pps = new Map(); // id -> {nal, info}
    this.spsInfo = new Map(); // id -> parsed SPS (stable object while bytes are unchanged)
    this.ppsInfo = new Map();
    this.accessUnit = null;
    this.activeSps = null;
    this.needKey = true;
    this.renumberer = null;
    this.lastTimestamp = -Infinity;
    this.stats = {
      bytes: 0,
      nalUnits: 0,
      accessUnits: 0,
      idrFrames: 0,
      bootstraps: 0,
      skippedBeforeKey: 0,
      invalidNalUnits: 0,
    };
  }

  /** Start from another stream's parameter sets, e.g. to record from the middle of a session. */
  adoptParameterSets(other) {
    this.sps = new Map(other.sps);
    this.pps = new Map(other.pps);
    this.spsInfo = new Map(other.spsInfo);
    this.ppsInfo = new Map(other.ppsInfo);
  }

  /** Forget decoder state, e.g. after a decoder error: the next picture reconfigures. */
  reset() {
    this.activeSps = null;
    this.needKey = true;
    this.renumberer = null;
  }

  /**
   * Feed bytes received at `timestamp` (microseconds). Returns decoder actions:
   * {kind: "configure", config, sps} or {kind: "chunk", type, data, timestamp, synthetic}.
   */
  push(bytes, timestamp) {
    this.stats.bytes += bytes.length;
    const actions = [];
    for (const nal of this.splitter.push(bytes)) {
      this.nalUnit(nal, timestamp, actions);
    }
    return actions;
  }

  /** End of stream: emit the final, possibly incomplete, access unit. */
  flush(timestamp) {
    const actions = [];
    const nal = this.splitter.flush();
    if (nal) {
      this.nalUnit(nal, timestamp, actions);
    }
    this.finishAccessUnit(actions);
    return actions;
  }

  nalUnit(nal, timestamp, actions) {
    this.stats.nalUnits += 1;
    if (nal[0] & 0x80) {
      this.stats.invalidNalUnits += 1; // forbidden_zero_bit
      return;
    }
    const type = nalType(nal);
    if (type === NAL.FILLER) {
      return;
    }
    let startsPicture = false;
    if (isVcl(type)) {
      try {
        startsPicture = firstMbInSlice(nal) === 0;
      } catch (error) {
        if (!(error instanceof BitstreamError)) {
          throw error;
        }
        this.stats.invalidNalUnits += 1;
        return;
      }
    }
    if (this.accessUnit?.hasPicture && (STARTS_ACCESS_UNIT.has(type) || startsPicture)) {
      this.finishAccessUnit(actions);
    }
    // Parameter sets apply from here on, after the previous picture is emitted.
    if ((type === NAL.SPS || type === NAL.PPS) && !this.storeParameterSet(type, nal)) {
      return;
    }
    if (!this.accessUnit) {
      this.accessUnit = { nals: [], hasPicture: false, timestamp };
    }
    this.accessUnit.nals.push(nal);
    this.accessUnit.hasPicture ||= isVcl(type);
  }

  storeParameterSet(type, nal) {
    const [table, infoTable, parse] =
      type === NAL.SPS ? [this.sps, this.spsInfo, parseSps] : [this.pps, this.ppsInfo, parsePps];
    let info;
    try {
      info = parse(nal);
    } catch (error) {
      if (!(error instanceof BitstreamError)) {
        throw error;
      }
      this.stats.invalidNalUnits += 1;
      return false;
    }
    const previous = table.get(info.id);
    if (!previous || !sameBytes(previous.nal, nal)) {
      table.set(info.id, { nal, info });
      infoTable.set(info.id, info);
    }
    return true;
  }

  finishAccessUnit(actions) {
    const unit = this.accessUnit;
    this.accessUnit = null;
    if (!unit?.hasPicture) {
      return;
    }
    this.stats.accessUnits += 1;
    const firstSlice = unit.nals.find((nal) => isVcl(nalType(nal)));
    let header;
    try {
      header = parseSliceHeader(
        toRbsp(firstSlice.subarray(1, 1 + HEADER_BYTES)),
        nalType(firstSlice),
        this.ppsInfo,
        this.spsInfo,
      );
    } catch (error) {
      if (!(error instanceof BitstreamError)) {
        throw error;
      }
      this.stats.invalidNalUnits += 1;
      return;
    }
    if (!header) {
      this.stats.skippedBeforeKey += 1; // No SPS/PPS yet.
      return;
    }
    const sps = header.sps;
    if (sps !== this.activeSps) {
      this.activeSps = sps;
      this.needKey = true;
      this.renumberer = null;
      actions.push({
        kind: "configure",
        sps,
        config: {
          codec: codecString(sps),
          codedWidth: sps.codedWidth,
          codedHeight: sps.codedHeight,
          optimizeForLatency: true,
        },
      });
    }
    if (unit.nals.some((nal) => nalType(nal) === NAL.IDR)) {
      this.stats.idrFrames += 1;
      this.needKey = false;
      this.renumberer = null;
      const data = this.withParameterSets(unit.nals, sps);
      actions.push(chunk("key", data, this.nextTimestamp(unit.timestamp)));
      return;
    }
    let nals = unit.nals;
    if (this.needKey) {
      if (!this.bootstrap || !canBootstrap(sps)) {
        this.stats.skippedBeforeKey += 1;
        return;
      }
      const start = syntheticStart(sps, unusedPpsId(new Set(this.pps.keys())));
      const parameterSets = [this.sps.get(sps.id).nal, ...this.ppsFor(sps).map((entry) => entry.nal)];
      start.pictures.forEach((picture, index) => {
        const nals = index === 0 ? [...parameterSets, ...picture] : picture;
        actions.push(chunk(index === 0 ? "key" : "delta", nals, this.nextTimestamp(unit.timestamp), true));
      });
      this.stats.bootstraps += 1;
      this.needKey = false;
      this.renumberer = new SliceRenumberer(header, start);
    }
    if (this.renumberer) {
      const rewritten = [];
      for (const nal of nals) {
        const slice = isVcl(nalType(nal)) ? this.renumberer.rewrite(nal, this.ppsInfo, this.spsInfo) : nal;
        if (!slice) {
          this.reset(); // Slices switched SPS without an IDR; restart cleanly.
          this.stats.skippedBeforeKey += 1;
          return;
        }
        rewritten.push(slice);
      }
      nals = rewritten;
    }
    actions.push(chunk("delta", nals, this.nextTimestamp(unit.timestamp)));
  }

  /** Decoder timestamps must increase, even for pictures that arrive in one USB read. */
  nextTimestamp(arrival) {
    this.lastTimestamp = Math.max(arrival, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  ppsFor(sps) {
    return [...this.pps.values()].filter((entry) => entry.info.spsId === sps.id);
  }

  /** Key chunks carry their SPS/PPS; DJI headsets may send them only occasionally. */
  withParameterSets(nals, sps) {
    const types = new Set(nals.map(nalType));
    const parameterSets = [];
    if (!types.has(NAL.SPS)) {
      parameterSets.push(this.sps.get(sps.id).nal);
    }
    if (!types.has(NAL.PPS)) {
      parameterSets.push(...this.ppsFor(sps).map((entry) => entry.nal));
    }
    const leading = types.has(NAL.AUD) && nalType(nals[0]) === NAL.AUD ? 1 : 0;
    return [...nals.slice(0, leading), ...parameterSets, ...nals.slice(leading)];
  }
}

function chunk(type, nals, timestamp, synthetic = false) {
  return { kind: "chunk", type, data: joinAnnexB(nals), timestamp, synthetic };
}
