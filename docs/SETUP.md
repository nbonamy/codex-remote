# Setup from a clean clone

This guide starts with a Mac, an unconfigured Waveshare
ESP32-S3-Touch-AMOLED-1.8, and no Codex Remote checkout. At the end, the device
can discover the Mac, pair with the host, browse Codex conversations, record a
prompt, and play a reply.

## 1. Check the requirements

You need:

- A Mac running an authenticated Codex desktop experience.
- Node.js 22 or newer and npm.
- Git.
- Python 3 and PlatformIO Core (`pio`) for firmware builds.
- A USB-C data cable. Charge-only cables cannot flash or capture screenshots.
- A 2.4 GHz Wi-Fi network that the ESP32 can join.
- The Mac and ESP32 on the same LAN, without guest/client isolation between
  them.

The ESP32 supports 2.4 GHz 802.11 b/g/n, not 5 GHz. The Mac itself may be on
5 GHz or Ethernet as long as the router bridges both clients onto the same
local network.

### Install PlatformIO Core

Use the
[official isolated installer](https://docs.platformio.org/en/latest/core/installation/methods/installer-script.html):

```bash
curl -fsSL -o get-platformio.py \
  https://raw.githubusercontent.com/platformio/platformio-core-installer/master/get-platformio.py
python3 get-platformio.py
```

Follow the installer's instructions to add `pio` to the shell path, then verify:

```bash
node --version
npm --version
pio --version
```

The PlatformIO VS Code extension is also useful, but this repository's npm
commands require the `pio` CLI to be available in the terminal.

## 2. Clone the two repositories

`codex-app-sdk` is not published to npm yet. Codex Remote intentionally uses a
local sibling checkout, so the directory names and layout matter:

```text
src/
├── codex-app-sdk/
└── codex-remote/
```

Create that layout and install both projects:

```bash
mkdir -p ~/src
cd ~/src
git clone https://github.com/nbonamy/codex-app-sdk.git
git clone https://github.com/nbonamy/codex-remote.git

cd ~/src/codex-app-sdk
npm install
npm run build

cd ~/src/codex-remote
npm install
```

Do not replace the `file:../codex-app-sdk` dependency with the raw Git URL. The
SDK contains internal npm workspaces that currently need the complete sibling
checkout and its build output.

## 3. Codex app-server connection

The `Codex` agent prefers to reuse the app-server owned by the desktop Codex
session through this Unix socket:

```text
~/.codex/app-server-control/app-server-control.sock
```

You can check whether that preferred connection is available:

```bash
test -S ~/.codex/app-server-control/app-server-control.sock \
  && echo "Codex socket ready" \
  || echo "Codex socket missing"
```

If it is missing, Codex Remote automatically starts a managed stdio app-server
using `~/.codex`, so no special desktop launch mode is required. To explicitly
enable the shared daemon in the ChatGPT macOS application, use:

```bash
CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 \
  /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
```

With the shared daemon enabled, keep the desktop app running. Codex Remote
connects as a second client; it does not attach to a PID or inject prompts
through deep links. Without it, the managed fallback remains available for the
lifetime of Codex Remote.

The optional `Claw` agent uses a managed app-server under:

```text
~/.codex-claw/codex-home
```

It is independent of the shared `Codex` socket and may require its own Codex
authentication state.

## 4. Start the host

For development:

```bash
cd ~/src/codex-remote
npm run dev
```

For a normal local macOS application:

```bash
cd ~/src/codex-remote
npm run install:mac
open -a "Codex Remote"
```

Codex Remote is a menu-bar application and does not open a normal window. Its
menu should show an overall Ready state and the status of each agent.

Only run one Codex Remote host at a time. Two copies compete for TCP port 47776
and the same Bonjour service.

No OpenAI API key is required. Keyless voice behavior is explained in
[Configuration and secrets](CONFIGURATION.md).

## 5. Back up the factory firmware

Flashing Codex Remote replaces the runnable Waveshare firmware. Before the
first upload, make one full-flash backup for this specific board.

Install Espressif's
[`esptool`](https://docs.espressif.com/projects/esptool/en/latest/esp32s3/)
if necessary:

```bash
python3 -m pip install --user --upgrade esptool
```

Connect the board with a data cable and find its port:

```bash
pio device list
```

On macOS it is commonly `/dev/cu.usbmodem...`. Substitute the real port below:

```bash
esptool --chip esp32s3 --port /dev/cu.usbmodemXXXX flash-id
esptool --chip esp32s3 --port /dev/cu.usbmodemXXXX \
  read-flash 0 ALL waveshare-factory-backup.bin
shasum -a 256 waveshare-factory-backup.bin \
  > waveshare-factory-backup.bin.sha256
```

Keep both files somewhere private and backed up. A full flash image can contain
device-specific settings or credentials and should not be committed or shared.

To restore it later:

```bash
shasum -a 256 -c waveshare-factory-backup.bin.sha256
esptool --chip esp32s3 --port /dev/cu.usbmodemXXXX \
  write-flash 0 waveshare-factory-backup.bin
```

If automatic bootloader entry fails, hold BOOT while connecting or resetting
the board, start the command, then release BOOT once the transfer begins.

## 6. Configure Wi-Fi

Create the ignored firmware credential file:

```bash
cd ~/src/codex-remote
cp firmware/waveshare/src/credentials.h.example \
  firmware/waveshare/src/credentials.h
```

Edit `firmware/waveshare/src/credentials.h`:

```cpp
#pragma once

#define CODEX_REMOTE_WIFI_SSID "My 2.4 GHz network"
#define CODEX_REMOTE_WIFI_PASSWORD "replace-with-the-wifi-password"

#define CODEX_REMOTE_SERVER_HOST ""
#define CODEX_REMOTE_SERVER_PORT 47776
```

Leave `CODEX_REMOTE_SERVER_HOST` empty for normal mDNS discovery. If multicast
DNS is unavailable on the LAN, set it to the Mac's stable LAN IP address, for
example `"192.168.1.50"`.

This is a C++ string literal. Escape a literal quote as `\"` and a backslash as
`\\`. Other punctuation does not need shell escaping.

The credential file is ignored by Git, but the SSID and password are compiled
into the firmware image. Do not distribute personal firmware binaries.

## 7. Select V1 or V2 and flash

Check the label on the back of the board:

- V1: SH8601 display and FT3168 touch controller.
- V2: CO5300 display and CST820 touch controller.

[Waveshare's compatibility note](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.8)
says current shipments have switched to V2, but the label is authoritative.

Build both variants:

```bash
npm run firmware:build
```

Upload only the matching variant:

```bash
npm run firmware:upload:v2
```

or:

```bash
npm run firmware:upload:v1
```

PlatformIO normally detects the USB port. With multiple serial devices, specify
it directly:

```bash
pio run -d firmware/waveshare \
  -e waveshare-esp32-s3-touch-amoled-1_8-v2 \
  -t upload --upload-port /dev/cu.usbmodemXXXX
```

The generated application binaries are under:

```text
firmware/waveshare/.pio/build/waveshare-esp32-s3-touch-amoled-1_8-v1/firmware.bin
firmware/waveshare/.pio/build/waveshare-esp32-s3-touch-amoled-1_8-v2/firmware.bin
```

## 8. Pair the device

1. Keep Codex Remote running on the Mac.
2. Restart the ESP32 after flashing.
3. Wait for **HOST FOUND**. If it remains on **WAITING FOR HOST**, see
   [Troubleshooting](TROUBLESHOOTING.md).
4. Press PWR to enter host/agent selection.
5. In the Mac menu-bar app, choose **Pair New Device…**.
6. Press PWR on the device if it is waiting for pairing to open.
7. Confirm that the six-digit code matches the pending request in the Mac menu.
8. Approve the request on the Mac.

The device stores a per-host credential in ESP32 NVS and transitions to the
agent or conversation list. Pairing authorizes the physical device for the
host, not separately for every agent.

The host can revoke it later under **Paired Devices → Revoke Access**. A revoked
device is disconnected and must go through pairing again.

## 9. Smoke test

1. Select **Codex** on the device.
2. Open an existing conversation or choose **Create**.
3. Tap PWR, speak, and tap PWR again; or hold PWR while speaking and release.
4. Confirm the recognized user message appears.
5. Wait for the final assistant reply.
6. Tap the assistant message card to read it aloud.

On macOS this works without `OPENAI_API_KEY`; Apple provides transcription and
speech synthesis. To enable OpenAI neural speech, continue with
[Configuration and secrets](CONFIGURATION.md).
