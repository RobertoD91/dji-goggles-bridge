// Shared test helpers (not a test file itself).

import { readFileSync } from "node:fs";

import { AnnexBSplitter } from "../src/annexb.js";
import { toRbsp } from "../src/bitstream.js";
import { nalType, parsePps, parseSliceHeader, parseSps } from "../src/h264.js";

export function fixture(name) {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

export function splitNals(bytes) {
  const splitter = new AnnexBSplitter();
  const nals = splitter.push(bytes);
  const last = splitter.flush();
  return last ? [...nals, last] : nals;
}

export function fixtureNals(name) {
  return splitNals(fixture(name));
}

/** Parameter sets and a slice-header parser for a single-SPS/PPS fixture. */
export function fixtureSyntax(name) {
  const nals = fixtureNals(name);
  const sps = parseSps(nals.find((nal) => nalType(nal) === 7));
  const pps = parsePps(nals.find((nal) => nalType(nal) === 8));
  const spsById = new Map([[sps.id, sps]]);
  const ppsById = new Map([[pps.id, pps]]);
  const header = (nal) => parseSliceHeader(toRbsp(nal.subarray(1)), nalType(nal), ppsById, spsById);
  return { nals, sps, pps, spsById, ppsById, header };
}
