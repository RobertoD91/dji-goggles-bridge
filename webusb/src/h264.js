// Minimal H.264 syntax parsing: NAL headers, SPS, PPS and the slice-header prefix.

import { BitReader, toRbsp } from "./bitstream.js";

export const NAL = Object.freeze({
  SLICE: 1,
  IDR: 5,
  SEI: 6,
  SPS: 7,
  PPS: 8,
  AUD: 9,
  END_OF_SEQUENCE: 10,
  END_OF_STREAM: 11,
  FILLER: 12,
});

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

export function nalType(nal) {
  return nal[0] & 0x1f;
}

export function nalRefIdc(nal) {
  return (nal[0] >> 5) & 3;
}

export function isVcl(type) {
  return type >= 1 && type <= 5;
}

function skipScalingList(reader, size) {
  let last = 8;
  let next = 8;
  for (let index = 0; index < size; index += 1) {
    if (next !== 0) {
      next = (last + reader.se() + 256) % 256;
    }
    last = next === 0 ? last : next;
  }
}

export function parseSps(nal) {
  const reader = new BitReader(toRbsp(nal.subarray(1)));
  const sps = {
    profileIdc: reader.u(8),
    constraintFlags: reader.u(8),
    levelIdc: reader.u(8),
    id: reader.ue(),
    chromaFormatIdc: 1,
    separateColourPlane: false,
    bitDepthLuma: 8,
    bitDepthChroma: 8,
  };
  if (HIGH_PROFILES.has(sps.profileIdc)) {
    sps.chromaFormatIdc = reader.ue();
    if (sps.chromaFormatIdc === 3) {
      sps.separateColourPlane = reader.u1() === 1;
    }
    sps.bitDepthLuma = reader.ue() + 8;
    sps.bitDepthChroma = reader.ue() + 8;
    reader.u1(); // qpprime_y_zero_transform_bypass_flag
    if (reader.u1()) {
      const lists = sps.chromaFormatIdc === 3 ? 12 : 8;
      for (let index = 0; index < lists; index += 1) {
        if (reader.u1()) {
          skipScalingList(reader, index < 6 ? 16 : 64);
        }
      }
    }
  }
  sps.log2MaxFrameNum = reader.ue() + 4;
  sps.pocType = reader.ue();
  if (sps.pocType === 0) {
    sps.log2MaxPocLsb = reader.ue() + 4;
  } else if (sps.pocType === 1) {
    sps.deltaPicOrderAlwaysZero = reader.u1() === 1;
    reader.se(); // offset_for_non_ref_pic
    reader.se(); // offset_for_top_to_bottom_field
    const cycle = reader.ue();
    for (let index = 0; index < cycle; index += 1) {
      reader.se();
    }
  }
  sps.maxNumRefFrames = reader.ue();
  sps.gapsInFrameNumAllowed = reader.u1() === 1;
  sps.widthInMbs = reader.ue() + 1;
  sps.heightInMapUnits = reader.ue() + 1;
  sps.frameMbsOnly = reader.u1() === 1;
  sps.mbAdaptiveFrameField = sps.frameMbsOnly ? false : reader.u1() === 1;
  reader.u1(); // direct_8x8_inference_flag
  const crop = { left: 0, right: 0, top: 0, bottom: 0 };
  if (reader.u1()) {
    crop.left = reader.ue();
    crop.right = reader.ue();
    crop.top = reader.ue();
    crop.bottom = reader.ue();
  }
  sps.frameHeightInMbs = (sps.frameMbsOnly ? 1 : 2) * sps.heightInMapUnits;
  const chromaArrayType = sps.separateColourPlane ? 0 : sps.chromaFormatIdc;
  const cropUnitX = chromaArrayType === 0 || chromaArrayType === 3 ? 1 : 2;
  const cropUnitY = (chromaArrayType === 1 ? 2 : 1) * (sps.frameMbsOnly ? 1 : 2);
  sps.chromaArrayType = chromaArrayType;
  sps.codedWidth = sps.widthInMbs * 16;
  sps.codedHeight = sps.frameHeightInMbs * 16;
  sps.width = sps.codedWidth - cropUnitX * (crop.left + crop.right);
  sps.height = sps.codedHeight - cropUnitY * (crop.top + crop.bottom);
  return sps;
}

export function parsePps(nal) {
  const reader = new BitReader(toRbsp(nal.subarray(1)));
  return {
    id: reader.ue(),
    spsId: reader.ue(),
    entropyCodingMode: reader.u1() === 1,
  };
}

/** WebCodecs/RFC 6381 codec string, e.g. avc1.640028. */
export function codecString(sps) {
  const hex = (value) => value.toString(16).padStart(2, "0").toUpperCase();
  return `avc1.${hex(sps.profileIdc)}${hex(sps.constraintFlags)}${hex(sps.levelIdc)}`;
}

/** first_mb_in_slice, read from the start of a slice NAL unit. */
export function firstMbInSlice(nal) {
  return new BitReader(toRbsp(nal.subarray(1, 9))).ue();
}

/**
 * Parse a slice header up to pic_order_cnt_lsb. Bit offsets refer to the RBSP
 * that follows the one-byte NAL header, so callers can rewrite fixed-width fields.
 */
export function parseSliceHeader(rbsp, type, ppsById, spsById) {
  const reader = new BitReader(rbsp);
  const header = {
    firstMb: reader.ue(),
    sliceType: reader.ue(),
    ppsId: reader.ue(),
  };
  const pps = ppsById.get(header.ppsId);
  const sps = pps && spsById.get(pps.spsId);
  if (!sps) {
    return null;
  }
  header.sps = sps;
  if (sps.separateColourPlane) {
    reader.u(2);
  }
  header.frameNumOffset = reader.position;
  header.frameNum = reader.u(sps.log2MaxFrameNum);
  if (!sps.frameMbsOnly && reader.u1()) {
    reader.u1(); // bottom_field_flag
  }
  if (type === NAL.IDR) {
    reader.ue(); // idr_pic_id
  }
  if (sps.pocType === 0) {
    header.pocLsbOffset = reader.position;
    header.pocLsb = reader.u(sps.log2MaxPocLsb);
  }
  return header;
}
