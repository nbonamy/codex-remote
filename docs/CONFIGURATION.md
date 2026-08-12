# Configuration and secrets

Codex Remote has two independent configuration locations:

- Host environment settings on the desktop Mac.
- Compile-time network settings in ESP32 firmware.

Do not put desktop API credentials in the firmware configuration.

## Host environment

The example file is `.env.example`:

```dotenv
OPENAI_API_KEY=
CODEX_REMOTE_TTS_MODEL=gpt-4o-mini-tts
CODEX_REMOTE_TTS_VOICE=marin
CODEX_REMOTE_TTS_INSTRUCTIONS=Speak naturally in English with a warm, conversational tone, clear pacing, and subtle expression.
```

### Development location

Copy it into the repository root:

```bash
cp .env.example .env.local
chmod 600 .env.local
```

### Installed macOS application location

The packaged application reads:

```text
~/Library/Application Support/codex-remote/.env.local
```

Create it with:

```bash
mkdir -p "$HOME/Library/Application Support/codex-remote"
cp .env.example \
  "$HOME/Library/Application Support/codex-remote/.env.local"
chmod 600 \
  "$HOME/Library/Application Support/codex-remote/.env.local"
```

Restart Codex Remote after editing environment configuration.

Both `.env.local` locations are ignored by Git. Never commit, paste into an
issue, or copy an API key into `credentials.h`.

## OpenAI key behavior

`OPENAI_API_KEY` is optional on macOS.

### Without a key

- Device microphone PCM is sent over the authenticated local WebSocket.
- The Mac transcribes it with the Apple SpeechAnalyzer helper from
  `codex-app-sdk`.
- The transcript is submitted to the existing ChatGPT-authenticated Codex
  session as an ordinary text command.
- Assistant read-aloud uses `/usr/bin/say` with the Samantha voice, converts the
  result to mono PCM16LE at 24 kHz, and streams it to the device.

This is the tested fallback path. The unit test in
`tests/openai-speech.spec.ts` verifies that a keyless macOS host selects Apple
speech.

### With a key

- New recordings first attempt Codex realtime voice when the connected agent
  supports it.
- If realtime startup fails on macOS, the host falls back to local Apple
  transcription.
- Assistant read-aloud calls the OpenAI speech endpoint with
  `gpt-4o-mini-tts` and the `marin` voice by default.
- If that OpenAI request fails before audio streaming starts, the host logs the
  error and falls back to Apple speech.

The API key remains on the Mac. It is not returned by the LAN API, advertised
over mDNS, included in pairing data, or sent to the ESP32.

### Speech override variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | Enables OpenAI-backed voice paths. |
| `CODEX_REMOTE_TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI speech model. |
| `CODEX_REMOTE_TTS_VOICE` | `marin` | OpenAI speech voice. |
| `CODEX_REMOTE_TTS_INSTRUCTIONS` | English conversational prompt | Speaking style and delivery. |

These overrides affect OpenAI speech only. The Apple fallback currently uses
the Samantha voice.

## Other host variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_REMOTE_PORT` | `47776` | TCP port for HTTP and the device WebSocket. |

Example:

```bash
CODEX_REMOTE_PORT=47776 npm run dev
```

Changing the port also requires changing `CODEX_REMOTE_SERVER_PORT` in firmware
and reflashing the device.

Codex Remote does not inject a working directory when it creates a thread. The
app-server chooses its normal context instead of every device conversation
being tied to one host folder.

## Firmware network configuration

Create this ignored file:

```bash
cp firmware/waveshare/src/credentials.h.example \
  firmware/waveshare/src/credentials.h
```

Its fields are:

| Macro | Required | Meaning |
| --- | --- | --- |
| `CODEX_REMOTE_WIFI_SSID` | yes | A 2.4 GHz Wi-Fi network name. |
| `CODEX_REMOTE_WIFI_PASSWORD` | yes for secured Wi-Fi | The network password. |
| `CODEX_REMOTE_SERVER_HOST` | no | Empty for mDNS; otherwise a fixed host IP/name. |
| `CODEX_REMOTE_SERVER_PORT` | yes | Must match the host port; default `47776`. |

The firmware waits up to 15 seconds for Wi-Fi during startup. It refreshes host
discovery every five seconds when no host is selected.

### mDNS mode

The recommended empty host value discovers `_codex-remote._tcp.local`. It lets
the Mac's IP address change and supports host selection.

The LAN must allow:

- multicast DNS on UDP 5353
- direct ESP32-to-Mac TCP traffic on port 47776
- communication between wireless clients

Guest Wi-Fi, client isolation, some VPNs, and restrictive firewalls commonly
block one of those paths.

### Fixed-host mode

If mDNS is blocked but direct LAN traffic works, set the Mac's stable IP:

```cpp
#define CODEX_REMOTE_SERVER_HOST "192.168.1.50"
#define CODEX_REMOTE_SERVER_PORT 47776
```

Rebuild and flash after any firmware configuration change.

## Stored local state

### On the ESP32

The firmware stores these values in NVS:

- paired host identifiers and per-device tokens
- selected agent/host state
- auto-read preference
- brightness
- screen auto-sleep duration

A normal firmware upload may preserve NVS. Erasing the full flash clears it.

### On macOS

Electron user data stores:

- the host's generated device token
- paired-device records and revocations
- the packaged app's optional `.env.local`

Revoking a device from the menu immediately closes matching device sessions.

The device has no UI for reviewing Codex tool approvals. Threads created by
Codex Remote therefore use workspace-write permissions with interactive
approvals disabled. If an older thread asks for an approval inherited from
another client, the host denies it automatically so the turn can continue and
report the denied action instead of remaining stuck on **Thinking**.

Codex Remote also injects device-specific developer instructions whenever it
starts or resumes a conversation. They ask Codex to keep final answers short,
plain, self-contained, suitable for speech, and free of links unless requested.
These instructions are supplied by the Codex Remote surface only; they are not
saved as global Codex memory and are not added to the visible user prompt.

## Network security boundary

Pairing metadata and the agent catalog are discoverable so an unpaired device
can begin the pairing flow. Conversation and command routes require the
per-device token. Pairing requests are accepted only during the two-minute
window opened from the Mac menu, and approval requires matching a six-digit
code.

The current transport is designed for a trusted local network. It is HTTP and
WebSocket over LAN, not TLS, and should not be exposed through router port
forwarding or a public interface.
