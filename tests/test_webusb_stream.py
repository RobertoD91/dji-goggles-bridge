"""The web app's WebCodecs input must decode with stock FFmpeg, without SHOW_ALL.

The browser has no SHOW_ALL equivalent, so webusb/src/stream.js starts streams
without IDR pictures from a synthetic grey IDR. This checks its output with a
real decoder; the JavaScript unit tests live in webusb/tests.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

try:
    import av
    import numpy as np
except ImportError:
    av = np = None

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "webusb" / "tests" / "tools" / "decoder-input.mjs"
NODE = shutil.which("node")
WIDTH, HEIGHT = 160, 96


def nal_units(stream):
    starts = []
    index = stream.find(b"\0\0\1")
    while index >= 0:
        starts.append(index)
        index = stream.find(b"\0\0\1", index + 3)
    ends = starts[1:] + [len(stream)]
    return [stream[start + 3 : end].rstrip(b"\0") for start, end in zip(starts, ends)]


@unittest.skipIf(av is None or np is None, "Optional decode dependencies not installed")
@unittest.skipIf(NODE is None, "Node.js is required to run the web app's stream code")
@unittest.skipIf(not TOOL.is_file(), "The webusb/ web app is not part of this checkout")
class WebUsbStreamTests(unittest.TestCase):
    def encode(self, params, frames=60):
        encoder = av.CodecContext.create("libx264", "w")
        encoder.width, encoder.height, encoder.pix_fmt = WIDTH, HEIGHT, "yuv420p"
        encoder.framerate = 30
        encoder.options = {"profile": "high", "x264-params": params + ":bframes=0:threads=1"}
        y, x = np.mgrid[0:HEIGHT, 0:WIDTH]
        data = bytearray()
        for index in range(frames):
            image = np.stack(
                [(x + 3 * index) % 256, (y + 2 * index) % 256, (x + y + index) % 256], -1
            ).astype(np.uint8)
            for packet in encoder.encode(av.VideoFrame.from_ndarray(image, format="rgb24")):
                data += bytes(packet)
        for packet in encoder.encode(None):
            data += bytes(packet)
        return bytes(data)

    def decode(self, data, *, show_all=False):
        decoder = av.CodecContext.create("h264", "r")
        if show_all:
            decoder.flags2 |= 1 << 22
        frames = []
        for packet in decoder.parse(data) + decoder.parse(b""):
            frames.extend(decoder.decode(packet))
        frames.extend(decoder.decode(None))
        return [frame.to_ndarray(format="yuv420p")[:HEIGHT] for frame in frames]

    def decoder_input(self, data):
        with tempfile.TemporaryDirectory() as temporary:
            source, output = Path(temporary, "in.h264"), Path(temporary, "out.h264")
            source.write_bytes(data)
            result = subprocess.run(
                [NODE, str(TOOL), str(source), str(output), "777"],
                check=True,
                capture_output=True,
                text=True,
                timeout=60,
            )
            return output.read_bytes(), json.loads(result.stdout)

    def test_stream_without_idr_decodes_from_a_synthetic_grey_key_frame(self):
        full = self.encode("keyint=20:intra-refresh=1:ref=2")
        nals = nal_units(full)
        second_sps = [i for i, nal in enumerate(nals) if nal[0] & 0x1F == 7][1]
        # Joined mid-stream: no IDR, no recovery-point SEI, a partial NAL first.
        kept = [nal for nal in nals[second_sps:] if nal[0] & 0x1F != 6]
        joined = nals[second_sps - 1][-7:] + b"".join(b"\0\0\0\1" + nal for nal in kept)
        pictures = sum(nal[0] & 0x1F == 1 for nal in kept)
        self.assertEqual(self.decode(joined), [], "FFmpeg withholds every picture without SHOW_ALL")

        output, info = self.decoder_input(joined)
        frames = self.decode(output)

        synthetic = sum(kind.startswith("synthetic") for kind in info["types"])
        self.assertEqual(info["types"][0], "synthetic-key")
        self.assertEqual(info["types"][synthetic:], ["delta"] * pictures)
        self.assertEqual(len(frames), pictures + synthetic)
        for frame in frames[:synthetic]:
            self.assertTrue((frame == 128).all(), "Synthetic pictures are uniform mid-grey")
        # After one intra-refresh period the picture equals a decode from the start.
        np.testing.assert_array_equal(frames[-1], self.decode(full)[-1])
        # Before that, it matches what the desktop SDK shows with SHOW_ALL.
        np.testing.assert_array_equal(frames[synthetic:], self.decode(joined, show_all=True))

    def test_idr_stream_is_passed_through_without_a_synthetic_picture(self):
        full = self.encode("keyint=15:ref=1", frames=45)
        output, info = self.decoder_input(full)
        self.assertEqual(info["stats"]["bootstraps"], 0)
        self.assertEqual(info["types"][0], "key")
        expected = self.decode(full)
        actual = self.decode(output)
        self.assertEqual(len(actual), len(expected))
        for want, got in zip(expected, actual):
            np.testing.assert_array_equal(got, want)


if __name__ == "__main__":
    unittest.main()
