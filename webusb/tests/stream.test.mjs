import assert from "node:assert/strict";
import { test } from "node:test";

import { nalType } from "../src/h264.js";
import { VideoStream } from "../src/stream.js";
import { fixture, splitNals } from "./helpers.mjs";

function run(bytes, { size = bytes.length, stream = new VideoStream() } = {}) {
  const actions = [];
  let time = 1000;
  for (let offset = 0; offset < bytes.length; offset += size) {
    actions.push(...stream.push(bytes.subarray(offset, offset + size), (time += 1000)));
  }
  actions.push(...stream.flush(time + 1000));
  return { actions, stream, chunks: actions.filter((action) => action.kind === "chunk") };
}

const types = (chunk) => splitNals(chunk.data).map(nalType);

test("a stream without IDR starts from synthetic pictures, then passes every picture", () => {
  const { actions, chunks, stream } = run(fixture("gdr-cut.h264"));
  assert.equal(actions[0].kind, "configure");
  assert.equal(actions[0].config.codec, "avc1.64000A");
  assert.deepEqual([actions[0].config.codedWidth, actions[0].config.codedHeight], [96, 64]);
  assert.equal(actions.filter((action) => action.kind === "configure").length, 1);
  assert.deepEqual(types(chunks[0]), [7, 8, 8, 5], "SPS, the stream's PPS, our PPS, grey IDR");
  assert.equal(chunks[0].type, "key");
  assert.ok(chunks[0].synthetic);
  const pictures = chunks.filter((chunk) => !chunk.synthetic);
  assert.equal(pictures.length, 30);
  assert.ok(pictures.every((chunk) => chunk.type === "delta"));
  assert.deepEqual(types(pictures[0]), [7, 8, 1, 1, 1], "parameter sets belong to the next picture");
  assert.deepEqual(types(pictures[1]), [1, 1, 1], "three slices form one picture");
  assert.deepEqual(stream.stats.bootstraps, 1);
  const stamps = chunks.map((chunk) => chunk.timestamp);
  assert.ok(stamps.every((stamp, index) => index === 0 || stamp > stamps[index - 1]));
});

test("output does not depend on USB read boundaries", () => {
  const bytes = fixture("bframes-gdr-cut.h264");
  const whole = run(bytes).chunks.map((chunk) => [...chunk.data]);
  for (const size of [1, 7, 64, 513]) {
    assert.deepEqual(
      run(bytes, { size }).chunks.map((chunk) => [...chunk.data]),
      whole,
      `size ${size}`,
    );
  }
});

test("multi-reference streams get grey P_Skip fillers after the IDR", () => {
  const { chunks } = run(fixture("bframes-gdr-cut.h264"));
  const synthetic = chunks.filter((chunk) => chunk.synthetic);
  assert.ok(synthetic.length > 1);
  assert.equal(synthetic[0].type, "key");
  assert.ok(synthetic.slice(1).every((chunk) => chunk.type === "delta"));
  assert.ok(synthetic.slice(1).every((chunk) => types(chunk).join() === "1"));
});

test("without bootstrapping, pictures before an IDR are skipped", () => {
  const { chunks, stream } = run(fixture("gdr-cut.h264"), { stream: new VideoStream({ bootstrap: false }) });
  assert.equal(chunks.length, 0);
  assert.equal(stream.stats.skippedBeforeKey, 30);
});

test("IDR pictures become key chunks that carry the latest SPS and PPS", () => {
  const { chunks, stream } = run(fixture("idr-sparse-ps.h264"));
  assert.equal(stream.stats.bootstraps, 0);
  const keys = chunks.filter((chunk) => chunk.type === "key");
  assert.equal(keys.length, stream.stats.idrFrames);
  assert.ok(keys.length > 2);
  for (const key of keys) {
    const nals = types(key);
    assert.ok(nals.includes(7) && nals.includes(8) && nals.includes(5), nals.join());
    assert.ok(nals.indexOf(7) < nals.indexOf(5));
  }
});

test("reset() restarts decoding from the next picture", () => {
  const bytes = fixture("gdr-cut.h264");
  const stream = new VideoStream();
  const half = Math.floor(bytes.length / 2);
  run(bytes.subarray(0, half), { stream });
  stream.reset();
  const actions = stream.push(bytes.subarray(half), 1e9);
  assert.equal(actions[0].kind, "configure");
  assert.ok(actions[1].synthetic && actions[1].type === "key");
});

test("a new SPS reconfigures the decoder and starts again", () => {
  const bytes = new Uint8Array([...fixture("gdr-cut.h264"), ...fixture("baseline-gdr-cut.h264")]);
  const { actions, stream } = run(bytes, { size: 1000 });
  const configures = actions.filter((action) => action.kind === "configure");
  assert.deepEqual(
    configures.map((action) => action.config.codec),
    ["avc1.64000A", "avc1.42C00A"],
  );
  assert.equal(stream.stats.bootstraps, 2);
  const second = actions.indexOf(configures[1]);
  assert.ok(actions[second + 1].synthetic && actions[second + 1].type === "key");
});

test("a recording stream can start mid-session from adopted parameter sets", () => {
  const bytes = fixture("gdr-cut.h264");
  const live = new VideoStream();
  live.push(bytes.subarray(0, 1200), 0);
  const recording = new VideoStream();
  recording.adoptParameterSets(live);
  // The rest of the stream starts mid-NAL and has no SPS/PPS until much later.
  const actions = [...recording.push(bytes.subarray(1200), 1), ...recording.flush(2)];
  const firstChunk = actions.find((action) => action.kind === "chunk");
  assert.equal(firstChunk.type, "key");
  assert.deepEqual(types(firstChunk).slice(0, 2), [7, 8]);
});
