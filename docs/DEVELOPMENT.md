# Development, architecture, and releases

## Repository layout

```text
src/main/                 Electron main process and host integrations
src/renderer/             Menu-bar renderer
src/server/               LAN API, pairing, protocol, history, and simulator
firmware/waveshare/       PlatformIO ESP32-S3 firmware
scripts/                  macOS packaging and screenshot tools
tests/                    Vitest host/server tests
```

The project consumes a sibling `../codex-app-sdk` checkout. Build that SDK
before installing or developing Codex Remote.

## Host architecture

The Electron main process:

1. Loads `.env.local`.
2. Opens the persisted pairing store and host token.
3. Connects the `Codex` surface to
   `~/.codex/app-server-control/app-server-control.sock` when available, or
   starts a managed stdio app-server under `~/.codex` as a fallback.
4. Starts a managed stdio surface for the optional `Claw` profile.
5. Starts one HTTP/WebSocket server on `0.0.0.0:47776`.
6. Advertises `_codex-remote._tcp.local` over Bonjour/mDNS.

Each device pairs with the host once. Every agent-scoped route includes an
agent id, so one host advertisement can expose multiple Codex-backed agents.

## Device transport

Normal operation uses one persistent authenticated WebSocket:

- JSON frames carry navigation, commands, transcripts, thread summaries, and
  state.
- Binary frames carry mono PCM16LE microphone/speaker audio at 24 kHz.

HTTP is used while pairing and for diagnostics/simulator assets.

The relevant routes are:

```text
GET  /health
GET  /api/v1/pairing/info
POST /api/v1/pairing/requests
GET  /api/v1/pairing/requests/:id
GET  /api/v1/agents
GET  /api/v1/agents/:agentId/state
GET  /api/v1/agents/:agentId/threads
GET  /api/v1/agents/:agentId/threads/:id/messages
POST /api/v1/agents/:agentId/threads
POST /api/v1/agents/:agentId/threads/:id/messages
POST /api/v1/agents/:agentId/threads/:id/interrupt
WS   /api/v1/agents/:agentId/device
```

The device-history adapter calls `thread/turns/list` with `limit: 5`, descending
sort, and `itemsView: summary`, reverses the page into chronological order, and
never requests older history.

## Local development

Requirements: Node 22+ and an already-built sibling SDK. A shared Codex socket
is preferred but optional because the host can start its own app-server.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run typecheck
npm run build
npm run firmware:build
```

The firmware build compiles both board environments. Upload commands compile
and flash only the selected board revision.

## Simulator

Run `npm run dev`, open the Codex Remote menu-bar item, and choose **Open Device
Simulator**. The simulator is served from loopback and connects to the same
WebSocket and Codex app-server as real firmware.

It is a behavioral and visual emulator, not instruction-level ESP32 emulation.
General ESP32 emulators do not model this board's display, touch, ES8311 audio,
and AXP2101 power-management hardware.

Simulator controls mirror the device: Escape is BOOT, Space is PWR, and arrow
keys page through content. Browser microphone access is required for simulated
recording.

## Firmware details

PlatformIO pins the pioarduino ESP32 platform because board support uses the
Arduino 3 `ESP_I2S` API. Both environments use:

- 16 MB flash
- QIO OPI memory mode
- USB CDC on boot
- PSRAM
- Arduino GFX, U8g2, XPowersLib, ArduinoJson, and ArduinoWebsockets

V1 selects SH8601 display behavior. V2 selects CO5300 display behavior. Touch
controller probing supports FT3168 and CST820 at runtime, but the display
environment must still match the board revision.

## Local macOS install

Build and atomically replace the unsigned local application:

```bash
npm run install:mac
```

The script stops a running Codex Remote instance, packages the current Mac
architecture, and installs `/Applications/Codex Remote.app`.

The installed app reads optional voice configuration from:

```text
~/Library/Application Support/codex-remote/.env.local
```

## Signed macOS release

The release pipeline uses a Developer ID Application certificate, Hardened
Runtime, notarization, Gatekeeper assessment, and stapling verification.

```bash
npm run dist
```

By default, the packaging script reads signing values from `../witsy/.env`
without copying them into this repository. Override that path with:

```bash
CODEX_REMOTE_SIGNING_ENV=/absolute/path/to/signing.env npm run dist:mac
```

The credential source must provide:

- `CSC_NAME` or legacy `IDENTIFY_DARWIN_CODE`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD` or legacy `APPLE_PASSWORD`

CI may supply the standard variables directly. Successful artifacts are
written under `release/` and then checked with `codesign`, `spctl`, and
`stapler`.

## Test coverage worth preserving

- Pairing window, approval, revocation, persistence, and authorization.
- Device protocol parsing and message shaping.
- Five-turn summary-only history loading.
- Apple keyless speech selection and OpenAI-to-Apple fallback.
- Streamed OpenAI PCM responses.
- Server recording, transcription, prompting, and read-aloud behavior.
- Tray menu pairing and device-revocation actions.
