import type { RpcMessage, RpcTransport } from 'codex-app-sdk/codex';
import { describe, expect, it, vi } from 'vitest';
import { codexAgentProfiles } from '../src/main/agent-profiles';
import { createAgentTransport } from '../src/main/agent-transport';

describe('createAgentTransport', () => {
  it('uses the desktop socket when it is available', async () => {
    const [profile] = codexAgentProfiles('/Users/tester');
    const socket = fakeTransport();
    const createStdioTransport = vi.fn(() => fakeTransport());

    const transport = await createAgentTransport(profile!, {
      createUnixSocketTransport: () => socket,
      createStdioTransport,
    });

    expect(transport).toBe(socket);
    expect(socket.start).toHaveBeenCalledOnce();
    expect(createStdioTransport).not.toHaveBeenCalled();
  });

  it('falls back to a managed app-server when the socket is unavailable', async () => {
    const [profile] = codexAgentProfiles('/Users/tester');
    const socketError = new Error('connect ENOENT app-server-control.sock');
    const socket = fakeTransport(socketError);
    const stdio = fakeTransport();
    const onSocketFallback = vi.fn();

    const transport = await createAgentTransport(profile!, {
      createUnixSocketTransport: () => socket,
      createStdioTransport: (options) => {
        expect(options).toEqual({
          codexHome: '/Users/tester/.codex',
          configOverrides: [
            'features.realtime_conversation=true',
          ],
        });
        return stdio;
      },
      onSocketFallback,
    });

    expect(transport).toBe(stdio);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(onSocketFallback).toHaveBeenCalledWith(socketError);
  });

  it('uses stdio directly for managed agents', async () => {
    const [, profile] = codexAgentProfiles('/Users/tester');
    const stdio = fakeTransport();
    const createUnixSocketTransport = vi.fn(() => fakeTransport());

    const transport = await createAgentTransport(profile!, {
      createUnixSocketTransport,
      createStdioTransport: (options) => {
        expect(options).toEqual({
          codexHome: '/Users/tester/.codex-claw/codex-home',
          configOverrides: [
            'features.realtime_conversation=true',
          ],
        });
        return stdio;
      },
    });

    expect(transport).toBe(stdio);
    expect(stdio.start).not.toHaveBeenCalled();
    expect(createUnixSocketTransport).not.toHaveBeenCalled();
  });
});

function fakeTransport(startError?: Error): RpcTransport {
  return {
    start: vi.fn(async () => {
      if (startError) throw startError;
    }),
    send: vi.fn((_message: RpcMessage) => undefined),
    close: vi.fn(async () => undefined),
    onMessage: vi.fn(() => () => undefined),
    onError: vi.fn(() => () => undefined),
  };
}
