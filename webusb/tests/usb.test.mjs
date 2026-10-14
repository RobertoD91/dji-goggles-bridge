import assert from "node:assert/strict";
import { test } from "node:test";

import { GogglesUsbError, V2Connection } from "../src/usb.js";

const bulk = (endpointNumber, direction) => ({ endpointNumber, direction, type: "bulk" });

/** A WebUSB device peer with the V2's composite layout and scripted transfers. */
class FakeDevice {
  constructor({ productId = 0x001f, configured = true, videoEndpoints, start = "ok", claim = "ok" } = {}) {
    this.vendorId = 0x2ca3;
    this.productId = productId;
    this.opened = false;
    this.events = [];
    this.start = start;
    this.claim = claim;
    this.reads = [];
    this.waiting = [];
    const iface = (interfaceNumber, endpoints) => {
      const alternate = { alternateSetting: 0, endpoints };
      return { interfaceNumber, alternate, alternates: [alternate] };
    };
    this.layout = {
      configurationValue: 1,
      interfaces: [
        iface(0, [bulk(1, "in"), bulk(1, "out")]),
        iface(3, videoEndpoints ?? [bulk(3, "out"), bulk(4, "in")]),
      ],
    };
    this.configuration = configured ? this.layout : null;
  }

  async open() {
    this.events.push("open");
    this.opened = true;
  }

  async close() {
    this.events.push("close");
    this.opened = false;
    for (const waiter of this.waiting.splice(0)) {
      waiter.reject(new DOMException("The transfer was cancelled.", "AbortError"));
    }
  }

  async selectConfiguration(value) {
    this.events.push(`configure ${value}`);
    this.configuration = this.layout;
  }

  async claimInterface(number) {
    this.events.push(`claim ${number}`);
    if (this.claim !== "ok") {
      throw new DOMException("Unable to claim interface.", "NetworkError");
    }
  }

  async releaseInterface(number) {
    this.events.push(`release ${number}`);
  }

  async clearHalt(direction, endpoint) {
    this.events.push(`clearHalt ${direction} ${endpoint}`);
    this.halted = false;
  }

  transferOut(endpoint, data) {
    this.events.push(`out ${endpoint} ${new TextDecoder().decode(data)}`);
    if (this.start === "hang") return new Promise(() => {});
    if (this.start === "stall") return Promise.resolve({ status: "stall", bytesWritten: 0 });
    return Promise.resolve({ status: "ok", bytesWritten: data.length });
  }

  transferIn(endpoint, length) {
    this.events.push(`in ${endpoint} ${length}`);
    if (this.halted) {
      return Promise.resolve({ status: "stall" });
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.deliver();
    });
  }

  /** Queue a transfer result: bytes, "stall", or an Error for a disconnection. */
  queue(...results) {
    this.reads.push(...results);
    this.deliver();
  }

  deliver() {
    while (this.reads.length && this.waiting.length) {
      const result = this.reads.shift();
      const waiter = this.waiting.shift();
      if (result instanceof Error) {
        waiter.reject(result);
      } else if (result === "stall") {
        // A halted endpoint fails every transfer until clearHalt().
        this.halted = true;
        waiter.resolve({ status: "stall" });
        for (const other of this.waiting.splice(0)) other.resolve({ status: "stall" });
      } else {
        const bytes = Uint8Array.from(result);
        waiter.resolve({ status: "ok", data: new DataView(bytes.buffer) });
      }
    }
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("opens only interface 3, starts video and reads in order", async () => {
  const device = new FakeDevice();
  const connection = await V2Connection.open(device);
  assert.deepEqual(device.events.slice(0, 3), ["open", "claim 3", "out 3 RMVT"]);
  assert.equal(connection.startTimedOut, false);
  const received = [];
  const running = connection.start((bytes) => received.push([...bytes]));
  device.queue([1, 2], [3], [4, 5, 6]);
  await tick();
  assert.equal(device.events.filter((event) => event === "in 4 65536").length, 7, "4 pending + 3 refills");
  await connection.close();
  await running;
  assert.deepEqual(received, [[1, 2], [3], [4, 5, 6]]);
  assert.deepEqual(device.events.slice(-2), ["release 3", "close"]);
});

test("an unconfigured device gets configuration 1; a configured one is left alone", async () => {
  const fresh = new FakeDevice({ configured: false });
  await (await V2Connection.open(fresh)).close();
  assert.ok(fresh.events.includes("configure 1"));
  const active = new FakeDevice();
  await (await V2Connection.open(active)).close();
  assert.ok(!active.events.some((event) => event.startsWith("configure")));
});

test("a video start request that never completes is not fatal", async () => {
  const device = new FakeDevice({ start: "hang" });
  const connection = await V2Connection.open(device);
  assert.equal(connection.startTimedOut, true);
  const received = [];
  const running = connection.start((bytes) => received.push(bytes.length));
  device.queue([9, 9, 9]);
  await tick();
  await connection.close();
  await running;
  assert.deepEqual(received, [3]);
});

test("a rejected video start request fails and releases the device", async () => {
  const device = new FakeDevice({ start: "stall" });
  await assert.rejects(V2Connection.open(device), GogglesUsbError);
  assert.deepEqual(device.events.slice(-2), ["release 3", "close"]);
});

test("Goggles 3 are refused with an explanation, without opening USB", async () => {
  const device = new FakeDevice({ productId: 0x0020 });
  await assert.rejects(V2Connection.open(device), (error) => {
    assert.ok(error instanceof GogglesUsbError);
    assert.match(error.hint, /RNDIS/);
    return true;
  });
  assert.deepEqual(device.events, []);
});

test("missing video endpoints and claim failures explain what to check", async () => {
  const noEndpoints = new FakeDevice({ videoEndpoints: [bulk(4, "in")] });
  await assert.rejects(V2Connection.open(noEndpoints), /bulk video interface 3/);
  assert.ok(!noEndpoints.events.some((event) => event.startsWith("claim")));
  assert.equal(noEndpoints.opened, false);

  const busy = new FakeDevice({ claim: "busy" });
  await assert.rejects(V2Connection.open(busy), (error) => {
    assert.ok(error instanceof GogglesUsbError);
    assert.ok(error.hint.length > 0);
    return true;
  });
  assert.equal(busy.opened, false);
});

test("a stalled endpoint is cleared and reading continues", async () => {
  const device = new FakeDevice();
  const connection = await V2Connection.open(device);
  const received = [];
  const running = connection.start((bytes) => received.push(bytes[0]));
  device.queue([1], "stall");
  await tick();
  await tick();
  device.queue([2]);
  await tick();
  await connection.close();
  await running;
  assert.ok(device.events.includes("clearHalt in 4"));
  assert.deepEqual(received, [1, 2]);
});

test("a disconnection ends reading with an error", async () => {
  const device = new FakeDevice();
  const connection = await V2Connection.open(device);
  const running = connection.start(() => {});
  device.queue(new DOMException("The device was disconnected.", "NotFoundError"));
  await assert.rejects(running, /disconnected/);
  await connection.close();
});
