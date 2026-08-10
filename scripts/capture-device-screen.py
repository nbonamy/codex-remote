#!/usr/bin/env python3
"""Capture the Codex Remote AMOLED framebuffer over its USB serial port."""

from __future__ import annotations

import argparse
import binascii
import glob
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import time
import zlib


def ensure_pyserial() -> None:
    try:
        import serial  # noqa: F401
        return
    except ImportError:
        pio = shutil.which("pio") or shutil.which("platformio")
        if not pio:
            raise SystemExit("PlatformIO is required to access the USB serial port")
        info = json.loads(subprocess.check_output(
            [pio, "system", "info", "--json-output"], text=True
        ))
        python = info["python_exe"]["value"]
        os.execv(python, [python, str(Path(__file__).resolve()), *sys.argv[1:]])


ensure_pyserial()
import serial  # type: ignore  # noqa: E402


MAGIC = b"CODEX_REMOTE_SCREENSHOT_V1 "
PALETTE_BYTES = 256 * 2


def read_exact(port: serial.Serial, length: int, deadline: float) -> bytes:
    result = bytearray()
    while len(result) < length:
        if time.monotonic() >= deadline:
            raise TimeoutError(f"received {len(result)} of {length} screenshot bytes")
        chunk = port.read(length - len(result))
        if chunk:
            result.extend(chunk)
    return bytes(result)


def wait_for_header(port: serial.Serial, deadline: float) -> tuple[int, int]:
    buffered = bytearray()
    while time.monotonic() < deadline:
        value = port.read(1)
        if not value:
            continue
        buffered.extend(value)
        if value != b"\n":
            if len(buffered) > 512:
                del buffered[:-256]
            continue
        line = bytes(buffered).strip()
        buffered.clear()
        start = line.find(MAGIC)
        if start < 0:
            continue
        fields = line[start + len(MAGIC):].split()
        if len(fields) != 2:
            continue
        return int(fields[0]), int(fields[1])
    raise TimeoutError("device did not return a screenshot header")


def rgb565(value: int) -> bytes:
    red = ((value >> 11) & 0x1F) * 255 // 31
    green = ((value >> 5) & 0x3F) * 255 // 63
    blue = (value & 0x1F) * 255 // 31
    return bytes((red, green, blue))


def png_chunk(kind: bytes, data: bytes) -> bytes:
    payload = kind + data
    return struct.pack(">I", len(data)) + payload + struct.pack(
        ">I", binascii.crc32(payload) & 0xFFFFFFFF
    )


def write_png(path: Path, width: int, height: int, palette: bytes,
              pixels: bytes) -> None:
    colors = [rgb565(struct.unpack_from("<H", palette, index * 2)[0])
              for index in range(256)]
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        offset = y * width
        for index in pixels[offset:offset + width]:
            rows.extend(colors[index])
    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(bytes(rows), 9))
    png += png_chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def default_port() -> str:
    ports = sorted(glob.glob("/dev/cu.usbmodem*"))
    if not ports:
        raise SystemExit("No /dev/cu.usbmodem device found")
    return ports[0]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default=None)
    parser.add_argument("--output", default="artifacts/device-screen.png")
    parser.add_argument("--timeout", type=float, default=12)
    args = parser.parse_args()
    device = args.port or default_port()
    deadline = time.monotonic() + args.timeout

    with serial.Serial(device, 115200, timeout=0.2, write_timeout=2) as port:
        port.reset_input_buffer()
        port.write(b"\n$SCREENSHOT\n")
        port.flush()
        width, height = wait_for_header(port, deadline)
        palette = read_exact(port, PALETTE_BYTES, deadline)
        pixels = read_exact(port, width * height, deadline)

    output = Path(args.output).resolve()
    write_png(output, width, height, palette, pixels)
    print(output)


if __name__ == "__main__":
    main()
