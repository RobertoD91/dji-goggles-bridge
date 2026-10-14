// Write the WebCodecs input that the web app would produce for an Annex B file.
// Used by tests/test_webusb_stream.py to check it with FFmpeg.
//
//   node webusb/tests/tools/decoder-input.mjs input.h264 output.h264 [chunkSize]

import { readFileSync, writeFileSync } from "node:fs";

import { VideoStream } from "../../src/stream.js";

const [input, output, chunkSize = "1000"] = process.argv.slice(2);
const data = readFileSync(input);
const stream = new VideoStream();
const parts = [];
const types = [];
const collect = (actions) => {
  for (const action of actions) {
    if (action.kind === "chunk") {
      parts.push(action.data);
      types.push(action.synthetic ? `synthetic-${action.type}` : action.type);
    }
  }
};
const size = Number(chunkSize);
for (let offset = 0; offset < data.length; offset += size) {
  collect(stream.push(data.subarray(offset, offset + size), offset));
}
collect(stream.flush(data.length));
writeFileSync(output, Buffer.concat(parts));
process.stdout.write(JSON.stringify({ types, stats: stream.stats }));
