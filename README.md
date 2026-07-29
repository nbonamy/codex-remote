# Codex Remote

A pocket remote for local Codex threads.

Codex Remote has two parts:

1. A cross-platform Electron host built on `codex-app-sdk`. It launches Codex
   app-server, exposes a token-protected LAN HTTP/WebSocket API, advertises
   itself with mDNS, and bridges push-to-talk audio into Codex.
2. Native PlatformIO/Arduino firmware for the Waveshare
   ESP32-S3-Touch-AMOLED-1.8. It browses threads, reads recent messages, and
   streams the board microphone while BOOT is held.

The Electron app also contains the real device client as a 368 x 448 HTML
simulator. This is the fastest way to iterate before the board arrives.

## Current interaction

- Thread list: PWR moves to the next thread; BOOT opens it.
- Conversation: hold BOOT to talk; release to transcribe and send to Codex.
- Conversation: press PWR to return to the thread list.
- The HTML simulator uses the same protocol. Arrow keys move, Enter opens,
  Escape goes back, and Space is push-to-talk.

## Desktop development

Requirements: Node 22+, Codex CLI, and an authenticated Codex installation.

```bash
npm install
npm run dev
```

The API listens on `0.0.0.0:47776` by default. The app generates a random
device token on first launch and displays it alongside the LAN URL. Override
the defaults for development with:

```bash
CODEX_REMOTE_PORT=47776 \
CODEX_REMOTE_CWD="$HOME/src" \
npm run dev
```

The preferred voice path mirrors the Codex desktop app: Electron creates a
WebRTC peer with an audio track and the `oai-events` data channel, then
negotiates it through app-server's experimental `thread/realtime/start`
protocol. Codex owns transcription and returns live transcript and synthesized
audio events. Codex Remote enables the child app-server's
`realtime_conversation` feature without modifying the user's global Codex
configuration.

Realtime voice is currently gated by the Codex service. If negotiation is not
available, the macOS host automatically transcribes the captured utterance with
the Apple SpeechAnalyzer helper packaged by `codex-app-sdk`, then sends the
result as an ordinary text command. This fallback needs no OpenAI API key.
Windows and Linux builds can still browse threads and send text, but voice
currently requires access to Codex realtime because they do not yet have a
local transcription fallback. The local fallback returns transcripts and
normal Codex messages; synthesized speaker audio is a realtime-only feature.

The browser simulator asks Electron for microphone access only from its
loopback `http://127.0.0.1` origin. The ESP32 sends the same PCM stream over
the authenticated device WebSocket.

## API

The ESP32 uses one persistent authenticated WebSocket for all communication:
JSON frames carry navigation, commands, transcripts, and state; binary frames
carry microphone and speaker PCM. It does not call the REST API. HTTP remains
useful for diagnostics, external integrations, and serving the HTML simulator.

All `/api/v1/*` HTTP routes require `X-Codex-Remote-Token`.

```text
GET  /health
GET  /api/v1/state
GET  /api/v1/threads
GET  /api/v1/threads/:id/messages
POST /api/v1/threads
POST /api/v1/threads/:id/messages
POST /api/v1/threads/:id/interrupt
WS   /api/v1/device
```

The device WebSocket authenticates with the same header and accepts JSON
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

Fill in the desktop token and Wi-Fi credentials. Leave `SERVER_HOST` empty to
discover the Electron app through `_codex-remote._tcp.local`, or set it to the
desktop LAN IP.

```bash
npm run firmware:build
npm run firmware:upload
npm run firmware:monitor
```

The firmware pins the pioarduino ESP32 platform because this board support
uses the Arduino 3 `ESP_I2S` API. PlatformIO may maintain an internal
`~/.platformio/penv` for platform build scripts even when the `pio` executable
itself was installed with pipx; that directory is not the active CLI install.

The generated binary is under
`firmware/waveshare/.pio/build/waveshare-esp32-s3-touch-amoled-1_8/firmware.bin`.

## Sources

The hardware bring-up and ES8311 audio path are adapted from
[steveruizok/chat-stick](https://github.com/steveruizok/chat-stick), which
already supports this exact Waveshare board. The framed local-audio and mDNS
design was informed by
[nicosuave/m5mic](https://github.com/nicosuave/m5mic). See `third-party/`.
