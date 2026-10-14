import assert from "node:assert/strict";
import { test } from "node:test";

import { toRbsp } from "../src/bitstream.js";
import { codecString, firstMbInSlice, nalType, parseSliceHeader, parseSps } from "../src/h264.js";
import { fixtureNals, fixtureSyntax } from "./helpers.mjs";

const hex = (text) => Uint8Array.from(Buffer.from(text, "hex"));

test("SPS dimensions include frame cropping", () => {
  const cases = [
    ["6764002aacb200b40cff2c20000003002000000f01e30649", 1440, 808, "avc1.64002A", 2],
    ["6764002aacb200f0044fcb08000003000800000303c078c19240", 1920, 1080, "avc1.64002A", 2],
    ["674d4020da014016e840000003004000001e03c60ca8", 1280, 720, "avc1.4D4020", 2],
  ];
  for (const [bytes, width, height, codec, pocType] of cases) {
    const sps = parseSps(hex(bytes));
    assert.equal(sps.width, width);
    assert.equal(sps.height, height);
    assert.equal(sps.codedWidth % 16, 0);
    assert.equal(sps.pocType, pocType);
    assert.equal(sps.chromaArrayType, 1);
    assert.ok(sps.frameMbsOnly);
    assert.equal(codecString(sps), codec);
  }
});

test("slice headers expose frame_num; three slices share one picture", () => {
  const { nals, sps, pps, header } = fixtureSyntax("gdr-cut.h264");
  assert.deepEqual([sps.width, sps.height, sps.pocType], [96, 64, 2]);
  assert.equal(pps.spsId, sps.id);
  const slices = nals.filter((nal) => nalType(nal) === 1);
  const headers = slices.map(header);
  // Three slices per picture share frame_num and POC; the first starts at macroblock 0.
  assert.deepEqual(
    headers.slice(0, 3).map((header) => header.frameNum),
    [headers[0].frameNum, headers[0].frameNum, headers[0].frameNum],
  );
  assert.deepEqual(
    slices
      .slice(0, 4)
      .map(firstMbInSlice)
      .map((mb) => mb === 0),
    [true, false, false, true],
  );
  assert.notEqual(headers[3].frameNum, headers[0].frameNum);
  assert.equal(headers[0].sps, sps);
  assert.equal(headers[0].pocLsbOffset, undefined, "POC type 2 has no pic_order_cnt_lsb");
});

test("POC type 0 slice headers locate pic_order_cnt_lsb right after frame_num", () => {
  const { nals, sps, header } = fixtureSyntax("bframes-gdr-cut.h264");
  assert.equal(sps.pocType, 0);
  assert.ok(sps.maxNumRefFrames > 1);
  const first = header(nals.find((nal) => nalType(nal) === 1));
  assert.equal(first.pocLsbOffset, first.frameNumOffset + sps.log2MaxFrameNum);
});

test("a slice whose PPS is unknown cannot be parsed yet", () => {
  const slice = fixtureNals("gdr-cut.h264").find((nal) => nalType(nal) === 1);
  assert.equal(parseSliceHeader(toRbsp(slice.subarray(1)), 1, new Map(), new Map()), null);
});
