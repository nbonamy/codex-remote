# Troubleshooting

## Device says `WI-FI UNAVAILABLE`

Check:

- `firmware/waveshare/src/credentials.h` exists.
- The SSID is a 2.4 GHz network; the ESP32 cannot join a 5 GHz-only SSID.
- The password is correct.
- Quotes and backslashes are escaped as C++ string-literal characters.
- The firmware was rebuilt and reflashed after editing credentials.

Open the serial monitor for the detailed startup log:

```bash
npm run firmware:monitor
```

## Device stays on `WAITING FOR HOST`

Verify the Mac host is running and ready. Then check:

- Mac and ESP32 are on the same LAN.
- Guest Wi-Fi/client isolation is disabled.
- macOS firewall permits Codex Remote to accept incoming connections.
- A VPN is not routing or blocking multicast/local traffic.
- UDP 5353 mDNS and TCP 47776 are allowed.
- Only one Codex Remote instance is running.

If direct LAN traffic works but mDNS does not, set
`CODEX_REMOTE_SERVER_HOST` in `credentials.h` to the Mac's LAN IP, rebuild, and
reflash.

Discovery refreshes every five seconds while no host is selected. Quitting the
Mac app should eventually return the device to a host-unavailable state;
restarting it should make the host visible again.

## Host is found but the device is not paired

1. Open **Pair New Device…** in the Mac menu.
2. Press PWR on the device.
3. Match the six-digit code.
4. Approve the pending request on the Mac.

The pairing window lasts two minutes. If it expires, open it again.

If the device was revoked, its saved token is no longer valid. The host returns
an authorization failure, the firmware clears that host pairing, and the device
must pair again.

## Agent list is empty or Codex shows an error

For the `Codex` agent, verify the shared socket:

```bash
ls -l ~/.codex/app-server-control/app-server-control.sock
```

An error such as:

```text
connect ENOENT .../.codex/app-server-control/app-server-control.sock
```

means the desktop-owned daemon socket does not exist. Fully quit and relaunch
the desktop Codex application with `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`, then
restart Codex Remote.

The optional `Claw` profile uses `~/.codex-claw/codex-home`; check its separate
authentication state if only that agent fails.

## Pairing or mDNS crashes with `EHOSTUNREACH` or `EADDRINUSE`

Make sure an older Codex Remote process is not still running. Port 5353 belongs
to the system mDNS responder and should not be bound as a normal exclusive UDP
server. The current macOS host publishes through `/usr/bin/dns-sd`, with the
Bonjour library as a non-macOS fallback.

Quit all stale Codex Remote instances, wait a moment for their sockets to close,
and start one copy.

## Firmware upload cannot find the board

Run:

```bash
pio device list
```

If no `/dev/cu.usbmodem...` device appears:

- Try a known USB data cable.
- Connect directly rather than through an unreliable hub.
- Hold BOOT while plugging in or resetting the board.
- Start the upload and release BOOT when transfer begins.

With multiple serial devices, pass `--upload-port` explicitly as shown in the
[setup guide](SETUP.md).

## Screen is black, garbled, or touch is wrong after flashing

Confirm the board revision label and flash the matching environment:

- V1: `npm run firmware:upload:v1`
- V2: `npm run firmware:upload:v2`

V1 and V2 use different display controllers. Reflashing the correct build does
not require erasing the device first.

## Push-to-talk records but no prompt appears

On macOS without an API key, approve any requested Speech Recognition
permission and check the host logs for Apple SpeechAnalyzer errors.

With `OPENAI_API_KEY`, the host first tries realtime voice and falls back to
Apple transcription when realtime startup fails. Restart the host after
changing `.env.local`.

Record for longer than a quick click and less than 45 seconds. BOOT cancels an
active recording.

## Assistant read-aloud does not play

Without an OpenAI key, macOS should still synthesize with Apple `say`. Test the
system voice directly:

```bash
/usr/bin/say -v Samantha "Codex Remote speech test"
```

If OpenAI speech is configured, inspect host logs. A failed request should fall
back to Apple speech if it fails before streaming begins. Restart Codex Remote
after editing `.env.local`.

Check device volume, stop any current playback, and confirm the message is an
assistant message with readable text.

## Device appears frozen on a long conversation

Current firmware requests only the latest five turns with `itemsView: summary`.
It never asks for older history. If opening a long thread is still slow, inspect
host timing around the summary `thread/turns/list` request and the active Codex
app-server rather than increasing the device history window.

## Screenshot capture fails

Close `npm run firmware:monitor` or any other serial terminal first; only one
process can own the serial port. Then run:

```bash
npm run device:screenshot
```

Specify `--port` when more than one `/dev/cu.usbmodem...` device exists. The
script uses PlatformIO's Python environment when `pyserial` is not installed in
the system interpreter.

## Restore the factory firmware

Use the full backup made before the first flash:

```bash
shasum -a 256 -c waveshare-factory-backup.bin.sha256
esptool --chip esp32s3 --port /dev/cu.usbmodemXXXX \
  write-flash 0 waveshare-factory-backup.bin
```

The backup is board-specific and may contain private configuration. Do not use
an untrusted image or publish the backup.
