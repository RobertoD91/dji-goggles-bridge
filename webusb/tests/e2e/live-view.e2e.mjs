// End-to-end check of the real page in Google Chrome with a simulated V2 headset.
//
//   npm install --no-save playwright-core     (in webusb/)
//   CHROME_PATH=/usr/bin/google-chrome node tests/e2e/live-view.e2e.mjs
//
// Chrome (not Chromium) is required: it includes the H.264 decoder.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname));
  try {
    const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(ROOT)) throw new Error("outside root");
    const body = await readFile(file);
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// Runs in the page before app.js: a WebUSB peer with the V2 layout that streams
// a fixture recorded without IDR pictures.
function installFakeUsb() {
  const state = (window.__usb = { events: [], productId: 0x001f, pace: 20, chunk: 300 });
  delete window.showSaveFilePicker; // Exercise the download fallback.
  class FakeDevice {
    constructor() {
      this.vendorId = 0x2ca3;
      this.productId = state.productId;
      this.productName = "Fake goggles";
      this.opened = false;
      const alternate = {
        alternateSetting: 0,
        endpoints: [
          { endpointNumber: 3, direction: "out", type: "bulk" },
          { endpointNumber: 4, direction: "in", type: "bulk" },
        ],
      };
      this.configuration = {
        configurationValue: 1,
        interfaces: [{ interfaceNumber: 3, alternate, alternates: [alternate] }],
      };
      this.waiting = [];
      this.offset = 0;
      this.data = fetch("tests/fixtures/gdr-cut.h264")
        .then((response) => response.arrayBuffer())
        .then((buffer) => new Uint8Array(buffer));
    }
    async open() {
      state.events.push("open");
      this.opened = true;
    }
    async close() {
      state.events.push("close");
      this.opened = false;
      for (const reject of this.waiting.splice(0)) reject(new DOMException("closed", "AbortError"));
    }
    async claimInterface(number) {
      state.events.push(`claim ${number}`);
    }
    async releaseInterface(number) {
      state.events.push(`release ${number}`);
    }
    async transferOut(endpoint, data) {
      state.events.push(`out ${endpoint} ${new TextDecoder().decode(data)}`);
      return { status: "ok", bytesWritten: data.byteLength };
    }
    async transferIn() {
      const data = await this.data;
      if (this.offset >= data.length) {
        return new Promise((_, reject) => this.waiting.push(reject)); // No more video.
      }
      await new Promise((resolve) => setTimeout(resolve, state.pace));
      if (!this.opened) throw new DOMException("closed", "AbortError");
      const piece = data.slice(this.offset, this.offset + state.chunk);
      this.offset += piece.length;
      return { status: "ok", data: new DataView(piece.buffer) };
    }
  }
  const usb = new EventTarget();
  usb.requestDevice = async ({ filters }) => {
    state.filters = filters;
    return (state.device = new FakeDevice());
  };
  usb.getDevices = async () => [];
  Object.defineProperty(Navigator.prototype, "usb", { get: () => usb });
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
let failures = 0;
async function check(name, body) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(installFakeUsb);
  await page.goto(`${origin}/index.html`);
  try {
    await body(page);
    assert.deepEqual(errors, []);
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`not ok - ${name}\n${error.stack}`);
  } finally {
    await context.close();
  }
}

const text = (page, id) => page.locator(`#${id}`).textContent();

await check("V2 live view starts without IDR pictures and shows the stream", async (page) => {
  assert.equal(await page.locator("#unsupported").isHidden(), true);
  await page.click("#connect");
  await page.waitForFunction(() => document.getElementById("progress").textContent === "Ready to watch!");
  assert.equal(await text(page, "check-usb"), "plugged in");
  assert.equal(await text(page, "check-goggles"), "connected");
  assert.match(await text(page, "check-live"), /^playing \(96x64\)/);
  const events = await page.evaluate(() => window.__usb.events);
  assert.deepEqual(events.slice(0, 3), ["open", "claim 3", "out 3 RMVT"]);
  // Wait for the whole fixture, then check the canvas holds the refreshed picture.
  await page.waitForFunction(() => document.getElementById("stats").textContent.includes("intra refresh"));
  await page.waitForTimeout(800);
  const spread = await page.evaluate(() => {
    const canvas = document.getElementById("video");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255;
    let max = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      min = Math.min(min, pixels[index]);
      max = Math.max(max, pixels[index]);
    }
    return { width: canvas.width, height: canvas.height, range: max - min };
  });
  assert.deepEqual([spread.width, spread.height], [96, 64]);
  assert.ok(spread.range > 100, `the last picture is not flat grey (range ${spread.range})`);

  await page.click("#disconnect");
  await page.waitForFunction(() => document.getElementById("progress").textContent === "Stopped.");
  assert.equal(await page.locator("#connect").isVisible(), true);
  const closing = await page.evaluate(() => window.__usb.events.slice(-2));
  assert.deepEqual(closing, ["release 3", "close"]);
});

await check("recording downloads a playable .h264 file", async (page) => {
  await page.evaluate(() => Object.assign(window.__usb, { pace: 60, chunk: 200 }));
  await page.click("#connect");
  await page.waitForFunction(() => document.getElementById("check-goggles").textContent === "connected");
  await page.click("#record");
  await page.waitForFunction(() => document.getElementById("record").textContent === "Stop recording");
  await page.waitForFunction(() => document.getElementById("stats").textContent.includes("recording"));
  await page.waitForTimeout(1500);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#record")]);
  assert.match(download.suggestedFilename(), /^dji-goggles-\d{8}-\d{6}\.h264$/);
  const bytes = await readFile(await download.path());
  assert.ok(bytes.length > 1000, `${bytes.length} bytes`);
  assert.deepEqual([...bytes.subarray(0, 5)], [0, 0, 0, 1, 0x67], "starts with an SPS");
  assert.ok(bytes.includes(Buffer.from([0, 0, 0, 1, 0x65])), "contains the synthetic IDR");
});

await check("Goggles 3 are explained instead of opened", async (page) => {
  await page.evaluate(() => (window.__usb.productId = 0x0020));
  await page.click("#connect");
  await page.waitForSelector("#error:not([hidden])");
  assert.equal(await text(page, "error-message"), "DJI Goggles 3 can't be used from a browser.");
  assert.match(await text(page, "error-hint"), /RNDIS/);
  assert.deepEqual(await page.evaluate(() => window.__usb.events), []);
  const filters = await page.evaluate(() => window.__usb.filters);
  assert.deepEqual(
    filters.map((filter) => filter.productId),
    [0x001f, 0x0020],
  );
});

await browser.close();
server.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
