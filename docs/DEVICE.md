# Using the device

## Physical controls

The firmware follows one convention on every screen:

- **BOOT = Back or cancel**
- **PWR = Confirm or primary action**

Touch is used for direct selection. Vertical swipes move through lists and
message pages.

When the screen is asleep, the first touch or button press wakes it and is
consumed; perform the intended action with the next input.

## Connection screen

The initial screen reports Wi-Fi and host discovery state.

- **WAITING FOR HOST** means Wi-Fi is connected but no Codex Remote mDNS host is
  visible.
- **HOST FOUND** means at least one host was discovered.
- **NOT PAIRED** means the host is visible but this device has no valid token.

Press PWR to continue to pairing or agent selection. The screen transitions
automatically as discovery and pairing state changes.

## Pairing and agent selection

Open **Pair New Device…** from the Mac menu. Press PWR on the device to request
pairing, compare the six-digit code, and approve it on the Mac.

After pairing, the agent list can contain:

- **Codex**, backed by the shared desktop Codex socket when available or a
  managed app-server under `~/.codex` otherwise.
- **Claw**, backed by the managed Codex home under
  `~/.codex-claw/codex-home`.

Tap an agent to connect directly. With physical controls, swipe to move the
selection, press PWR to confirm, and press BOOT to go back.

## Conversation list

The list displays five large conversation titles at a time.

- Tap a title to open it.
- Swipe up to advance by four conversations.
- Swipe down to go back by four conversations.
- Tap **Voice Chat** at the bottom or press PWR to open the dedicated voice
  conversation. The first use creates it; later uses reopen its saved thread
  and start listening immediately. Its ID is stored per host/agent and the
  dedicated thread is omitted from the regular conversation list.
- Press BOOT to return to agent selection.

The ESP32 does not hydrate an entire long conversation. It requests only the
latest five turns using app-server's summary view and never loads older history.

## Conversation reader

The reader shows one complete user or assistant message at a time. Long
messages continue across pages.

- Swipe up for the next message/page.
- Swipe down for the previous message/page.
- Press BOOT to return to the conversation list.
- Tap an assistant message to start or stop read-aloud.

Assistant commentary/working text is filtered out. The reader uses final text
content; attachment and media-only parts can appear as short labels rather than
full rich content.

After sending a prompt, the device briefly shows that Codex is thinking and
then follows the new final assistant reply. It does not intentionally jump to
an older assistant message.

## Recording a prompt

In **Voice Chat**, press PWR once from the conversation list to start the live
session. Speak naturally: microphone audio streams continuously and server-side
voice activity detection decides when each utterance is complete. Codex replies
stream back automatically. Press BOOT to end Voice Chat and return to the list.

Inside an existing Codex thread, PWR supports two push-to-submit styles.

Starting either mode immediately stops any assistant read-aloud in progress.
The dedicated Voice Chat uses Codex realtime end-to-end. A conversation opened
from the list uses local transcription, submits the text as an ordinary Codex
prompt, and reads the resulting final answer through TTS.

### Tap to start, tap to end

1. Tap PWR.
2. Release it quickly and speak.
3. Tap PWR again to stop, transcribe, and send.

Press BOOT while recording to cancel.

### Push to talk

1. Hold PWR for at least roughly 550 milliseconds.
2. Speak while holding it.
3. Release PWR to stop, transcribe, and send.

The AXP2101 long-press power-off behavior is disabled for the duration of a
recording and restored afterward, so a long spoken prompt does not turn the
device off.

Recordings are limited to 45 seconds by the host.

## Read-aloud and auto-read

Tap an assistant message card to read it aloud. Tap again to stop playback.

When **Auto-read** is enabled, the final assistant reply is read automatically
after a prompt. Speech is produced by OpenAI when the Mac has a configured key;
otherwise macOS Apple speech is used. See [Configuration and
secrets](CONFIGURATION.md).

Realtime Voice Chat replies are already spoken as they stream and are not
synthesized a second time by Auto-read. No send action is required between
utterances.

## Settings

Tap the status pill across the top of any normal screen to open Settings. The
gear inside the pill is the visual affordance for the panel.

Settings persist in ESP32 NVS:

- **Auto-read**: toggle automatic playback of new final assistant replies.
- **Brightness**: cycle among three display levels.
- **Auto-sleep**: Off, 1 minute, 2 minutes, or 5 minutes.

Use touch to change a row directly. With buttons, swipe to focus a row, press
PWR to change it, and press BOOT to close Settings.

Auto-sleep turns off the AMOLED panel; it does not disconnect Wi-Fi or the host.
The screen stays awake while recording, playing audio, waiting for Codex,
pairing, or processing an active thread operation.

## Status indicators

- Wi-Fi strength is based on the ESP32's current RSSI, not a decorative value.
- Battery and USB power information comes from the AXP2101 PMU.
- Telemetry-driven indicators refresh every 30 seconds.

## Power and restart

- Outside a recording, hold PWR for about ten seconds for PMU hardware
  shutdown.
- To restart, power the device off and press PWR again, or unplug and reconnect
  USB power.
- During recording, long-press shutdown is intentionally disabled until the
  recording ends or is cancelled.

## Capturing a device screenshot

Connect USB and make sure no serial monitor owns the port, then run:

```bash
npm run device:screenshot
```

The default output is:

```text
artifacts/device-screen.png
```

Specify a port or output path when necessary:

```bash
python3 scripts/capture-device-screen.py \
  --port /dev/cu.usbmodemXXXX \
  --output artifacts/example.png
```
