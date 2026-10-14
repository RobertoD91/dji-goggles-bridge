# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Conventions

- Talk to the maintainer in Italian; write everything committed to the repository
  (code, comments, docs, commit messages) in English.
- This is a fork (`RobertoD91/dji-goggles-bridge`) of `Evols/dji-goggles-bridge`, licensed
  CC BY 4.0. Keep the attribution to "DJI Goggles Bridge by Baptiste Hutteau and contributors".
- Hardware claims in README.md / PROTOCOL.md are dated and specific (which model, OS, air unit).
  Never state that a combination works unless it was actually verified on hardware.

## Commands

```sh
python -m pip install -e ".[apps,dev]"            # what CI installs; add ,exe for PyInstaller
python -m unittest discover -s tests -v           # full suite (no hardware needed)
python -m unittest discover -s tests -p "test_goggles_v2.py"   # one file
python -m unittest discover -s tests -k test_name_fragment     # matching tests
ruff check .
ruff format --check .
python -m build
```

Tests must be run through `discover -s tests`: they import the `src/` modules as top-level
names (`from goggles_3 import ...`) via the editable install and import sibling test modules
directly (`import test_decoder`). Some tests need the `apps` extra (`cv2`, `aiohttp`, `aiortc`);
with only `.[decode,usb,dev]` installed, the viewer and WebRTC command tests fail on imports.

Windows-only PowerShell tests (`tests/test_network_check.ps1`, `tests/test_network_setup.ps1`)
run in CI with `powershell -NoProfile -ExecutionPolicy Bypass -File <test>`.

Packaging: `python scripts/build.py` (PyInstaller one-file console app + archive in `dist/`),
only on Windows or macOS for the host platform. Publishing a GitHub Release triggers
`.github/workflows/release.yml`, which builds and attaches the three archives.

## Architecture

The SDK is a set of flat modules in `src/` installed as top-level modules (see
`py-modules` in `pyproject.toml`), not a package. The core has **no required dependencies**;
`av`/`numpy` (decode) and `pyusb`/libusb (USB) are imported lazily only when needed. Keep it
that way: protocol code must stay importable with the standard library alone.

Layers, top to bottom:

1. `dji_goggles_bridge.py` - public API. `GogglesClient` is single-use and owns a receive
   worker thread and a bounded queue. Sessions expose `open()`, `receive(stop, emit, count)`,
   `close()`. A full queue raises `BufferError` (never silently drops compressed data);
   worker exceptions are re-raised to the reader after queued chunks are consumed.
2. Model sessions:
   - `goggles_3.py` - Goggles 3 (USB `2ca3:0020`): DJI UDP protocol (handshake, type-2 video
     fragments, reassembly, receive windows and type-4/6 ACKs). Transport is "socket-shaped"
     (`send`/`recv` raising `socket.timeout`), so the same session runs over a real UDP socket
     (Windows/Linux, host interface at `192.168.60.1/24`) or `rndis.RndisTransport`.
   - `goggles_v2.py` - FPV Goggles V2 (USB `2ca3:001f`): claim interface 3 only, write `RMVT`
     once to bulk OUT `0x03`, then read the raw H.264 byte stream from bulk IN `0x84`.
3. `rndis.py` - userspace USB RNDIS plus a minimal Ethernet/ARP/IPv4/UDP stack (default on
   macOS for Goggles 3; no OS network interface is created). `usb_backend.py` finds libusb
   (bundled, Homebrew, or `libusb-package` on Windows).
4. `decoder.py` - shared PyAV decoding. `AV_CODEC_FLAG2_SHOW_ALL` is required: DJI streams can
   lack IDR frames, and FFmpeg would otherwise never output a picture.

`src/apps/` are consumers of the SDK: `app_launcher.py` is the shared interactive menu used by
`windows_app.py` / `mac_app.py` (the frozen executables); `viewer.py` (OpenCV window; on macOS
the window runs in a spawned process), `server.py` (re-encodes to libx264 MPEG-TS over UDP for
OBS/VLC), `webrtc.py` (aiohttp + aiortc, serves `goggles_resources/webrtc.html`),
`diagnostics.py` (USB/goggles/live-view checks), `console.py` (status panel, support log in the
temp dir). `goggles_resources/*.ps1` are the Windows RNDIS IP check/setup scripts (UAC).

### Protocol invariants that are easy to break

PROTOCOL.md is the wire specification; read it before touching `goggles_3.py`, `rndis.py`
or `goggles_v2.py`. Highlights backed by hardware debugging:

- Video byte 17 bits 0..6 = part count, bit 7 = part-index bit 0; only the **low five bits**
  of byte 18 are part-index bits 1..5; byte 19 is opaque.
- Sequence IDs advance by 8 per fragment; low three bits mark retransmissions. Compare
  sequences on the 16-bit ring with `ahead()`/`distance()`, never with `>`.
- Missing IDs in ACKs are listed in stream order, capped at 128. ACKs (type 6) are sent about
  every 1/60 s even when the consumer is busy; type 4 at a frame's last part.
- RNDIS: accept exactly one extra (non-zero) termination byte after a message that ends on a
  USB packet boundary; pad outgoing transfers that end on a packet boundary with a zero byte.
- Never reset the composite USB device or change its configuration (mass storage etc. share
  it); claim only the interfaces needed. V2: an `RMVT` write timeout is non-fatal.

### Tests

`tests/helpers.py` builds wire packets independently of the production builders on purpose;
do not replace it with calls into `goggles_3`. USB is faked with `SimpleNamespace`-based peers
(see `tests/test_goggles_v2.py`, `tests/test_rndis.py`).

## WebUSB web app (`webusb/`)

A PWA published to GitHub Pages (`.github/workflows/pages.yml`, on pushes to `main`) that
shows **FPV Goggles V2** video in Chrome/Edge (desktop and Android). Plain ES modules, no
build step, no runtime dependencies; all paths are relative because Pages serves it under
`/dji-goggles-bridge/`. Goggles 3 cannot work there: their RNDIS control interface is class
`0xE0`, which WebUSB refuses to claim, so the app only explains this.

```sh
cd webusb && node --test                       # unit tests (tests/*.test.mjs, Node 22)
cd webusb && node --test tests/stream.test.mjs # one file
npm install --no-save playwright-core && CHROME_PATH=/path/to/google-chrome node tests/e2e/live-view.e2e.mjs
python webusb/tests/fixtures/generate.py       # regenerate H.264 fixtures (PyAV + libx264)
cd webusb && npx prettier --check .            # formatting (.prettierrc.json, width 110)
```

The e2e test needs Google Chrome (Playwright's Chromium lacks H.264) and fakes
`navigator.usb`. `tests/test_webusb_stream.py` (Python suite) runs
`webusb/tests/tools/decoder-input.mjs` through Node and decodes its output with FFmpeg.

Pipeline: `usb.js` (same protocol as `goggles_v2.py`; WebUSB has no transfer timeouts, so the
`RMVT` timeout is a timer race and four `transferIn` calls stay queued) -> `stream.js`
(`AnnexBSplitter`, access-unit grouping, SPS/PPS tracking, emits `configure`/`chunk` actions)
-> `player.js` (WebCodecs `VideoDecoder`, falls back to `prefer-software` on errors, draws only
the newest frame) orchestrated by `session.js`. `recorder.js` feeds a second `VideoStream`
so recordings start at a key picture.

The key piece is `bootstrap.js`: Chrome refuses a `key` chunk without an IDR slice and there
is no SHOW_ALL, so a stream without IDRs starts from synthetic grey pictures (CAVLC PPS with an
unused ID, I_16x16 IDR, P_Skip fillers for every reference frame), and later slices get their
fixed-width `frame_num`/`pic_order_cnt_lsb` rewritten to continue without a gap (see
PROTOCOL.md, "H.264 decoding"). Keep `stream.js`/`bootstrap.js` free of browser APIs so they
stay testable in Node.
