import { describe, expect, it } from 'vitest';
import type { SurfaceMessage } from 'codex-app-sdk/surface';
import {
  parseDeviceCommand,
  REALTIME_SAMPLE_RATE,
  toDeviceMessages,
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
      realtime: false,
    });
    expect(parseDeviceCommand({
      type: 'audio_start',
      threadId: 'voice-chat',
      realtime: true,
    })).toStrictEqual({
      type: 'audio_start',
      threadId: 'voice-chat',
      sampleRate: REALTIME_SAMPLE_RATE,
      realtime: true,
    });
    expect(() => parseDeviceCommand({
      type: 'audio_start',
      sampleRate: 16_000,
    })).toThrow('Only 24 kHz microphone audio is supported');
  });

  it('bounds device commands before they reach Codex', () => {
    expect(parseDeviceCommand({ type: 'close_thread' })).toStrictEqual({
      type: 'close_thread',
    });
    expect(parseDeviceCommand({ type: 'audio_cancel' })).toStrictEqual({
      type: 'audio_cancel',
    });
    expect(parseDeviceCommand({
      type: 'open_voice_chat',
      threadId: 'voice-chat',
    })).toStrictEqual({
      type: 'open_voice_chat',
      threadId: 'voice-chat',
    });
    expect(parseDeviceCommand({
      type: 'speak_message',
      threadId: 'thread-1',
      messageId: 'message-1',
    })).toStrictEqual({
      type: 'speak_message',
      threadId: 'thread-1',
      messageId: 'message-1',
    });
    expect(() => parseDeviceCommand({
      type: 'speak_message',
      messageId: '',
    })).toThrow('messageId must be a non-empty string');
    expect(() => parseDeviceCommand({
      type: 'send_text',
      text: '',
    })).toThrow('text must be a non-empty string');
    expect(() => parseDeviceCommand({
      type: 'unknown',
    })).toThrow("Unknown control frame 'unknown'");
  });

  it('preserves complete message text for device-side pagination', () => {
    const text = `first paragraph\n\n${'response '.repeat(600).trim()}`;

    expect(toDeviceMessages([{
      id: 'message-1',
      role: 'assistant',
      status: 'complete',
      parts: [{ type: 'text', text }],
    }])[0]?.text).toBe(text);
  });

  it('keeps conversational content and omits tool activity', () => {
    expect(toDeviceMessages([
      {
        id: 'assistant-tool-only',
        role: 'assistant',
        status: 'complete',
        parts: [{
          type: 'tool',
          id: 'edit-1',
          title: '1 file change',
          status: 'completed',
          body: 'update\n/tmp/capture_all_balances.py',
        }],
      },
      {
        id: 'assistant-response',
        role: 'assistant',
        status: 'complete',
        parts: [
          {
            type: 'text',
            text: 'Starting the refresh.\r\nI am checking each institution.',
            phase: 'commentary',
          },
          {
            type: 'tool',
            id: 'edit-2',
            title: '1 file change',
            status: 'completed',
            body: 'update\n/tmp/capture_all_balances.py',
          },
          { type: 'status', text: 'checked workspace' },
          {
            type: 'text',
            text: 'The earlier values are\r\npreserved.',
            phase: 'final_answer',
          },
        ],
      },
    ])).toEqual([
      {
        id: 'assistant-response',
        role: 'assistant',
        status: 'complete',
        text: 'The earlier values are preserved.',
      },
    ]);
  });

  it('reflows soft prose wraps but preserves structured blocks', () => {
    expect(toDeviceMessages([{
      id: 'assistant-response',
      role: 'assistant',
      status: 'complete',
      parts: [{
        type: 'text',
        phase: 'final_answer',
        text: [
          'The runner checkpoints every completed institution, so any failure resumes',
          'from',
          'that exact point.',
          '',
          '- Preserves completed balances',
          '- Resumes at a named site',
          '',
          '```text',
          'bank-a: complete',
          '```',
        ].join('\n'),
      }],
    }])[0]?.text).toBe([
      'The runner checkpoints every completed institution, so any failure resumes from that exact point.',
      '',
      '- Preserves completed balances',
      '- Resumes at a named site',
      '',
      '```text',
      'bank-a: complete',
      '```',
    ].join('\n'));
  });

  it('applies the device history limit after dropping tool-only messages', () => {
    const messages = Array.from({ length: 16 }, (_, index): SurfaceMessage => ({
      id: `message-${index}`,
      role: 'assistant',
      status: 'complete',
      parts: [{ type: 'text', text: `response ${index}` }],
    }));
    messages.push({
      id: 'tool-only',
      role: 'assistant',
      status: 'complete',
      parts: [{
        type: 'tool',
        id: 'command',
        title: 'command',
        status: 'completed',
      }],
    });

    const projected = toDeviceMessages(messages);
    expect(projected).toHaveLength(14);
    expect(projected[0]?.id).toBe('message-2');
    expect(projected.at(-1)?.id).toBe('message-15');
  });
});
