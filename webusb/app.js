import { LiveSession } from "./src/session.js";
import { DEVICE_FILTERS, deviceModel, webUsbAvailable } from "./src/usb.js";

const $ = (id) => document.getElementById(id);
const ui = {
  stage: $("stage"),
  canvas: $("video"),
  placeholder: $("placeholder"),
  placeholderText: $("placeholder-text"),
  connect: $("connect"),
  disconnect: $("disconnect"),
  fullscreen: $("fullscreen"),
  record: $("record"),
  autoConnect: $("auto-connect"),
  checks: { usb: $("check-usb"), goggles: $("check-goggles"), live: $("check-live") },
  progress: $("progress"),
  stats: $("stats"),
  error: $("error"),
  errorMessage: $("error-message"),
  errorHint: $("error-hint"),
  notes: $("notes"),
  unsupported: $("unsupported"),
  install: $("install"),
};

let session = null;
const AUTO_CONNECT_KEY = "auto-connect";

function storedAutoConnect() {
  try {
    return localStorage.getItem(AUTO_CONNECT_KEY) !== "off";
  } catch {
    return true;
  }
}

function showError(message, hint = "") {
  ui.errorMessage.textContent = message;
  ui.errorHint.textContent = hint;
  ui.errorHint.hidden = !hint;
  ui.error.hidden = false;
}

function addNote(text) {
  const item = document.createElement("li");
  item.textContent = text;
  ui.notes.append(item);
  while (ui.notes.children.length > 5) {
    ui.notes.firstElementChild.remove();
  }
}

function renderStatus(values) {
  let ready = 0;
  for (const [name, [text, isReady]] of Object.entries(values)) {
    ui.checks[name].textContent = text;
    ui.checks[name].classList.toggle("ready", isReady);
    ready += isReady ? 1 : 0;
  }
  ui.progress.textContent =
    values.live[0] === "stopped"
      ? "Stopped."
      : ready === 3
        ? "Ready to watch!"
        : `Getting ready: [${"#".repeat(ready)}${"-".repeat(3 - ready)}] ${ready}/3`;
  ui.placeholder.hidden = values.live[1];
}

function renderStats(stats) {
  const parts = [];
  if (stats.width) {
    parts.push(`${stats.width}x${stats.height}`);
  }
  parts.push(`${stats.fps.toFixed(1)} fps`, `${stats.mbps.toFixed(1)} Mbit/s`);
  parts.push(`decoder: ${stats.decoder}`, `start: ${stats.start}`);
  if (stats.recording !== null) {
    parts.push(`recording ${(stats.recording / 1e6).toFixed(1)} MB`);
  }
  ui.stats.textContent = parts.join(" · ");
}

function setConnected(connected) {
  ui.connect.hidden = connected;
  ui.disconnect.hidden = !connected;
  ui.fullscreen.disabled = !connected;
  ui.record.disabled = !connected;
  if (!connected) {
    ui.record.textContent = "Record";
    ui.record.classList.remove("recording");
  }
}

async function start(device) {
  if (session) {
    return;
  }
  ui.error.hidden = true;
  ui.notes.replaceChildren();
  ui.stats.textContent = "";
  const current = new LiveSession(ui.canvas);
  session = current;
  current.addEventListener("status", (event) => renderStatus(event.detail));
  current.addEventListener("stats", (event) => renderStats(event.detail));
  current.addEventListener("note", (event) => addNote(event.detail));
  current.addEventListener("failure", (event) => showError(event.detail.message, event.detail.hint));
  current.addEventListener("stopped", () => {
    if (session === current) {
      session = null;
      setConnected(false);
      ui.placeholder.hidden = false;
      ui.placeholderText.textContent = "Disconnected. Connect the goggles to watch again.";
    }
  });
  setConnected(true);
  ui.placeholderText.textContent = "Waiting for video...";
  await current.start(device);
}

ui.connect.addEventListener("click", async () => {
  let device;
  try {
    device = await navigator.usb.requestDevice({ filters: DEVICE_FILTERS });
  } catch (error) {
    if (error.name !== "NotFoundError") {
      showError("Couldn't access USB devices.", error.message);
    }
    return; // NotFoundError: the chooser was cancelled.
  }
  await start(device);
});

ui.disconnect.addEventListener("click", () => session?.stop());

ui.fullscreen.addEventListener("click", () => toggleFullscreen());
ui.canvas.addEventListener("dblclick", () => toggleFullscreen());
document.addEventListener("keydown", (event) => {
  if (event.key === "f" && session && !event.target.closest("input, textarea")) {
    toggleFullscreen();
  }
});

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    ui.stage.requestFullscreen?.().catch(() => {});
  }
}

ui.record.addEventListener("click", async () => {
  if (!session) {
    return;
  }
  ui.record.disabled = true;
  try {
    if (session.recorder) {
      const recorder = await session.stopRecording();
      addNote(`Saved ${recorder.name} (${(recorder.bytes / 1e6).toFixed(1)} MB).`);
    } else {
      await session.startRecording();
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      showError("Recording failed.", error.message);
    }
  } finally {
    const recording = Boolean(session?.recorder);
    ui.record.textContent = recording ? "Stop recording" : "Record";
    ui.record.classList.toggle("recording", recording);
    ui.record.disabled = !session;
  }
});

ui.autoConnect.checked = storedAutoConnect();
ui.autoConnect.addEventListener("change", () => {
  try {
    localStorage.setItem(AUTO_CONNECT_KEY, ui.autoConnect.checked ? "on" : "off");
  } catch {
    // Storage can be unavailable (private mode); the checkbox still works for this visit.
  }
});

async function connectKnownDevice() {
  if (!ui.autoConnect.checked || session) {
    return;
  }
  const devices = await navigator.usb.getDevices();
  const device = devices.find((candidate) => deviceModel(candidate) === "v2");
  if (device) {
    await start(device);
  }
}

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  ui.install.hidden = false;
});
ui.install.addEventListener("click", async () => {
  ui.install.hidden = true;
  await installPrompt?.prompt();
  installPrompt = null;
});

function checkSupport() {
  const missing = [];
  if (!window.isSecureContext) {
    missing.push("a secure (https) page");
  }
  if (!webUsbAvailable()) {
    missing.push("WebUSB");
  }
  if (!("VideoDecoder" in window)) {
    missing.push("WebCodecs");
  }
  if (!missing.length) {
    return true;
  }
  ui.unsupported.textContent =
    `This browser lacks ${missing.join(" and ")}. Open this page in Chrome or Edge ` +
    "on a computer or Android phone.";
  ui.unsupported.hidden = false;
  ui.connect.disabled = true;
  ui.autoConnect.disabled = true;
  return false;
}

if (checkSupport()) {
  navigator.usb.addEventListener("connect", () => connectKnownDevice());
  navigator.usb.addEventListener("disconnect", (event) => {
    if (session && event.device === session.device) {
      session.stop();
    }
  });
  connectKnownDevice();
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
