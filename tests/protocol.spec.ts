import { describe, expect, it } from 'vitest';
import {
  parseDeviceCommand,
  REALTIME_SAMPLE_RATE,
} from '../src/server/protocol';

describe('device protocol', () => {
  it('accepts only the realtime backend PCM sample rate', () => {
    expect(parseDeviceCommand({
      type: 'audio_start',
      threadId: 'thread-1',
    })).toStrictEqual({
      type: 'audio_start',
      threadId: 'thread-1',
      sampleRate: REALTIME_SAMPLE_RATE,
    });
    expect(() => parseDeviceCommand({
      type: 'audio_start',
      sampleRate: 16_000,
    })).toThrow('Only 24 kHz microphone audio is supported');
  });

  it('bounds device commands before they reach Codex', () => {
    expect(() => parseDeviceCommand({
      type: 'send_text',
      text: '',
    })).toThrow('text must be a non-empty string');
    expect(() => parseDeviceCommand({
      type: 'unknown',
    })).toThrow("Unknown control frame 'unknown'");
  });
});
