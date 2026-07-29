# Codex Remote

A pocket remote for local Codex threads.

Codex Remote has two parts:

1. A cross-platform Electron host built on `codex-app-sdk`. It launches Codex
   app-server, exposes a token-protected LAN HTTP/WebSocket API, advertises
   itself with mDNS, and bridges push-to-talk audio into Codex.
2. Native PlatformIO/Arduino firmware for the Waveshare
   ESP32-S3-Touch-AMOLED-1.8. It browses threads, reads recent messages, and
   streams the board microphone while BOOT is held.

The menu-bar app serves the real device client as a 368 x 448 HTML simulator.
This is the fastest way to iterate before the board arrives.

## Current interaction

- Thread list: tap a thread to open it; swipe down for the next page and up for
  the previous page.
- Thread list: press BOOT to create and open a new thread.
- Thread list: press PWR to disconnect and choose another discovered bridge.
- Bridge list: tap a paired bridge to reconnect, or tap a new bridge to request
  pairing. Confirm the matching six-digit code from the Mac menu-bar app.
- Bridge list: press BOOT to rescan and PWR to return to the current bridge.
- Conversation: hold BOOT to talk; release to transcribe and send to Codex.
- Conversation: tap the back arrow to return to the thread list.
- Conversation: swipe down for the next message page and up for the previous
  page. Complete messages are retained; long messages continue across pages.
- After push-to-talk, the reader switches to page one of the new response.
  Streaming fills that page and buffers overflow without moving the reader.
- The HTML simulator has the same interactions. Arrow keys page, Escape goes
  back, and Space is push-to-talk.

### Simulator

Run `npm run dev`, open the menu-bar item, and choose **Open Device Simulator**
while the hardware is unavailable. The simulator opens in the default browser
and connects to the same WebSocket and Codex app-server as the firmware.

This is a behavioral and visual emulator, not instruction-level ESP32
emulation. General ESP32 emulators do not model this board's custom
SH8601/CO5300 AMOLED, FT3168/CST820 touch controller, ES8311 audio codec, and
AXP2101 power-management hardware.

## Desktop development

Requirements: Node 22+, Codex CLI, and an authenticated Codex installation.

```bash
npm install
npm run dev
```

The API listens on `0.0.0.0:47776` by default. The app keeps a persistent
bridge identity and issues a different credential to every approved device.
Override the defaults for development with:

```bash
CODEX_REMOTE_PORT=47776 \
CODEX_REMOTE_CWD="$HOME/src" \
npm run dev
```

On macOS, push-to-talk uses the Apple SpeechAnalyzer helper packaged by
`codex-app-sdk`, then sends the transcript as an ordinary Codex text command.
The ESP32 and bridge therefore work with the user's normal ChatGPT-authenticated
Codex session and do not need an OpenAI API key.

App-server's experimental `thread/realtime/start` path is optional and requires
OpenAI API key authentication. Codex Remote only attempts it when the connected
Codex account is API-key authenticated or the bridge process has
`OPENAI_API_KEY`. In that mode Codex owns transcription and returns live
transcript and synthesized audio events. The bridge enables the child
app-server's `realtime_conversation` feature without modifying the user's
global Codex configuration or starting an Electron renderer.

Windows and Linux builds can still browse threads and send text, but voice
currently requires API-key-backed Codex realtime because they do not yet have a
local transcription backend. The keyless macOS path returns transcripts and
normal Codex messages; synthesized speaker audio is currently realtime-only.

The browser simulator asks the browser for microphone access from its loopback
`http://127.0.0.1` origin. The ESP32 sends the same PCM stream over the
authenticated device WebSocket.

## API

The ESP32 uses one persistent authenticated WebSocket for normal communication:
JSON frames carry navigation, commands, transcripts, and state; binary frames
carry microphone and speaker PCM. It only uses HTTP while pairing: it creates a
short-lived request and polls for explicit approval from the desktop tray.
HTTP also remains useful for diagnostics, external integrations, and serving
the HTML simulator.

Normal `/api/v1/*` routes require `X-Codex-Remote-Token`. The pairing
information and request routes are intentionally unauthenticated, but a request
can only be created during the two-minute window opened by **Pair New Device…**
in the menu-bar app.

```text
GET  /health
GET  /api/v1/pairing/info
POST /api/v1/pairing/requests
GET  /api/v1/pairing/requests/:id
GET  /api/v1/state
GET  /api/v1/threads
GET  /api/v1/threads/:id/messages
POST /api/v1/threads
POST /api/v1/threads/:id/messages
POST /api/v1/threads/:id/interrupt
WS   /api/v1/device
```

The device WebSocket authenticates with its per-device credential in the same
header and accepts JSON
control frames plus raw mono PCM16LE audio frames at 24 kHz between
`audio_start` and `audio_end`. In realtime mode, releasing push-to-talk appends
a short silence tail so server-side VAD commits the utterance without
destroying the multi-turn session.

## Firmware

Install the PlatformIO CLI, then:

```bash
cp firmware/waveshare/src/credentials.h.example \
  firmware/waveshare/src/credentials.h
```

Fill in the Wi-Fi credentials. Leave `SERVER_HOST` empty to discover every
Electron bridge through `_codex-remote._tcp.local`, then press PWR on the
thread list to choose and pair one. `DEVICE_TOKEN` is only an optional
migration fallback for firmware paired with older host builds.

```bash
npm run firmware:build
npm run firmware:upload:v2
npm run firmware:monitor
```

Waveshare now ships two board revisions. The build command produces firmware
for both: V1 uses SH8601/FT3168 and V2 uses CO5300/CST820. Current shipments
default to V2; check the label on the back and use `firmware:upload:v1` when
needed. Both builds use the same touch paging and application UI.

The firmware pins the pioarduino ESP32 platform because this board support
uses the Arduino 3 `ESP_I2S` API. PlatformIO may maintain an internal
`~/.platformio/penv` for platform build scripts even when the `pio` executable
itself was installed with pipx; that directory is not the active CLI install.

The generated binaries are under:

- `firmware/waveshare/.pio/build/waveshare-esp32-s3-touch-amoled-1_8-v1/firmware.bin`
- `firmware/waveshare/.pio/build/waveshare-esp32-s3-touch-amoled-1_8-v2/firmware.bin`

## Sources

The hardware bring-up and ES8311 audio path are adapted from
[steveruizok/chat-stick](https://github.com/steveruizok/chat-stick), which
already supports this exact Waveshare board. The framed local-audio and mDNS
design was informed by
[nicosuave/m5mic](https://github.com/nicosuave/m5mic). See `third-party/`.

## Local macOS install

Build and install the current checkout without signing or notarization:

```bash
npm run install:mac
```

The target stops any running `Codex Remote` instance and atomically replaces
`/Applications/Codex Remote.app`. It packages only the current Mac architecture;
use the signed release workflow below for distributable artifacts.

## Signed macOS release

The macOS release uses a Developer ID Application certificate, Hardened Runtime,
and Apple notarization. By default, the packaging script reads the existing
credentials from `../witsy/.env` without copying them into this repository.

```bash
npm run dist
```

The credential file must define:

- `IDENTIFY_DARWIN_CODE` (or standard `CSC_NAME`)
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_PASSWORD` (or standard `APPLE_APP_SPECIFIC_PASSWORD`)

To use another credential file:

```bash
CODEX_REMOTE_SIGNING_ENV=/absolute/path/to/signing.env npm run dist:mac
```

For CI, the standard variables can instead be supplied directly in the process
environment without a credential file.

Successful packaging creates DMG and ZIP artifacts under `release/`, then
verifies the application signature, Gatekeeper assessment, and stapled
notarization ticket. Signing credentials are never copied into this repository
or packaged artifacts and local `.env` files are excluded from Git.
