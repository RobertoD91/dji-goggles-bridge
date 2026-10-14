import assert from "node:assert/strict";
import { test } from "node:test";

import { AnnexBSplitter, joinAnnexB } from "../src/annexb.js";

const bytes = (...values) => Uint8Array.from(values);
const NALS = [bytes(0x67, 1, 2, 3), bytes(0x68, 0, 0, 3, 1), bytes(0x65, 9), bytes(0x41, 0, 0, 3, 0, 7)];

function split(stream, size) {
  const splitter = new AnnexBSplitter();
  const out = [];
  for (let offset = 0; offset < stream.length; offset += size) {
    out.push(...splitter.push(stream.subarray(offset, offset + size)));
  }
  const last = splitter.flush();
  if (last) out.push(last);
  return out.map((nal) => [...nal]);
}

test("splits three- and four-byte start codes at any read boundary", () => {
  // prettier-ignore
  const stream = Uint8Array.from([
    0x12, 0x34, // tail of a NAL unit from before we joined
    0, 0, 0, 1, ...NALS[0],
    0, 0, 1, ...NALS[1],
    0, 0, 0, 0, 1, ...NALS[2], // trailing_zero_8bits before a start code
    0, 0, 1, ...NALS[3],
  ]);
  const expected = NALS.map((nal) => [...nal]);
  for (let size = 1; size <= stream.length; size += 1) {
    assert.deepEqual(split(stream, size), expected, `read size ${size}`);
  }
});

test("joinAnnexB output splits back into the same NAL units", () => {
  assert.deepEqual(
    split(joinAnnexB(NALS), 3),
    NALS.map((nal) => [...nal]),
  );
});

test("returned NAL units do not alias the internal buffer", () => {
  const splitter = new AnnexBSplitter();
  const [first] = splitter.push(joinAnnexB([NALS[0], NALS[1]]));
  splitter.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff));
  assert.deepEqual([...first], [...NALS[0]]);
});

test("no output before the first start code", () => {
  const splitter = new AnnexBSplitter();
  assert.deepEqual(splitter.push(bytes(1, 2, 3, 4, 5, 0, 0)), []);
  assert.equal(splitter.flush(), null);
});
