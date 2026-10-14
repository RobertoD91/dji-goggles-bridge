import assert from "node:assert/strict";
import { test } from "node:test";

import { BitReader, toRbsp } from "../src/bitstream.js";
import {
  SliceRenumberer,
  syntheticIdr,
  syntheticPps,
  syntheticSkip,
  syntheticStart,
  unusedPpsId,
} from "../src/bootstrap.js";
import { nalType, parsePps } from "../src/h264.js";
import { fixtureSyntax } from "./helpers.mjs";

const baseSps = {
  id: 0,
  log2MaxFrameNum: 4,
  pocType: 0,
  log2MaxPocLsb: 6,
  frameMbsOnly: true,
  mbAdaptiveFrameField: false,
  separateColourPlane: false,
  chromaArrayType: 1,
  widthInMbs: 3,
  frameHeightInMbs: 2,
  maxNumRefFrames: 1,
};

/** Read the slice header fields shared by our I and P slices. */
function readHeader(reader, sps, { sliceType, ppsId, frameNum, pocLsb, idr }) {
  assert.equal(reader.ue(), 0, "first_mb_in_slice");
  assert.equal(reader.ue(), sliceType);
  assert.equal(reader.ue(), ppsId);
  assert.equal(reader.u(sps.log2MaxFrameNum), frameNum, "frame_num");
  if (!sps.frameMbsOnly) assert.equal(reader.u1(), 0, "field_pic_flag");
  if (idr) assert.equal(reader.ue(), 0, "idr_pic_id");
  if (sps.pocType === 0) assert.equal(reader.u(sps.log2MaxPocLsb), pocLsb);
  if (sps.pocType === 1 && !sps.deltaPicOrderAlwaysZero) assert.equal(reader.se(), 0);
}

function readTrailing(reader) {
  assert.equal(reader.u1(), 1, "rbsp_stop_one_bit");
  assert.ok(reader.bitsLeft < 8, "only alignment bits remain");
  assert.equal(reader.u(reader.bitsLeft), 0);
}

/** Parse our own I slice back, following the H.264 syntax for these SPS fields. */
function readSyntheticIdr(nal, sps, ppsId) {
  assert.equal(nal[0], 0x65, "nal_ref_idc 3, IDR");
  const reader = new BitReader(toRbsp(nal.subarray(1)));
  readHeader(reader, sps, { sliceType: 7, ppsId, frameNum: 0, pocLsb: 0, idr: true });
  assert.deepEqual([reader.u1(), reader.u1()], [0, 0], "dec_ref_pic_marking");
  assert.equal(reader.se(), 0, "slice_qp_delta");
  assert.equal(reader.ue(), 1, "deblocking disabled");
  for (let mb = 0; mb < sps.widthInMbs * sps.frameHeightInMbs; mb += 1) {
    if (sps.mbAdaptiveFrameField && mb % 2 === 0) assert.equal(reader.u1(), 0);
    assert.equal(reader.ue(), 3, "I_16x16_2_0_0");
    if (sps.chromaArrayType === 1 || sps.chromaArrayType === 2) assert.equal(reader.ue(), 0);
    assert.equal(reader.se(), 0, "mb_qp_delta");
    for (let block = 0; block < (sps.chromaArrayType === 3 ? 3 : 1); block += 1) {
      assert.equal(reader.u1(), 1, "coeff_token: no DC coefficients");
    }
  }
  readTrailing(reader);
}

function readSyntheticSkip(nal, sps, ppsId, frameNum, pocLsb) {
  assert.equal(nal[0], 0x61, "nal_ref_idc 3, non-IDR slice");
  const reader = new BitReader(toRbsp(nal.subarray(1)));
  readHeader(reader, sps, { sliceType: 5, ppsId, frameNum, pocLsb, idr: false });
  assert.deepEqual([reader.u1(), reader.u1(), reader.u1()], [0, 0, 0], "defaults, sliding window");
  assert.equal(reader.se(), 0, "slice_qp_delta");
  assert.equal(reader.ue(), 1, "deblocking disabled");
  assert.equal(reader.ue(), sps.widthInMbs * sps.frameHeightInMbs, "mb_skip_run");
  readTrailing(reader);
}

const LAYOUTS = [
  baseSps,
  { ...baseSps, chromaArrayType: 0 },
  { ...baseSps, chromaArrayType: 2 },
  { ...baseSps, chromaArrayType: 3 },
  { ...baseSps, pocType: 2 },
  { ...baseSps, pocType: 1, deltaPicOrderAlwaysZero: false },
  { ...baseSps, frameMbsOnly: false, mbAdaptiveFrameField: true, frameHeightInMbs: 4 },
];

test("synthetic PPS is CAVLC and refers to the stream's SPS", () => {
  const nal = syntheticPps(255, 3);
  assert.equal(nalType(nal), 8);
  assert.deepEqual(parsePps(nal), { id: 255, spsId: 3, entropyCodingMode: false });
});

test("synthetic IDR and P_Skip slices follow the syntax for each frame layout", () => {
  for (const sps of LAYOUTS) {
    readSyntheticIdr(syntheticIdr(sps, 7), sps, 7);
    readSyntheticSkip(syntheticSkip(sps, 7, 3, 6), sps, 7, 3, 6);
  }
});

test("a 1440x808 synthetic IDR stays small", () => {
  const sps = { ...baseSps, widthInMbs: 90, frameHeightInMbs: 51 };
  const nal = syntheticIdr(sps, 255);
  readSyntheticIdr(nal, sps, 255);
  assert.ok(nal.length < 4700, `${nal.length} bytes: about one byte per macroblock`);
});

test("synthetic start fills every reference frame, then hands over numbering", () => {
  const sps = { ...baseSps, maxNumRefFrames: 4 };
  const start = syntheticStart(sps, 9);
  assert.equal(start.pictures.length, 4);
  assert.deepEqual(start.pictures[0].map(nalType), [8, 5]);
  start.pictures.slice(1).forEach(([nal], index) => {
    readSyntheticSkip(nal, sps, 9, index + 1, 2 * (index + 1));
  });
  assert.equal(start.nextFrameNum, 4);
  assert.equal(start.nextPocLsb, 6 + 16);

  const single = syntheticStart({ ...baseSps, log2MaxPocLsb: 4 }, 9);
  assert.equal(single.pictures.length, 1);
  assert.deepEqual([single.nextFrameNum, single.nextPocLsb], [1, 4]);
});

test("unusedPpsId avoids the stream's PPS IDs", () => {
  assert.equal(unusedPpsId(new Set([0])), 255);
  assert.equal(unusedPpsId(new Set([0, 255, 254])), 253);
  assert.equal(unusedPpsId(new Set(Array.from({ length: 256 }, (_, id) => id))), null);
});

for (const name of ["gdr-cut.h264", "bframes-gdr-cut.h264"]) {
  test(`renumbering ${name} continues after the synthetic pictures and keeps slice data`, () => {
    const { nals, sps, ppsById, spsById, header } = fixtureSyntax(name);
    const slices = nals.filter((nal) => nalType(nal) === 1);
    const original = slices.map(header);
    const renumberer = new SliceRenumberer(original[0], { nextFrameNum: 3, nextPocLsb: 20 });
    const rewritten = slices.map((nal) => renumberer.rewrite(nal, ppsById, spsById));
    const headers = rewritten.map(header);
    const maxFrameNum = 2 ** sps.log2MaxFrameNum;
    assert.equal(headers[0].frameNum, 3);
    if (sps.pocType === 0) {
      assert.equal(headers[0].pocLsb, 20 % 2 ** sps.log2MaxPocLsb);
    }
    const end = (h) =>
      sps.pocType === 0 ? h.pocLsbOffset + sps.log2MaxPocLsb : h.frameNumOffset + sps.log2MaxFrameNum;
    const tail = (nal, h) => {
      const reader = new BitReader(toRbsp(nal.subarray(1)), end(h));
      return Array.from({ length: reader.bitsLeft }, () => reader.u1()).join("");
    };
    for (let index = 0; index < slices.length; index += 1) {
      const shift = (headers[index].frameNum - original[index].frameNum + maxFrameNum) % maxFrameNum;
      assert.equal(shift, renumberer.frameNumShift);
      if (sps.pocType === 0) {
        const maxLsb = 2 ** sps.log2MaxPocLsb;
        assert.equal((headers[index].pocLsb - original[index].pocLsb + maxLsb) % maxLsb, renumberer.pocShift);
      }
      assert.equal(tail(rewritten[index], headers[index]), tail(slices[index], original[index]));
    }
  });
}

test("renumbering refuses slices that use another SPS", () => {
  const { nals, sps, pps, header } = fixtureSyntax("gdr-cut.h264");
  const slice = nals.find((nal) => nalType(nal) === 1);
  const renumberer = new SliceRenumberer(header(slice));
  const otherSps = new Map([[sps.id, { ...sps }]]);
  assert.equal(renumberer.rewrite(slice, new Map([[pps.id, pps]]), otherSps), null);
});
