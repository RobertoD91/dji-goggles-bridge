// Start decoding a stream that has no IDR picture.
//
// DJI live video can run without conventional IDR keyframes (PROTOCOL.md,
// "H.264 decoding"). The native SDK sets FFmpeg's SHOW_ALL flag; WebCodecs has
// no equivalent and Chrome rejects a "key" chunk that is not an IDR. Instead,
// we insert a valid, mid-grey IDR picture built from the stream's own SPS (plus
// grey P_Skip copies that fill the remaining reference frames) and renumber
// the following slices so they continue from it. P slices then predict from
// grey, like SHOW_ALL's missing references, and the stream's intra refresh
// progressively restores the picture.

import { BitWriter, toEbsp, toRbsp, writeBits } from "./bitstream.js";
import { NAL, parseSliceHeader } from "./h264.js";

const NAL_REF_IDC = 3 << 5;

/** Bootstrapping needs inter prediction and a single colour plane. */
export function canBootstrap(sps) {
  return !sps.separateColourPlane && sps.maxNumRefFrames > 0;
}

/** Choose a PPS ID that the stream has not used, so its own PPSs stay untouched. */
export function unusedPpsId(usedIds) {
  for (let id = 255; id >= 0; id -= 1) {
    if (!usedIds.has(id)) {
      return id;
    }
  }
  return null;
}

/** A CAVLC picture parameter set that only the synthetic IDR slice refers to. */
export function syntheticPps(ppsId, spsId) {
  const bits = new BitWriter();
  bits.ue(ppsId);
  bits.ue(spsId);
  bits.u1(0); // entropy_coding_mode_flag: CAVLC
  bits.u1(0); // bottom_field_pic_order_in_frame_present_flag
  bits.ue(0); // num_slice_groups_minus1
  bits.ue(0); // num_ref_idx_l0_default_active_minus1
  bits.ue(0); // num_ref_idx_l1_default_active_minus1
  bits.u1(0); // weighted_pred_flag
  bits.u(2, 0); // weighted_bipred_idc
  bits.se(0); // pic_init_qp_minus26
  bits.se(0); // pic_init_qs_minus26
  bits.se(0); // chroma_qp_index_offset
  bits.u1(1); // deblocking_filter_control_present_flag
  bits.u1(0); // constrained_intra_pred_flag
  bits.u1(0); // redundant_pic_cnt_present_flag
  bits.trailing();
  return withHeader(NAL_REF_IDC | NAL.PPS, bits.toBytes());
}

/**
 * One IDR I slice covering the whole frame. Every macroblock is I_16x16 with DC
 * prediction and no residual, which decodes to uniform mid-grey (1 << (bitDepth - 1)).
 */
export function syntheticIdr(sps, ppsId) {
  const bits = new BitWriter();
  bits.ue(0); // first_mb_in_slice
  bits.ue(7); // slice_type: I (all slices of the picture)
  bits.ue(ppsId);
  bits.u(sps.log2MaxFrameNum, 0); // frame_num is 0 for an IDR picture
  if (!sps.frameMbsOnly) {
    bits.u1(0); // field_pic_flag: a frame (MBAFF frame if enabled)
  }
  bits.ue(0); // idr_pic_id
  if (sps.pocType === 0) {
    bits.u(sps.log2MaxPocLsb, 0);
  } else if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) {
    bits.se(0); // delta_pic_order_cnt[0]
  }
  bits.u1(0); // no_output_of_prior_pics_flag
  bits.u1(0); // long_term_reference_flag
  bits.se(0); // slice_qp_delta
  bits.ue(1); // disable_deblocking_filter_idc: the picture is flat anyway

  const macroblocks = sps.widthInMbs * sps.frameHeightInMbs;
  for (let address = 0; address < macroblocks; address += 1) {
    if (sps.mbAdaptiveFrameField && address % 2 === 0) {
      bits.u1(0); // mb_field_decoding_flag of each macroblock pair
    }
    bits.ue(3); // mb_type I_16x16_2_0_0: DC prediction, no coded luma/chroma blocks
    if (sps.chromaArrayType === 1 || sps.chromaArrayType === 2) {
      bits.ue(0); // intra_chroma_pred_mode: DC
    }
    bits.se(0); // mb_qp_delta
    // Intra16x16DCLevel is always coded: coeff_token "1" = no coefficients
    // (nC is 0 because no neighbouring block has coefficients). 4:4:4 also
    // codes Cb and Cr like luma.
    const dcBlocks = sps.chromaArrayType === 3 ? 3 : 1;
    for (let block = 0; block < dcBlocks; block += 1) {
      bits.u1(1);
    }
  }
  bits.trailing();
  return withHeader(NAL_REF_IDC | NAL.IDR, bits.toBytes());
}

/**
 * A P picture whose macroblocks are all P_Skip: a copy of the grey IDR. These
 * fill every reference slot, so later slices that refer to older pictures or
 * mark them unused (MMCO) find real pictures instead of missing ones.
 */
export function syntheticSkip(sps, ppsId, frameNum, pocLsb) {
  const bits = new BitWriter();
  bits.ue(0); // first_mb_in_slice
  bits.ue(5); // slice_type: P (all slices of the picture)
  bits.ue(ppsId);
  bits.u(sps.log2MaxFrameNum, frameNum);
  if (!sps.frameMbsOnly) {
    bits.u1(0); // field_pic_flag
  }
  if (sps.pocType === 0) {
    bits.u(sps.log2MaxPocLsb, pocLsb);
  } else if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) {
    bits.se(0); // delta_pic_order_cnt[0]
  }
  bits.u1(0); // num_ref_idx_active_override_flag: one reference (PPS default)
  bits.u1(0); // ref_pic_list_modification_flag_l0
  bits.u1(0); // adaptive_ref_pic_marking_mode_flag: sliding window
  bits.se(0); // slice_qp_delta
  bits.ue(1); // disable_deblocking_filter_idc
  bits.ue(sps.widthInMbs * sps.frameHeightInMbs); // mb_skip_run: the whole picture
  bits.trailing();
  return withHeader(NAL_REF_IDC | NAL.SLICE, bits.toBytes());
}

/**
 * The synthetic pictures that start decoding: an IDR, then P_Skip copies until
 * the SPS's reference frames are all in use. Returns NAL units per picture and
 * where the stream's own numbering must continue.
 */
export function syntheticStart(sps, ppsId) {
  const fillers = Math.min(Math.max(sps.maxNumRefFrames - 1, 0), 15);
  const maxPocLsb = sps.pocType === 0 ? 2 ** sps.log2MaxPocLsb : 0;
  const pictures = [[syntheticPps(ppsId, sps.id), syntheticIdr(sps, ppsId)]];
  for (let index = 1; index <= fillers; index += 1) {
    const pocLsb = maxPocLsb ? (2 * index) % maxPocLsb : 0;
    pictures.push([syntheticSkip(sps, ppsId, index, pocLsb)]);
  }
  return {
    pictures,
    nextFrameNum: fillers + 1,
    // Leave a little room below the stream's first picture for any reordering.
    nextPocLsb: maxPocLsb ? (2 * fillers + Math.min(16, maxPocLsb / 4)) % maxPocLsb : 0,
  };
}

function withHeader(header, rbsp) {
  const payload = toEbsp(rbsp);
  const nal = new Uint8Array(payload.length + 1);
  nal[0] = header;
  nal.set(payload, 1);
  return nal;
}

/**
 * Renumber the non-IDR slices that follow the synthetic pictures: frame_num
 * continues without a gap and POC stays after them. Both fields have a fixed
 * width, so only their bits change; emulation prevention is recomputed.
 */
export class SliceRenumberer {
  constructor(firstHeader, { nextFrameNum = 1, nextPocLsb = 0 } = {}) {
    const sps = firstHeader.sps;
    this.sps = sps;
    this.maxFrameNum = 2 ** sps.log2MaxFrameNum;
    this.frameNumShift = mod(nextFrameNum - firstHeader.frameNum, this.maxFrameNum);
    if (sps.pocType === 0) {
      this.maxPocLsb = 2 ** sps.log2MaxPocLsb;
      this.pocShift = mod(nextPocLsb - firstHeader.pocLsb, this.maxPocLsb);
    }
  }

  rewrite(nal, ppsById, spsById) {
    const rbsp = toRbsp(nal.subarray(1));
    const header = parseSliceHeader(rbsp, nal[0] & 0x1f, ppsById, spsById);
    if (!header || header.sps !== this.sps) {
      return null; // A different SPS needs a new key frame.
    }
    writeBits(
      rbsp,
      header.frameNumOffset,
      this.sps.log2MaxFrameNum,
      mod(header.frameNum + this.frameNumShift, this.maxFrameNum),
    );
    if (this.sps.pocType === 0) {
      writeBits(
        rbsp,
        header.pocLsbOffset,
        this.sps.log2MaxPocLsb,
        mod(header.pocLsb + this.pocShift, this.maxPocLsb),
      );
    }
    return withHeader(nal[0], rbsp);
  }
}

function mod(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}
