# Codex Remote

<p align="center">
  <img src="docs/images/codex-remote-hero.png" alt="Codex Remote pocket voice remote product banner" width="100%">
</p>

Codex Remote turns a
[Waveshare ESP32-S3-Touch-AMOLED-1.8](https://www.amazon.com/dp/B0DW8Z8ZYF)
into a pocket controller for Codex conversations running on a desktop computer.

The project has two parts:

- A macOS Electron host that connects to the desktop-owned Codex app-server
  when available, otherwise starts one itself, advertises on the local network,
  pairs devices, and relays realtime or legacy voice traffic.
- Native PlatformIO/Arduino firmware for the Waveshare board. It discovers
  hosts, lists agents and conversations, records prompts, displays the latest
  five summarized turns, and plays assistant replies.

The host and device communicate only over the local network. The ESP32 does not
connect directly to Codex or store an OpenAI API key.

## Supported setup

The complete voice experience currently targets:

- macOS host
- [Waveshare ESP32-S3-Touch-AMOLED-1.8 V1 or V2](https://www.amazon.com/dp/B0DW8Z8ZYF)
- 2.4 GHz Wi-Fi for the ESP32; the Mac may use any band on the same LAN
- an authenticated Codex desktop session

Windows and Linux can run much of the host code, but local transcription and
Apple speech fallback are macOS-specific. They are not yet the recommended
first-install path.

## The device experience

These are framebuffer captures from the real 368 x 448 AMOLED firmware. Click
any screen to inspect it at native resolution.

<table>
  <tr>
    <td align="center">
      <a href="docs/images/device-threads.png"><img src="docs/images/device-threads.png" alt="Conversation list" width="150"></a><br>
      <sub><strong>Browse</strong></sub>
    </td>
    <td align="center">
      <a href="docs/images/device-user-message.png"><img src="docs/images/device-user-message.png" alt="User message" width="150"></a><br>
      <sub><strong>Ask</strong></sub>
    </td>
    <td align="center">
      <a href="docs/images/device-assistant-message.png"><img src="docs/images/device-assistant-message.png" alt="Assistant reply" width="150"></a><br>
      <sub><strong>Read</strong></sub>
    </td>
    <td align="center">
      <a href="docs/images/device-recording.png"><img src="docs/images/device-recording.png" alt="Voice recording" width="150"></a><br>
      <sub><strong>Speak</strong></sub>
    </td>
    <td align="center">
      <a href="docs/images/device-settings.png"><img src="docs/images/device-settings.png" alt="Device settings" width="150"></a><br>
      <sub><strong>Tune</strong></sub>
    </td>
  </tr>
</table>

## Start here

For a new machine and device, follow [Setup from a clean clone](docs/SETUP.md).
It covers prerequisites, the SDK checkout, factory-firmware backup, Wi-Fi,
building and flashing V1/V2 firmware, the macOS host, pairing, and a smoke test.

The short version is:

1. Clone `codex-app-sdk` and `codex-remote` beside each other.
2. Install and build the SDK, then install Codex Remote.
3. Back up the factory flash before the first upload.
4. Copy `credentials.h.example` to the ignored `credentials.h` and enter a
   2.4 GHz Wi-Fi SSID and password.
5. Build and flash the firmware matching the V1/V2 label on the board.
6. Start or install the macOS host, open pairing, and approve the code shown on
   the device.

## Voice paths and the optional OpenAI API key

The dedicated Voice Chat uses the authenticated Codex app-server realtime
session. The device streams PCM audio in; app-server returns transcription
events and PCM audio deltas, which the host forwards directly to the screen and
speaker. This path does not use Codex Remote's legacy transcription or TTS
services, and does not fall back to them.

Existing Codex threads keep the older text-turn workflow: Apple transcribes the
recording, Codex receives the resulting text prompt, and the final answer is
read with Apple speech. An optional `OPENAI_API_KEY` changes only that last
read-aloud step to OpenAI TTS, with Apple speech as fallback. It must never be
added to ESP32 `credentials.h`.

Voice Chat is hands-free after launch: press PWR once to start, speak naturally
across multiple turns, and press BOOT to end it.

See [Configuration and secrets](docs/CONFIGURATION.md) for exact `.env.local`
locations, override variables, security boundaries, and the full voice matrix.

## Device controls

The physical-button convention is consistent throughout the firmware:

- **BOOT = Back or cancel**
- **PWR = Confirm or perform the primary action**

In a conversation, PWR supports both recording styles without a setting:

- Tap PWR to start, speak, then tap PWR again to send.
- Hold PWR for roughly half a second, speak while holding, then release to send.

Starting either recording mode immediately interrupts assistant read-aloud.

The PMU's hardware long-press shutdown is temporarily disabled while recording,
so push-to-talk cannot turn the board off. Outside recording, holding PWR for
about ten seconds powers the device down.

Tap the status pill at the top of any screen to open device settings. Settings
include auto-read, brightness, and screen auto-sleep. See
[Using the device](docs/DEVICE.md) for every screen, gesture, and setting.

## Documentation

- [Setup from a clean clone](docs/SETUP.md)
- [Configuration and secrets](docs/CONFIGURATION.md)
- [Using the device](docs/DEVICE.md)
- [Development, architecture, and releases](docs/DEVELOPMENT.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

## Common development commands

```bash
npm run dev
npm test
npm run typecheck
npm run build
npm run firmware:build
npm run firmware:upload:v2
npm run firmware:monitor
npm run device:screenshot
```

The browser simulator is available from **Open Device Simulator** in the host's
menu-bar item. It uses the real host API and is the fastest way to iterate on
behavior before flashing hardware.

## Hardware and upstream sources

The firmware targets the
[Waveshare ESP32-S3-Touch-AMOLED-1.8](https://www.amazon.com/dp/B0DW8Z8ZYF):
a 368 x 448 AMOLED board with a microphone, speaker, capacitive touch,
AXP2101 power management, 8 MB PSRAM, and 16 MB flash. V1 uses the
SH8601/FT3168 display and touch controllers; V2 uses CO5300/CST820.

Hardware bring-up and the ES8311 audio path are adapted from
[steveruizok/chat-stick](https://github.com/steveruizok/chat-stick). The framed
local-audio and mDNS design was informed by
[nicosuave/m5mic](https://github.com/nicosuave/m5mic). See `third-party/` for
licenses and attribution.
