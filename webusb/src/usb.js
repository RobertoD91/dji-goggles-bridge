// WebUSB transport for the DJI FPV Goggles V2 bulk video interface.
//
// Same protocol as src/goggles_v2.py (see PROTOCOL.md): claim interface 3 only,
// write "RMVT" once to bulk OUT 0x03, then read H.264 from bulk IN 0x84.

export const DJI_VENDOR_ID = 0x2ca3;
export const V2_PRODUCT_ID = 0x001f;
export const GOGGLES_3_PRODUCT_ID = 0x0020;

export const DEVICE_FILTERS = [
  { vendorId: DJI_VENDOR_ID, productId: V2_PRODUCT_ID },
  { vendorId: DJI_VENDOR_ID, productId: GOGGLES_3_PRODUCT_ID },
];

const VIDEO_INTERFACE = 3;
const VIDEO_IN = 4; // Endpoint 0x84
const VIDEO_OUT = 3; // Endpoint 0x03
const START_VIDEO = Uint8Array.of(0x52, 0x4d, 0x56, 0x54); // "RMVT"
const START_TIMEOUT_MS = 500;
const READ_SIZE = 65536;
const PENDING_READS = 4; // Keep the endpoint busy between JavaScript callbacks.

export class GogglesUsbError extends Error {
  constructor(message, { cause, hint } = {}) {
    super(message, { cause });
    this.hint = hint;
  }
}

export function deviceModel(device) {
  if (device.vendorId !== DJI_VENDOR_ID) {
    return null;
  }
  if (device.productId === V2_PRODUCT_ID) {
    return "v2";
  }
  return device.productId === GOGGLES_3_PRODUCT_ID ? "goggles3" : null;
}

export function webUsbAvailable() {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

const platform = () => {
  if (typeof navigator === "undefined") return "other";
  const data = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  if (/win/i.test(data)) return "windows";
  if (/android/i.test(navigator.userAgent)) return "android";
  if (/linux/i.test(data)) return "linux";
  if (/mac/i.test(data)) return "mac";
  return "other";
};

function accessHint() {
  switch (platform()) {
    case "windows":
      return (
        "Windows needs the WinUSB driver on the goggles' video interface. Run Zadig " +
        "(https://zadig.akeo.ie/), enable Options > List All Devices, select " +
        "Vision / Bulk Interface (Interface 3 / MI_03, USB 2ca3:001f) and install WinUSB. " +
        "Close other goggles apps."
      );
    case "linux":
      return (
        "Linux needs USB access for 2ca3:001f: add a udev rule (see Help), then replug " +
        "the goggles. Close other goggles apps."
      );
    default:
      return "Close other apps that use the goggles (including the desktop bridge), then replug the cable.";
  }
}

/** One open V2 video interface. `start(onData)` runs until close() or disconnection. */
export class V2Connection {
  constructor(device) {
    this.device = device;
    this.claimed = false;
    this.closed = false;
    this.startTimedOut = false;
  }

  static async open(device) {
    const model = deviceModel(device);
    if (model === "goggles3") {
      throw new GogglesUsbError("DJI Goggles 3 can't be used from a browser.", {
        hint:
          "Goggles 3 send video through a USB network (RNDIS) interface. Browsers block " +
          "that interface class for WebUSB, so use the desktop DJI Goggles Bridge app instead.",
      });
    }
    if (model !== "v2") {
      throw new GogglesUsbError("This USB device is not a supported DJI headset.");
    }
    const connection = new V2Connection(device);
    try {
      await connection.openInterface();
    } catch (error) {
      await connection.close();
      throw error;
    }
    return connection;
  }

  async openInterface() {
    const device = this.device;
    try {
      if (!device.opened) {
        await device.open();
      }
      // Never reset or reconfigure the composite device; only pick the first
      // configuration if the operating system left it unconfigured.
      if (device.configuration === null) {
        await device.selectConfiguration(1);
      }
    } catch (error) {
      throw new GogglesUsbError("Can't open the goggles over USB.", { cause: error, hint: accessHint() });
    }
    const usbInterface = device.configuration.interfaces.find(
      (candidate) => candidate.interfaceNumber === VIDEO_INTERFACE,
    );
    const alternate = usbInterface?.alternates.find((candidate) => candidate.alternateSetting === 0);
    const endpoints = alternate?.endpoints ?? [];
    const hasEndpoint = (number, direction) =>
      endpoints.some(
        (endpoint) =>
          endpoint.endpointNumber === number && endpoint.direction === direction && endpoint.type === "bulk",
      );
    if (!hasEndpoint(VIDEO_IN, "in") || !hasEndpoint(VIDEO_OUT, "out")) {
      throw new GogglesUsbError("The goggles have no bulk video interface 3 (endpoints 84/03).", {
        hint: "Check that these are DJI FPV Goggles V2 and update their firmware if needed.",
      });
    }
    try {
      await device.claimInterface(VIDEO_INTERFACE);
      this.claimed = true;
      if (usbInterface.alternate?.alternateSetting !== 0) {
        await device.selectAlternateInterface(VIDEO_INTERFACE, 0);
      }
    } catch (error) {
      throw new GogglesUsbError("Can't use the goggles' video interface.", {
        cause: error,
        hint: accessHint(),
      });
    }
    await this.startVideo();
  }

  async startVideo() {
    // WebUSB transfers have no timeout. Like fpvout-c and the Python SDK, a
    // start request that doesn't complete in 500 ms is not fatal: reading
    // decides whether video exists. The pending transfer ends on close().
    const write = this.device.transferOut(VIDEO_OUT, START_VIDEO);
    write.catch(() => {});
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), START_TIMEOUT_MS);
    });
    let result;
    try {
      result = await Promise.race([write, timeout]);
    } catch (error) {
      throw new GogglesUsbError("The goggles rejected the video start request.", {
        cause: error,
        hint: "Reconnect the data cable and confirm a live air-unit picture in the goggles.",
      });
    } finally {
      clearTimeout(timer);
    }
    if (result === null) {
      this.startTimedOut = true;
      return;
    }
    if (result.status !== "ok" || result.bytesWritten !== START_VIDEO.length) {
      throw new GogglesUsbError("The goggles rejected the video start request.", {
        hint: "Reconnect the data cable and confirm a live air-unit picture in the goggles.",
      });
    }
  }

  /** Read until closed. Resolves on close(); rejects when the device fails or disappears. */
  async start(onData) {
    const device = this.device;
    const read = () => device.transferIn(VIDEO_IN, READ_SIZE);
    let pending = Array.from({ length: PENDING_READS }, read);
    try {
      while (!this.closed) {
        const transfer = pending.shift();
        let result;
        try {
          result = await transfer;
        } catch (error) {
          if (this.closed) {
            return;
          }
          throw new GogglesUsbError("The goggles disconnected.", {
            cause: error,
            hint: "Check the USB data cable, then connect again.",
          });
        }
        if (result.status === "stall") {
          await Promise.allSettled(pending);
          await device.clearHalt("in", VIDEO_IN);
          pending = Array.from({ length: PENDING_READS }, read);
          continue;
        }
        if (result.status !== "ok") {
          throw new GogglesUsbError(`USB video transfer failed (${result.status}).`);
        }
        pending.push(read());
        if (result.data?.byteLength) {
          onData(new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength));
        }
      }
    } finally {
      for (const transfer of pending) {
        transfer.catch(() => {});
      }
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      if (this.claimed) {
        await this.device.releaseInterface(VIDEO_INTERFACE);
      }
    } catch {
      // The device may already be unplugged.
    }
    try {
      if (this.device.opened) {
        await this.device.close();
      }
    } catch {
      // Closing an unplugged device can fail; there is nothing left to release.
    }
  }
}
