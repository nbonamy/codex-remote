import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CodexConversation,
  CodexRealtimeSession,
  CodexSurface,
} from 'codex-app-sdk/node';
import type {
  CodexRealtimeEvent,
  CodexSurfaceSnapshot,
} from 'codex-app-sdk/surface';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  CodexRemoteServer,
  type RemoteServerInfo,
} from '../src/server/remote-server';
import { PairingStore } from '../src/server/pairing-store';
import type {
  RemoteRealtimeBridge,
  RemoteRealtimePeer,
} from '../src/server/realtime-media';

const servers: CodexRemoteServer[] = [];
const sockets: WebSocket[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe('CodexRemoteServer device pairing', () => {
  it('routes both Codex homes through one server using the host id', async () => {
    const codexSurface = fakeSurface(
      fakeConversation(new FakeRealtimeSession('thread-1')),
    );
    const adeSurface = fakeSurface(
      fakeConversation(new FakeRealtimeSession('thread-1')),
    );
    const server = new CodexRemoteServer({
      hosts: [
        { id: 'codex', name: 'Codex', surface: codexSurface },
        { id: 'codex-ade', name: 'Codex ADE', surface: adeSurface },
      ],
      token: 'legacy-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
    });
    servers.push(server);
    const info = await server.start();
    expect(info.port).toBeGreaterThan(0);
    expect(info.simulatorUrl).toContain('hostId=codex');

    const baseUrl = `http://127.0.0.1:${info.port}`;
    const response = await fetch(`${baseUrl}/api/v1/hosts`);
    await expect(response.json()).resolves.toEqual({
      hosts: [
        { id: 'codex', name: 'Codex', status: 'ready' },
        { id: 'codex-ade', name: 'Codex ADE', status: 'ready' },
      ],
    });
    const adeThreads = await fetch(`${baseUrl}/api/v1/hosts/codex-ade/threads`, {
      headers: { 'X-Codex-Remote-Token': 'legacy-device-token' },
    });
    expect(adeThreads.status).toBe(200);
    expect(adeSurface.listConversations).toHaveBeenCalledOnce();
    expect(codexSurface.listConversations).not.toHaveBeenCalled();

    const unscopedThreads = await fetch(`${baseUrl}/api/v1/threads`, {
      headers: { 'X-Codex-Remote-Token': 'legacy-device-token' },
    });
    expect(unscopedThreads.status).toBe(404);

    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex-ade/device`,
      { headers: { 'X-Codex-Remote-Token': 'legacy-device-token' } },
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);
    await expect(messages.nextJson('hello')).resolves.toMatchObject({
      type: 'hello',
      hostId: 'codex-ade',
      hostName: 'Codex ADE',
    });
  });

  it('requires tray authorization then accepts the device-specific token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codex-remote-server-'));
    temporaryDirectories.push(directory);
    const pairing = await PairingStore.open(
      join(directory, 'pairings.json'),
      'Codex Remote on studio',
    );
    const server = new CodexRemoteServer({
      surface: fakeSurface(fakeConversation(new FakeRealtimeSession('thread-1'))),
      token: 'legacy-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
      pairing,
    });
    servers.push(server);
    const info = await server.start();
    const baseUrl = `http://127.0.0.1:${info.port}`;

    const bridgeInfo = await fetch(`${baseUrl}/api/v1/pairing/info`);
    await expect(bridgeInfo.json()).resolves.toMatchObject({
      bridgeId: pairing.bridgeId,
      bridgeName: 'Codex Remote on studio',
      pairingEnabled: false,
    });
    const closed = await fetch(`${baseUrl}/api/v1/pairing/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'esp32-a1b2',
        deviceName: 'Pocket Remote A1B2',
      }),
    });
    expect(closed.status).toBe(403);

    pairing.openPairingWindow();
    const created = await fetch(`${baseUrl}/api/v1/pairing/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'esp32-a1b2',
        deviceName: 'Pocket Remote A1B2',
      }),
    });
    expect(created.status).toBe(201);
    const request = await created.json() as { requestId: string; code: string };
    expect(request.code).toMatch(/^\d{6}$/);
    await pairing.approve(request.requestId);

    const result = await fetch(
      `${baseUrl}/api/v1/pairing/requests/${request.requestId}?deviceId=esp32-a1b2`,
    );
    const approved = await result.json() as { status: string; token: string };
    expect(approved.status).toBe('approved');

    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device`,
      { headers: { 'X-Codex-Remote-Token': approved.token } },
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);
    await expect(messages.nextJson('hello')).resolves.toMatchObject({
      type: 'hello',
    });

    const closedByRevocation = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    const revoked = await pairing.revoke('esp32-a1b2');
    expect(revoked?.token).toBe(approved.token);
    server.disconnectAuthorizationToken(revoked?.token ?? '');
    await expect(closedByRevocation).resolves.toBe(1008);

    const rejectedSocket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device`,
      { headers: { 'X-Codex-Remote-Token': approved.token } },
    );
    sockets.push(rejectedSocket);
    await expect(new Promise<void>((resolve, reject) => {
      rejectedSocket.once('open', resolve);
      rejectedSocket.once('error', reject);
    })).rejects.toThrow('Unexpected server response: 401');
  });
});

describe('CodexRemoteServer realtime voice', () => {
  it('discards a cancelled recording without transcribing or sending it', async () => {
    const conversation = fakeConversation(new FakeRealtimeSession('thread-1'));
    const transcribeAudio = vi.fn(async (_wave: Buffer) => ({ text: 'must not send' }));
    const server = new CodexRemoteServer({
      surface: fakeSurface(conversation),
      token: 'test-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
      realtimeVoiceAvailable: () => false,
      transcribeAudio,
    });
    servers.push(server);
    const info = await server.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device?token=test-device-token`,
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);

    await messages.nextJson('hello');
    await messages.nextJson('threads');
    socket.send(JSON.stringify({
      type: 'audio_start',
      threadId: 'thread-1',
      sampleRate: 24_000,
    }));
    expect(await messages.nextJson('status')).toMatchObject({ status: 'recording' });
    socket.send(Buffer.alloc(4_800, 1));
    socket.send(JSON.stringify({ type: 'audio_cancel' }));
    expect(await messages.nextJson('status')).toMatchObject({ status: 'ready' });

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(conversation.sendMessage).not.toHaveBeenCalled();
  });

  it('streams realtime voice directly over the app-server WebSocket without a renderer', async () => {
    const realtime = new FakeRealtimeSession('thread-1');
    const conversation = fakeConversation(realtime);
    const startRealtime = vi.spyOn(conversation, 'startRealtime');
    const server = new CodexRemoteServer({
      surface: fakeSurface(conversation),
      token: 'test-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html><title>sim</title>',
      port: 0,
      advertise: false,
    });
    servers.push(server);
    const info = await server.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device?token=test-device-token`,
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);

    await messages.nextJson('hello');
    await messages.nextJson('threads');
    socket.send(JSON.stringify({
      type: 'audio_start',
      threadId: 'thread-1',
      sampleRate: 24_000,
    }));
    socket.send(Buffer.alloc(4_800, 1));
    socket.send(JSON.stringify({ type: 'audio_end' }));
    await messages.nextJson('status');

    await vi.waitFor(() => expect(realtime.appendAudio).toHaveBeenCalledTimes(2));
    expect(startRealtime).toHaveBeenCalledWith({
      outputModality: 'audio',
      version: 'v2',
      includeStartupContext: true,
      flushTranscriptTailOnSessionEnd: true,
      transport: { type: 'websocket' },
    });
    expect(realtime.appendAudio.mock.calls[0]?.[0]).toMatchObject({
      sampleRate: 24_000,
      numChannels: 1,
    });
    expect(realtime.appendAudio.mock.calls[0]?.[0].data).toHaveLength(4_800);
    expect(realtime.appendAudio.mock.calls[1]?.[0]).toMatchObject({
      sampleRate: 24_000,
      numChannels: 1,
      samplesPerChannel: 16_800,
    });

    realtime.emit(realtimeEvent('realtime.audioDelta', {
      audio: {
        data: new Uint8Array([1, 2, 3, 4]),
        sampleRate: 24_000,
        numChannels: 1,
        samplesPerChannel: 2,
        itemId: 'assistant-audio-1',
      },
    }));
    expect(await messages.nextBinary()).toStrictEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('bridges device PCM through WebRTC and streams transcript and audio back', async () => {
    const realtime = new FakeRealtimeSession(
      'thread-1',
      'webrtc',
      'v=0\r\no=answer\r\n',
    );
    const media = new FakeRealtimeBridge();
    const conversation = fakeConversation(realtime);
    const startRealtime = vi.spyOn(conversation, 'startRealtime');
    const surface = fakeSurface(conversation);
    const server = new CodexRemoteServer({
      surface,
      token: 'test-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html><title>sim</title>',
      port: 0,
      advertise: false,
      realtimeBridge: media,
    });
    servers.push(server);
    const info = await server.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device?token=test-device-token`,
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);

    await messages.nextJson('hello');
    await messages.nextJson('threads');
    socket.send(JSON.stringify({
      type: 'audio_start',
      threadId: 'thread-1',
      sampleRate: 24_000,
    }));
    socket.send(Buffer.alloc(4_800, 1));
    socket.send(JSON.stringify({ type: 'audio_end' }));
    await messages.nextJson('status');

    await vi.waitFor(() => expect(media.peer.appendAudio).toHaveBeenCalledTimes(2));
    expect(startRealtime).toHaveBeenCalledWith({
      outputModality: 'audio',
      version: 'v1',
      includeStartupContext: true,
      flushTranscriptTailOnSessionEnd: true,
      transport: {
        type: 'webrtc',
        sdp: 'v=0\r\no=offer\r\n',
      },
    });
    expect(media.peer.applyAnswer).toHaveBeenCalledWith('v=0\r\no=answer\r\n');
    expect(media.peer.appendAudio.mock.calls[0]?.[0]).toHaveLength(4_800);
    expect(media.peer.appendAudio.mock.calls[0]?.[1]).toBe(24_000);
    expect(media.peer.appendAudio.mock.calls[1]?.[0]).toHaveLength(33_600);
    expect(media.peer.appendAudio.mock.calls[1]?.[1]).toBe(24_000);

    realtime.emit(realtimeEvent('realtime.transcriptCompleted', {
      role: 'user',
      text: 'run the focused tests',
    }));
    expect(await messages.nextJson('transcript')).toMatchObject({
      role: 'user',
      text: 'run the focused tests',
    });

    media.emitAudio(new Uint8Array([1, 2, 3, 4]));
    expect(await messages.nextBinary()).toStrictEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('rejects unauthorized device websocket upgrades', async () => {
    const realtime = new FakeRealtimeSession('thread-1');
    const server = new CodexRemoteServer({
      surface: fakeSurface(fakeConversation(realtime)),
      token: 'correct-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
    });
    servers.push(server);
    const info: RemoteServerInfo = await server.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device?token=wrong-token`,
    );
    sockets.push(socket);
    await expect(new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    })).rejects.toThrow('Unexpected server response: 401');
  });

  it('falls back to local transcription when Codex realtime is not entitled', async () => {
    const realtime = new FakeRealtimeSession('thread-1');
    const conversation = fakeConversation(realtime);
    vi.mocked(conversation.startRealtime).mockRejectedValueOnce(
      new Error('Voice session access denied'),
    );
    const transcribeAudio = vi.fn(async (_wave: Buffer) => ({ text: 'run the focused tests' }));
    const server = new CodexRemoteServer({
      surface: fakeSurface(conversation),
      token: 'test-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
      realtimeBridge: new FakeRealtimeBridge(),
      transcribeAudio,
    });
    servers.push(server);
    const info = await server.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device?token=test-device-token`,
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);

    await messages.nextJson('hello');
    await messages.nextJson('threads');
    socket.send(JSON.stringify({
      type: 'audio_start',
      threadId: 'thread-1',
      sampleRate: 24_000,
    }));
    socket.send(Buffer.alloc(4_800, 1));
    socket.send(JSON.stringify({ type: 'audio_end' }));

    await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledTimes(1));
    expect(await messages.nextJson('transcript')).toMatchObject({
      role: 'user',
      text: 'run the focused tests',
    });
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const wave = transcribeAudio.mock.calls[0]?.[0];
    expect(wave?.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wave?.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wave).toHaveLength(4_844);
    expect(conversation.sendMessage).toHaveBeenCalledWith('run the focused tests');
  });

  it('uses local transcription directly when realtime API key auth is unavailable', async () => {
    const realtime = new FakeRealtimeSession('thread-1');
    const conversation = fakeConversation(realtime);
    const transcribeAudio = vi.fn(async (_wave: Buffer) => ({ text: 'show the latest diff' }));
    const server = new CodexRemoteServer({
      surface: fakeSurface(conversation),
      token: 'test-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
      realtimeVoiceAvailable: () => false,
      transcribeAudio,
    });
    servers.push(server);
    const info = await server.start();
    expect(info.realtimeVoiceAvailable).toBe(false);
    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device?token=test-device-token`,
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);

    await expect(messages.nextJson('hello')).resolves.toMatchObject({
      transcription: 'available',
    });
    await messages.nextJson('threads');
    socket.send(JSON.stringify({
      type: 'audio_start',
      threadId: 'thread-1',
      sampleRate: 24_000,
    }));
    socket.send(Buffer.alloc(4_800, 1));
    socket.send(JSON.stringify({ type: 'audio_end' }));

    expect(await messages.nextJson('transcript')).toMatchObject({
      role: 'user',
      text: 'show the latest diff',
    });
    expect(conversation.startRealtime).not.toHaveBeenCalled();
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(conversation.sendMessage).toHaveBeenCalledWith('show the latest diff');
  });
});

describe('CodexRemoteServer thread history', () => {
  it('reads a selected assistant reply aloud without trusting device-supplied text', async () => {
    const conversation = fakeConversation(new FakeRealtimeSession('thread-1'));
    const loadedSnapshot = conversationSnapshot();
    loadedSnapshot.messages = [
      {
        id: 'message-user',
        role: 'user',
        status: 'complete',
        parts: [{ type: 'text', text: 'Read the answer.' }],
      },
      {
        id: 'message-assistant',
        role: 'assistant',
        status: 'complete',
        parts: [{ type: 'text', text: 'This is the stored assistant reply.' }],
      },
    ];
    vi.mocked(conversation.load).mockResolvedValue(loadedSnapshot);
    const synthesizeSpeech = vi.fn(async () => Buffer.from([1, 2, 3, 4]));
    const server = new CodexRemoteServer({
      surface: fakeSurface(conversation),
      token: 'test-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
      realtimeVoiceAvailable: () => false,
      synthesizeSpeech,
    });
    servers.push(server);
    const info = await server.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device?token=test-device-token`,
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);

    await messages.nextJson('hello');
    await messages.nextJson('threads');
    socket.send(JSON.stringify({
      type: 'speak_message',
      threadId: 'thread-1',
      messageId: 'message-assistant',
      text: 'A device must not be able to replace the stored text.',
    }));

    await expect(messages.nextJson('status')).resolves.toMatchObject({ status: 'speaking' });
    await expect(messages.nextBinary()).resolves.toStrictEqual(Buffer.from([1, 2, 3, 4]));
    expect(synthesizeSpeech).toHaveBeenCalledWith('This is the stored assistant reply.');
  });

  it('refuses to read a user message as an assistant reply', async () => {
    const conversation = fakeConversation(new FakeRealtimeSession('thread-1'));
    const loadedSnapshot = conversationSnapshot();
    loadedSnapshot.messages = [{
      id: 'message-user',
      role: 'user',
      status: 'complete',
      parts: [{ type: 'text', text: 'Do not read this as Codex.' }],
    }];
    vi.mocked(conversation.load).mockResolvedValue(loadedSnapshot);
    const synthesizeSpeech = vi.fn(async () => Buffer.from([1, 2]));
    const server = new CodexRemoteServer({
      surface: fakeSurface(conversation),
      token: 'test-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
      synthesizeSpeech,
    });
    servers.push(server);
    const info = await server.start();
    const socket = new WebSocket(
      `ws://127.0.0.1:${info.port}/api/v1/hosts/codex/device?token=test-device-token`,
    );
    sockets.push(socket);
    const messages = new SocketMessages(socket);

    await messages.nextJson('hello');
    await messages.nextJson('threads');
    socket.send(JSON.stringify({
      type: 'speak_message',
      threadId: 'thread-1',
      messageId: 'message-user',
    }));

    await expect(messages.nextJson('error')).resolves.toMatchObject({
      message: 'Only assistant replies can be read aloud',
    });
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('hydrates an existing thread before projecting its messages', async () => {
    const realtime = new FakeRealtimeSession('thread-1');
    const conversation = fakeConversation(realtime);
    const loadedSnapshot = conversationSnapshot();
    loadedSnapshot.messages = [
      {
        id: 'message-user',
        role: 'user',
        status: 'complete',
        parts: [{ type: 'text', text: 'Can you show the latest response?' }],
      },
      {
        id: 'message-assistant',
        role: 'assistant',
        status: 'complete',
        parts: [{ type: 'text', text: 'This response should reach the remote.' }],
      },
    ];
    vi.mocked(conversation.load).mockResolvedValue(loadedSnapshot);

    const server = new CodexRemoteServer({
      surface: fakeSurface(conversation),
      token: 'test-device-token',
      defaultCwd: '/tmp/project',
      simulatorHtml: '<!doctype html>',
      port: 0,
      advertise: false,
    });
    servers.push(server);
    const info = await server.start();

    const response = await fetch(
      `http://127.0.0.1:${info.port}/api/v1/hosts/codex/threads/thread-1/messages`,
      { headers: { 'X-Codex-Remote-Token': 'test-device-token' } },
    );
    const body = await response.json() as {
      thread: {
        messages: Array<{ role: string; text: string }>;
      };
    };

    expect(response.status).toBe(200);
    expect(body.thread.messages).toEqual([
      {
        id: 'message-user',
        role: 'user',
        status: 'complete',
        text: 'Can you show the latest response?',
      },
      {
        id: 'message-assistant',
        role: 'assistant',
        status: 'complete',
        text: 'This response should reach the remote.',
      },
    ]);
    expect(conversation.load).toHaveBeenCalledOnce();
  });
});

class FakeRealtimeSession implements CodexRealtimeSession {
  readonly appendAudio = vi.fn<CodexRealtimeSession['appendAudio']>(async () => undefined);
  readonly appendText = vi.fn<CodexRealtimeSession['appendText']>(async () => undefined);
  readonly appendSpeech = vi.fn<CodexRealtimeSession['appendSpeech']>(async () => undefined);
  readonly stop = vi.fn<CodexRealtimeSession['stop']>(async () => undefined);
  private readonly listeners = new Set<(event: CodexRealtimeEvent) => void>();

  constructor(
    readonly conversationId: string,
    readonly transport: 'websocket' | 'webrtc' = 'websocket',
    readonly remoteSdp: string | null = null,
  ) {}

  onEvent(listener: (event: CodexRealtimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: CodexRealtimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeRealtimePeer implements RemoteRealtimePeer {
  readonly offerSdp = 'v=0\r\no=offer\r\n';
  readonly applyAnswer = vi.fn<RemoteRealtimePeer['applyAnswer']>(async () => undefined);
  readonly appendAudio = vi.fn<RemoteRealtimePeer['appendAudio']>(async () => undefined);
  readonly close = vi.fn<RemoteRealtimePeer['close']>(async () => undefined);
}

class FakeRealtimeBridge implements RemoteRealtimeBridge {
  readonly peer = new FakeRealtimePeer();
  private onAudio: ((data: Uint8Array) => void) | null = null;

  readonly createPeer = vi.fn<RemoteRealtimeBridge['createPeer']>(async (onAudio) => {
    this.onAudio = onAudio;
    return this.peer;
  });

  emitAudio(data: Uint8Array): void {
    this.onAudio?.(data);
  }
}

class SocketMessages {
  private readonly queued: Array<{ data: Buffer; binary: boolean }> = [];
  private readonly waiting: Array<(message: { data: Buffer; binary: boolean }) => void> = [];

  constructor(socket: WebSocket) {
    socket.on('message', (data, binary) => {
      const message = { data: Buffer.from(data as Buffer), binary };
      const resolve = this.waiting.shift();
      if (resolve) resolve(message);
      else this.queued.push(message);
    });
  }

  async nextJson(type: string): Promise<Record<string, unknown>> {
    while (true) {
      const message = await this.next();
      if (message.binary) continue;
      const json = JSON.parse(message.data.toString('utf8')) as Record<string, unknown>;
      if (json.type === type) return json;
    }
  }

  async nextBinary(): Promise<Buffer> {
    while (true) {
      const message = await this.next();
      if (message.binary) return message.data;
    }
  }

  private next(): Promise<{ data: Buffer; binary: boolean }> {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

function fakeConversation(realtime: CodexRealtimeSession): CodexConversation {
  const snapshot = conversationSnapshot();
  return {
    id: 'thread-1',
    fork: vi.fn(async () => ({
      conversationId: 'thread-1',
      conversation: undefined as never,
      snapshot,
    })),
    forkMessage: vi.fn(async () => ({
      conversationId: 'thread-1',
      conversation: undefined as never,
      snapshot,
    })),
    load: vi.fn(async () => snapshot),
    select: vi.fn(async () => snapshot),
    readHistory: vi.fn(async () => ({
      conversationId: 'thread-1',
      messages: [],
      threadStatus: { type: 'idle' as const },
    })),
    loadOlderHistory: vi.fn(async () => ({
      conversationId: 'thread-1',
      messages: [],
      hasOlder: false,
    })),
    rename: vi.fn(async () => snapshot),
    updateSettings: vi.fn(async () => snapshot),
    sendMessage: vi.fn(async () => snapshot),
    startRealtime: vi.fn(async () => realtime),
    compact: vi.fn(async () => snapshot),
    startReview: vi.fn(async () => snapshot),
    steerMessage: vi.fn(async () => snapshot),
    interrupt: vi.fn(async () => snapshot),
    deleteMessage: vi.fn(async () => snapshot),
    editMessage: vi.fn(async () => snapshot),
    retryMessage: vi.fn(async () => snapshot),
    rollbackToTurn: vi.fn(async () => snapshot),
    deleteQueuedPrompt: vi.fn(async () => snapshot),
    steerQueuedPrompt: vi.fn(async () => snapshot),
    respondToClientRequest: vi.fn(async () => snapshot),
    resolveApproval: vi.fn(async () => snapshot),
    setGoal: vi.fn(async () => snapshot),
    clearGoal: vi.fn(async () => snapshot),
    getSnapshot: vi.fn(() => snapshot),
    onStateChange: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
  };
}

function fakeSurface(conversation: CodexConversation): CodexSurface {
  const snapshot = conversationSnapshot();
  return {
    onStateChange: vi.fn(() => () => undefined),
    onEvent: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => snapshot),
    listConversations: vi.fn(async () => []),
    conversation: vi.fn(() => conversation),
  } as unknown as CodexSurface;
}

function conversationSnapshot(): CodexSurfaceSnapshot & {
  activeConversationId: string;
  activeTurnId: null;
  turnIds: string[];
} {
  return {
    status: 'ready',
    authentication: {
      status: 'loaded',
      account: { type: 'chatgpt', email: 'test@example.test', planType: 'pro' },
      requiresOpenaiAuth: true,
      error: null,
      login: { status: 'idle', loginId: null, authUrl: null, error: null },
    },
    models: [],
    modelCatalogStatus: 'loaded',
    skills: [],
    skillCatalogStatus: 'loaded',
    plugins: [],
    pluginCatalogStatus: 'loaded',
    permissionProfiles: [],
    approvalPresets: [],
    approvals: [],
    clientRequests: [],
    answeredClientRequestIds: [],
    conversations: [],
    activeConversationId: 'thread-1',
    selectedModelId: null,
    selectedReasoningEffort: null,
    approvalPreset: null,
    planMode: false,
    messages: [],
    contextUsage: null,
    goal: null,
    turnGitDiff: null,
    threadStatus: { type: 'idle' },
    rateLimits: null,
    queuedPrompts: [],
    busy: false,
    historyLoading: false,
    error: null,
    activeTurnId: null,
    turnIds: [],
  };
}

function realtimeEvent<Type extends CodexRealtimeEvent['type']>(
  type: Type,
  payload: Extract<CodexRealtimeEvent, { type: Type }>['payload'],
): Extract<CodexRealtimeEvent, { type: Type }> {
  return {
    type,
    payload,
    conversationId: 'thread-1',
    seq: 1,
    occurredAt: new Date(0).toISOString(),
    origin: 'notification',
  } as Extract<CodexRealtimeEvent, { type: Type }>;
}
