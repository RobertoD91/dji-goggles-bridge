"""Regenerate the small H.264 fixtures used by the WebUSB tests (needs PyAV with libx264).

python webusb/tests/fixtures/generate.py

- gdr-cut.h264: intra refresh only, joined mid-stream like live DJI video: it
  starts inside a NAL unit, has no IDR and no SEI, and three slices per picture.
- baseline-gdr-cut.h264: the same idea with a Baseline profile SPS, one slice.
- bframes-gdr-cut.h264: intra refresh with B-frames, so pictures use POC type 0
  and several reference frames.
- idr-sparse-ps.h264: periodic IDRs; only the first one carries SPS/PPS.
"""

from pathlib import Path

import av
import numpy as np

HERE = Path(__file__).resolve().parent


def encode(params, *, profile="high", frames=40, width=96, height=64, slices=False):
    codec = av.CodecContext.create("libx264", "w")
    codec.width, codec.height, codec.pix_fmt = width, height, "yuv420p"
    codec.framerate = 30
    threads = ":slices=3:threads=1" if slices else ":threads=1"
    codec.options = {"profile": profile, "x264-params": params + threads}
    data = bytearray()
    y, x = np.mgrid[0:height, 0:width]
    for index in range(frames):
        image = np.stack(
            [(x * 2 + 5 * index) % 256, (y * 3 + 2 * index) % 256, (x + y + index) % 256], -1
        ).astype(np.uint8)
        for packet in codec.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
            data += bytes(packet)
    for packet in codec.encode(None):
        data += bytes(packet)
    return bytes(data)


def nal_units(stream):
    starts = []
    index = stream.find(b"\0\0\1")
    while index >= 0:
        starts.append(index)
        index = stream.find(b"\0\0\1", index + 3)
    return [
        stream[start + 3 : (starts[n + 1] if n + 1 < len(starts) else len(stream))].rstrip(b"\0")
        for n, start in enumerate(starts)
    ]


def annex_b(nals):
    return b"".join(b"\0\0\0\1" + nal for nal in nals)


def joined_mid_stream(stream):
    nals = nal_units(stream)
    second_sps = [i for i, nal in enumerate(nals) if nal[0] & 0x1F == 7][1]
    kept = [nal for nal in nals[second_sps:] if nal[0] & 0x1F != 6]
    # Start inside the previous NAL unit, as a USB read would.
    return nals[second_sps - 1][-5:] + annex_b(kept)


def main():
    refresh = "keyint=10:intra-refresh=1:bframes=0:ref=1"
    (HERE / "gdr-cut.h264").write_bytes(joined_mid_stream(encode(refresh, slices=True)))
    (HERE / "baseline-gdr-cut.h264").write_bytes(
        joined_mid_stream(encode(refresh, profile="baseline"))
    )
    bframes = "keyint=10:intra-refresh=1:bframes=2:ref=2"
    (HERE / "bframes-gdr-cut.h264").write_bytes(joined_mid_stream(encode(bframes)))
    nals = nal_units(encode("keyint=10:bframes=0:ref=1", frames=30))
    seen_idr = False
    sparse = []
    for nal in nals:
        kind = nal[0] & 0x1F
        if kind in (7, 8) and seen_idr:
            continue
        seen_idr |= kind == 5
        sparse.append(nal)
    (HERE / "idr-sparse-ps.h264").write_bytes(annex_b(sparse))


if __name__ == "__main__":
    main()
