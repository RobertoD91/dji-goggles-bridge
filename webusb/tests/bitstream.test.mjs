import assert from "node:assert/strict";
import { test } from "node:test";

import { BitReader, BitWriter, toEbsp, toRbsp, writeBits } from "../src/bitstream.js";

test("emulation prevention round-trips every risky byte pattern", () => {
  const rbsp = Uint8Array.of(0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0);
  const ebsp = toEbsp(rbsp);
  assert.deepEqual([...ebsp], [0, 0, 3, 0, 0, 3, 0, 1, 0, 0, 3, 2, 0, 0, 3, 3, 0, 0, 4, 0, 0]);
  assert.deepEqual(toRbsp(ebsp), rbsp);
});

test("Exp-Golomb writer and reader agree", () => {
  const values = [0, 1, 2, 3, 7, 8, 255, 256, 8159, 65535, 2 ** 31 - 2];
  const signed = [0, 1, -1, 2, -2, 127, -128, 4000, -4000];
  const writer = new BitWriter();
  values.forEach((value) => writer.ue(value));
  signed.forEach((value) => writer.se(value));
  writer.u(13, 0x1abc);
  writer.trailing();
  const reader = new BitReader(writer.toBytes());
  assert.deepEqual(
    values.map(() => reader.ue()),
    values,
  );
  assert.deepEqual(
    signed.map(() => reader.se()),
    signed,
  );
  assert.equal(reader.u(13), 0x1abc);
  assert.equal(reader.u1(), 1, "rbsp_stop_one_bit");
});

test("known Exp-Golomb codes", () => {
  const writer = new BitWriter();
  writer.ue(3); // 00100
  writer.ue(0); // 1
  writer.se(0); // 1
  writer.u1(1);
  assert.deepEqual([...writer.toBytes()], [0b00100111]);
});

test("writeBits replaces a field that crosses byte boundaries", () => {
  const bytes = Uint8Array.of(0xff, 0xff, 0xff);
  writeBits(bytes, 5, 9, 0);
  assert.deepEqual([...bytes], [0b11111000, 0b00000011, 0xff]);
  writeBits(bytes, 5, 9, 0b101010101);
  assert.equal(new BitReader(bytes, 5).u(9), 0b101010101);
});

test("reading past the end throws instead of returning garbage", () => {
  const reader = new BitReader(Uint8Array.of(0));
  assert.throws(() => reader.ue());
});
