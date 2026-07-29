import { timingSafeEqual } from 'node:crypto';
import http, {
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import type {
  CodexConversation,
  CodexRealtimeSession,
  CodexSurface,
} from 'codex-app-sdk/node';
import type {
  CodexRealtimeEvent,
  CodexSurfaceSnapshot,
} from 'codex-app-sdk/surface';
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from 'ws';
import {
  API_VERSION,
  MAX_AUDIO_BYTES,
  MAX_PROMPT_CHARS,
  REALTIME_SAMPLE_RATE,
  parseDeviceCommand,
  toDeviceMessages,
  toDeviceThreads,
  toDeviceThreadState,
  type DeviceServerMessage,
} from './protocol';
import type {
  RemoteRealtimeBridge,
  RemoteRealtimePeer,
} from './realtime-media';
import { PairingError, type PairingStore } from './pairing-store';
import { pcm16LeToWave } from './wav';

export type RemoteServerInfo = {
  port: number;
  token: string;
  defaultCwd: string;
  localUrl: string;
  networkUrls: string[];
  simulatorUrl: string;
  realtimeVoiceAvailable: true;
};

export type RemoteServerOptions = {
  surface: CodexSurface;
  token: string;
  defaultCwd: string;
  simulatorHtml: string;
  host?: string;
  port?: number;
  advertise?: boolean;
  realtimeBridge?: RemoteRealtimeBridge;
  pairing?: PairingStore;
  transcribeAudio?: (wave: Buffer) => Promise<{
    text: string;
    error?: string;
  }>;
};

type AudioCapture = {
  byteLength: number;
  sampleRate: number;
  pending: Promise<void>;
} & (
  | { mode: 'realtime' }
  | { mode: 'transcription'; chunks: Buffer[] }
);

type DeviceRealtime = {
  threadId: string;
  handle: CodexRealtimeSession;
  peer: RemoteRealtimePeer | null;
  unsubscribe: () => void;
};

type DeviceSession = {
  socket: WebSocket;
  threadId: string | null;
  audio: AudioCapture | null;
  realtime: DeviceRealtime | null;
  pending: Promise<void>;
  closed: boolean;
};

export class CodexRemoteServer {
  private readonly httpServer: http.Server;
  private readonly wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(MAX_AUDIO_BYTES, 64 * 1024),
  });
  private readonly sessions = new Set<DeviceSession>();
  private readonly conversationBroadcastTimers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribeSurfaceState: () => void;
  private readonly unsubscribeSurfaceEvents: () => void;
  private bonjour: Bonjour | null = null;
  private mdnsService: ReturnType<Bonjour['publish']> | null = null;
  private info: RemoteServerInfo | null = null;
  private realtimeStartupError: string | null = null;

  constructor(private readonly options: RemoteServerOptions) {
    if (!options.token.trim()) throw new Error('A non-empty device token is required');
    this.httpServer = http.createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.httpServer.on('upgrade', (request, socket, head) => {
      const requestUrl = request.url ? new URL(request.url, 'http://localhost') : null;
      if (
        requestUrl?.pathname !== '/api/v1/device'
        || !this.isAuthorized(request, requestUrl, true)
      ) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.wsServer.emit('connection', webSocket, request);
      });
    });
    this.wsServer.on('connection', (socket) => this.attachDevice(socket));
    this.unsubscribeSurfaceState = options.surface.onStateChange(() => this.broadcastThreads());
    this.unsubscribeSurfaceEvents = options.surface.onEvent((event) => {
      if ('conversationId' in event) this.scheduleConversationBroadcast(event.conversationId);
    });
  }

  async start(): Promise<RemoteServerInfo> {
    if (this.info) return this.info;
    const host = this.options.host ?? '0.0.0.0';
    const requestedPort = this.options.port ?? 47_776;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.httpServer.off('error', onError);
        resolve();
      };
      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(requestedPort, host);
    });

    const address = this.httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Codex Remote server did not expose a TCP port');
    }
    const port = address.port;
    const localUrl = `http://127.0.0.1:${port}`;
    const networkUrls = lanAddresses().map((ip) => `http://${ip}:${port}`);
    this.info = {
      port,
      token: this.options.token,
      defaultCwd: this.options.defaultCwd,
      localUrl,
      networkUrls,
      simulatorUrl: `${localUrl}/simulator?token=${encodeURIComponent(this.options.token)}`,
      realtimeVoiceAvailable: true,
    };

    if (this.options.advertise !== false && port !== 0) {
      this.bonjour = new Bonjour();
      this.mdnsService = this.bonjour.publish({
        name: this.options.pairing?.bridgeName ?? `Codex Remote on ${os.hostname()}`,
        type: 'codex-remote',
        protocol: 'tcp',
        port,
        txt: {
          api: String(API_VERSION),
          path: '/api/v1/device',
          ...(this.options.pairing
            ? {
                bridgeId: this.options.pairing.bridgeId,
                bridgeName: this.options.pairing.bridgeName,
              }
            : {}),
        },
      });
    }

    return this.info;
  }

  getInfo(): RemoteServerInfo {
    if (!this.info) throw new Error('Codex Remote server has not started');
    return { ...this.info, networkUrls: [...this.info.networkUrls] };
  }

  async close(): Promise<void> {
    this.unsubscribeSurfaceState();
    this.unsubscribeSurfaceEvents();
    for (const timer of this.conversationBroadcastTimers.values()) clearTimeout(timer);
    this.conversationBroadcastTimers.clear();
    await Promise.all([...this.sessions].map(async (session) => {
      await this.releaseRealtime(session);
      session.socket.close(1001, 'Server shutting down');
    }));
    this.sessions.clear();
    this.wsServer.close();
    this.mdnsService?.stop();
    this.mdnsService = null;
    this.bonjour?.destroy();
    this.bonjour = null;

    if (this.httpServer.listening) {
      await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
    }
    this.info = null;
  }

  private async handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          service: 'codex-remote',
          apiVersion: API_VERSION,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/simulator') {
        if (!this.isAuthorized(request, url, true)) {
          sendJson(response, 401, { error: 'Unauthorized' });
          return;
        }
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': [
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            "script-src 'unsafe-inline'",
            "connect-src 'self' ws:",
            "img-src 'self' data:",
          ].join('; '),
        });
        response.end(this.options.simulatorHtml);
        return;
      }

      if (url.pathname === '/') {
        sendJson(response, 200, {
          name: 'Codex Remote',
          health: '/health',
          apiVersion: API_VERSION,
        });
        return;
      }

      if (
        request.method === 'GET'
        && url.pathname === '/api/v1/pairing/info'
        && this.options.pairing
      ) {
        sendJson(response, 200, {
          bridgeId: this.options.pairing.bridgeId,
          bridgeName: this.options.pairing.bridgeName,
          pairingEnabled: this.options.pairing.isPairingOpen(),
        });
        return;
      }

      if (
        request.method === 'POST'
        && url.pathname === '/api/v1/pairing/requests'
        && this.options.pairing
      ) {
        const body = await readJsonBody(request);
        const pairingRequest = this.options.pairing.createRequest(
          shortRecordString(body, 'deviceId', 96),
          shortRecordString(body, 'deviceName', 64),
        );
        sendJson(response, 201, {
          requestId: pairingRequest.id,
          code: pairingRequest.code,
          bridgeId: this.options.pairing.bridgeId,
          bridgeName: this.options.pairing.bridgeName,
          expiresAt: new Date(pairingRequest.expiresAt).toISOString(),
        });
        return;
      }

      const pairingResultMatch = url.pathname.match(
        /^\/api\/v1\/pairing\/requests\/([^/]+)$/,
      );
      if (
        request.method === 'GET'
        && pairingResultMatch
        && this.options.pairing
      ) {
        sendJson(response, 200, this.options.pairing.requestResult(
          decodeURIComponent(pairingResultMatch[1]!),
          url.searchParams.get('deviceId') ?? '',
        ));
        return;
      }

      if (!url.pathname.startsWith('/api/v1/') || !this.isAuthorized(request, url, true)) {
        sendJson(response, url.pathname.startsWith('/api/v1/') ? 401 : 404, {
          error: url.pathname.startsWith('/api/v1/') ? 'Unauthorized' : 'Not found',
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/state') {
        const snapshot = this.options.surface.getSnapshot();
        sendJson(response, 200, {
          status: snapshot.status,
          account: snapshot.authentication.account?.type ?? null,
          threadCount: snapshot.conversations.length,
          defaultCwd: this.options.defaultCwd,
          realtimeVoiceAvailable: true,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/v1/threads') {
        const threads = await this.options.surface.listConversations({ limit: 30 });
        sendJson(response, 200, { threads: toDeviceThreads(threads) });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/v1/threads') {
        const body = await readJsonBody(request);
        const snapshot = await this.options.surface.createConversation({
          cwd: this.options.defaultCwd,
        });
        const threadId = snapshot.activeConversationId;
        if (!threadId) throw new Error('Codex did not return a new thread id');
        const prompt = recordString(body, 'text', false);
        if (prompt) await this.sendPrompt(threadId, prompt);
        sendJson(response, 201, await this.threadPayload(threadId));
        return;
      }

      const messageMatch = url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/messages$/);
      if (messageMatch) {
        const threadId = decodeURIComponent(messageMatch[1]!);
        if (request.method === 'GET') {
          sendJson(response, 200, await this.threadPayload(threadId));
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          const prompt = recordString(body, 'text', true);
          await this.sendPrompt(threadId, prompt);
          sendJson(response, 202, await this.threadPayload(threadId));
          return;
        }
      }

      const interruptMatch = url.pathname.match(/^\/api\/v1\/threads\/([^/]+)\/interrupt$/);
      if (request.method === 'POST' && interruptMatch) {
        const threadId = decodeURIComponent(interruptMatch[1]!);
        await this.options.surface.conversation(threadId).interrupt();
        sendJson(response, 202, { ok: true });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof PairingError
        ? error.statusCode
        : (
        message.includes('must be')
        || message.includes('too long')
        || message.includes('JSON')
      ) ? 400 : 500;
      sendJson(response, status, { error: message });
    }
  }

  private isAuthorized(
    request: IncomingMessage,
    url: URL,
    allowLoopbackQuery: boolean,
  ): boolean {
    const header = request.headers['x-codex-remote-token'];
    const headerToken = Array.isArray(header) ? header[0] : header;
    if (
      headerToken
      && (
        safeTokenEquals(headerToken, this.options.token)
        || this.options.pairing?.isAuthorized(headerToken)
      )
    ) return true;
    return allowLoopbackQuery
      && isLoopback(request.socket.remoteAddress)
      && safeTokenEquals(url.searchParams.get('token') ?? '', this.options.token);
  }

  private attachDevice(socket: WebSocket): void {
    const session: DeviceSession = {
      socket,
      threadId: null,
      audio: null,
      realtime: null,
      pending: Promise.resolve(),
      closed: false,
    };
    this.sessions.add(session);
    this.send(session, {
      type: 'hello',
      apiVersion: API_VERSION,
      platform: process.platform,
      transcription: this.options.realtimeBridge || this.options.transcribeAudio
        ? 'available'
        : 'unavailable',
    });
    this.sendThreads(session);

    socket.on('message', (data, isBinary) => {
      session.pending = session.pending.then(() => (
        session.closed
          ? undefined
          : this.handleDeviceMessage(session, data, isBinary)
      ));
    });
    const detach = () => {
      if (session.closed) return;
      session.closed = true;
      this.sessions.delete(session);
      void session.pending.then(() => this.releaseRealtime(session));
    };
    socket.on('close', detach);
    socket.on('error', detach);
  }

  private async handleDeviceMessage(
    session: DeviceSession,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    try {
      if (isBinary) {
        await this.acceptAudioChunk(session, rawDataBuffer(data));
        return;
      }
      const command = parseDeviceCommand(JSON.parse(rawDataBuffer(data).toString('utf8')));
      switch (command.type) {
        case 'hello':
        case 'list_threads':
          this.sendThreads(session);
          return;
        case 'create_thread': {
          const snapshot = await this.options.surface.createConversation({
            cwd: this.options.defaultCwd,
          });
          const threadId = snapshot.activeConversationId;
          if (!threadId) throw new Error('Codex did not return a new thread id');
          if (session.threadId !== threadId) await this.releaseRealtime(session);
          session.threadId = threadId;
          await this.sendThread(session, threadId);
          this.broadcastThreads();
          return;
        }
        case 'open_thread':
          if (session.threadId !== command.threadId) await this.releaseRealtime(session);
          session.threadId = command.threadId;
          await this.sendThread(session, command.threadId);
          return;
        case 'send_text': {
          const threadId = command.threadId ?? session.threadId;
          if (!threadId) throw new Error('Open a thread before sending a command');
          session.threadId = threadId;
          await this.sendPrompt(threadId, command.text);
          await this.sendThread(session, threadId);
          return;
        }
        case 'interrupt': {
          const threadId = command.threadId ?? session.threadId;
          if (!threadId) throw new Error('Open a thread before interrupting it');
          await this.options.surface.conversation(threadId).interrupt();
          return;
        }
        case 'audio_start': {
          const threadId = command.threadId ?? session.threadId;
          if (!threadId) throw new Error('Open a thread before recording');
          if (session.audio) throw new Error('A recording is already in progress');
          session.threadId = threadId;
          const sampleRate = command.sampleRate ?? REALTIME_SAMPLE_RATE;
          let realtime: DeviceRealtime | null = null;
          if (!this.realtimeStartupError) {
            try {
              realtime = await this.ensureRealtime(session, threadId);
            } catch (error) {
              if (!this.options.transcribeAudio) throw error;
              this.realtimeStartupError = error instanceof Error ? error.message : String(error);
            }
          }
          if (realtime) {
            session.audio = {
              mode: 'realtime',
              byteLength: 0,
              sampleRate,
              pending: Promise.resolve(),
            };
            if (realtime.threadId !== threadId) {
              throw new Error('Realtime thread changed unexpectedly');
            }
            this.send(session, { type: 'status', status: 'recording' });
          } else {
            if (!this.options.transcribeAudio) {
              throw new Error(this.realtimeStartupError ?? 'Speech transcription is unavailable');
            }
            session.audio = {
              mode: 'transcription',
              byteLength: 0,
              sampleRate,
              pending: Promise.resolve(),
              chunks: [],
            };
            this.send(session, {
              type: 'status',
              status: 'recording',
              detail: 'Local transcription',
            });
          }
          return;
        }
        case 'audio_end':
          await this.finishAudio(session);
      }
    } catch (error) {
      this.sendError(session, error);
      session.audio = null;
    }
  }

  private async acceptAudioChunk(session: DeviceSession, chunk: Buffer): Promise<void> {
    const capture = session.audio;
    if (!capture) throw new Error('Audio arrived before audio_start');
    if (chunk.byteLength === 0) return;
    if (capture.byteLength + chunk.byteLength > MAX_AUDIO_BYTES) {
      session.audio = null;
      throw new Error('Recording exceeded the 45 second limit');
    }
    capture.byteLength += chunk.byteLength;
    if (capture.mode === 'transcription') {
      capture.chunks.push(Buffer.from(chunk));
      return;
    }
    const realtime = session.realtime;
    if (!realtime) throw new Error('Realtime voice session is not active');
    const bytes = new Uint8Array(chunk);
    capture.pending = capture.pending.then(() => (
      realtime.peer
        ? realtime.peer.appendAudio(bytes, capture.sampleRate)
        : realtime.handle.appendAudio({
          data: bytes,
          sampleRate: capture.sampleRate,
          numChannels: 1,
        })
    ));
    await capture.pending;
  }

  private async finishAudio(session: DeviceSession): Promise<void> {
    const capture = session.audio;
    session.audio = null;
    if (!capture || capture.byteLength < REALTIME_SAMPLE_RATE / 20 * 2) {
      throw new Error('Recording was too short');
    }
    if (!session.threadId) throw new Error('Open a thread before recording');
    if (capture.mode === 'transcription') {
      const transcribe = this.options.transcribeAudio;
      if (!transcribe) throw new Error('Speech transcription is unavailable');
      this.send(session, {
        type: 'status',
        status: 'transcribing',
        detail: 'Turning speech into a Codex command',
      });
      const result = await transcribe(pcm16LeToWave(
        Buffer.concat(capture.chunks),
        capture.sampleRate,
      ));
      const text = result.text.trim();
      if (!text) {
        throw new Error(result.error?.trim() || 'No speech was recognized');
      }
      this.send(session, { type: 'transcript', role: 'user', text });
      this.send(session, {
        type: 'status',
        status: 'sending',
        detail: 'Sending transcript to Codex',
      });
      await this.sendPrompt(session.threadId, text);
      return;
    }
    const realtime = session.realtime;
    if (!realtime || realtime.threadId !== session.threadId) {
      throw new Error('Realtime voice session is not active');
    }

    await capture.pending;
    const silenceSamples = Math.floor(REALTIME_SAMPLE_RATE * 0.7);
    const silence = new Uint8Array(silenceSamples * 2);
    if (realtime.peer) {
      await realtime.peer.appendAudio(silence, REALTIME_SAMPLE_RATE);
    } else {
      await realtime.handle.appendAudio({
        data: silence,
        sampleRate: REALTIME_SAMPLE_RATE,
        numChannels: 1,
        samplesPerChannel: silenceSamples,
      });
    }
    this.send(session, {
      type: 'status',
      status: 'sending',
      detail: 'Waiting for Codex',
    });
  }

  private async ensureRealtime(
    session: DeviceSession,
    threadId: string,
  ): Promise<DeviceRealtime> {
    if (session.realtime?.threadId === threadId) return session.realtime;
    await this.releaseRealtime(session);
    const conversation = this.options.surface.conversation(threadId);
    await ensureConversationLoaded(conversation);
    let peer: RemoteRealtimePeer | null = null;
    try {
      if (this.options.realtimeBridge) {
        peer = await this.options.realtimeBridge.createPeer((data) => {
          if (
            session.realtime?.peer === peer
            && !session.closed
            && session.socket.readyState === WebSocket.OPEN
          ) {
            session.socket.send(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
          }
        });
      }
      const handle = await conversation.startRealtime({
        outputModality: 'audio',
        version: peer ? 'v1' : 'v2',
        includeStartupContext: true,
        flushTranscriptTailOnSessionEnd: true,
        ...(peer
          ? { transport: { type: 'webrtc' as const, sdp: peer.offerSdp } }
          : { transport: { type: 'websocket' as const } }),
      });
      if (peer) {
        if (!handle.remoteSdp) throw new Error('Codex did not return a WebRTC SDP answer');
        await peer.applyAnswer(handle.remoteSdp);
      }
      const realtime: DeviceRealtime = {
        threadId,
        handle,
        peer,
        unsubscribe: () => undefined,
      };
      realtime.unsubscribe = handle.onEvent((event) => {
        this.handleRealtimeEvent(session, realtime, event);
      });
      session.realtime = realtime;
      return realtime;
    } catch (error) {
      await peer?.close();
      throw error;
    }
  }

  private handleRealtimeEvent(
    session: DeviceSession,
    realtime: DeviceRealtime,
    event: CodexRealtimeEvent,
  ): void {
    if (session.realtime !== realtime) return;
    switch (event.type) {
      case 'realtime.started':
        if (!session.audio) this.send(session, { type: 'status', status: 'ready' });
        return;
      case 'realtime.transcriptDelta':
        return;
      case 'realtime.transcriptCompleted':
        this.send(session, {
          type: 'transcript',
          role: event.payload.role,
          text: event.payload.text,
        });
        if (event.payload.role === 'assistant') {
          this.send(session, { type: 'status', status: 'ready' });
        }
        return;
      case 'realtime.audioDelta':
        if (session.socket.readyState === WebSocket.OPEN) {
          session.socket.send(Buffer.from(
            event.payload.audio.data.buffer,
            event.payload.audio.data.byteOffset,
            event.payload.audio.data.byteLength,
          ));
        }
        return;
      case 'realtime.error':
        this.sendError(session, new Error(event.payload.message));
        return;
      case 'realtime.closed':
        realtime.unsubscribe();
        session.realtime = null;
        session.audio = null;
        void realtime.peer?.close();
        this.send(session, { type: 'status', status: 'ready' });
        return;
      case 'realtime.itemAdded':
      case 'realtime.sdp':
        return;
    }
  }

  private async releaseRealtime(session: DeviceSession): Promise<void> {
    const realtime = session.realtime;
    session.realtime = null;
    session.audio = null;
    if (!realtime) return;
    realtime.unsubscribe();
    await realtime.peer?.close();
    try {
      await realtime.handle.stop();
    } catch {
      // The app-server may already have closed the experimental transport.
    }
  }

  private async sendPrompt(threadId: string, prompt: string): Promise<void> {
    const text = prompt.trim();
    if (!text) throw new Error('text must be a non-empty string');
    if (text.length > MAX_PROMPT_CHARS) throw new Error('text is too long');
    const conversation = this.options.surface.conversation(threadId);
    await ensureConversationLoaded(conversation);
    await conversation.sendMessage(text);
  }

  private async threadPayload(threadId: string): Promise<{
    thread: ReturnType<typeof toDeviceThreadState>;
  }> {
    const conversation = this.options.surface.conversation(threadId);
    const snapshot = await loadConversationSnapshot(conversation);
    return {
      thread: toDeviceThreadState(snapshot, threadId),
    };
  }

  private sendThreads(session: DeviceSession): void {
    const snapshot = this.options.surface.getSnapshot();
    this.send(session, {
      type: 'threads',
      threads: toDeviceThreads(snapshot.conversations),
    });
  }

  private broadcastThreads(): void {
    for (const session of this.sessions) this.sendThreads(session);
  }

  private scheduleConversationBroadcast(threadId: string): void {
    if (this.conversationBroadcastTimers.has(threadId)) return;
    const timer = setTimeout(() => {
      this.conversationBroadcastTimers.delete(threadId);
      void this.broadcastConversation(threadId);
    }, 80);
    this.conversationBroadcastTimers.set(threadId, timer);
  }

  private async broadcastConversation(threadId: string): Promise<void> {
    const matching = [...this.sessions].filter((session) => session.threadId === threadId);
    if (matching.length === 0) return;
    const conversation = this.options.surface.conversation(threadId);
    try {
      const snapshot = await loadConversationSnapshot(conversation);
      const message: DeviceServerMessage = {
        type: 'thread',
        thread: toDeviceThreadState(snapshot, threadId),
      };
      for (const session of matching) this.send(session, message);
    } catch (error) {
      for (const session of matching) this.sendError(session, error);
    }
  }

  private async sendThread(session: DeviceSession, threadId: string): Promise<void> {
    const payload = await this.threadPayload(threadId);
    this.send(session, { type: 'thread', thread: payload.thread });
  }

  private send(session: DeviceSession, message: DeviceServerMessage): void {
    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify(message));
    }
  }

  private sendError(session: DeviceSession, error: unknown): void {
    this.send(session, {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function ensureConversationLoaded(conversation: CodexConversation): Promise<void> {
  await conversation.load();
}

async function loadConversationSnapshot(
  conversation: CodexConversation,
): Promise<CodexSurfaceSnapshot> {
  return conversation.load();
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > 64 * 1024) {
        reject(new Error('JSON request is too large'));
        request.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        const value = text ? JSON.parse(text) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('JSON body must be an object');
        }
        resolve(value as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function recordString(
  record: Record<string, unknown>,
  key: string,
  required: boolean,
): string {
  const value = record[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  if (value.trim().length > MAX_PROMPT_CHARS) throw new Error(`${key} is too long`);
  return value.trim();
}

function shortRecordString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new PairingError(400, `${key} must be a non-empty string`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new PairingError(400, `${key} must be at most ${maxLength} characters`);
  }
  return result;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

function safeTokenEquals(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.byteLength === expectedBytes.byteLength
    && timingSafeEqual(candidateBytes, expectedBytes);
}

function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function lanAddresses(): string[] {
  const addresses = new Set<string>();
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family === 'IPv4' && !address.internal) addresses.add(address.address);
    }
  }
  return [...addresses].sort();
}
