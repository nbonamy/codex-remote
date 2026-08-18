import { spawn, type ChildProcess } from 'node:child_process';
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
  CodexSurfaceApproval,
  CodexSurfaceSnapshot,
  SurfaceMessage,
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
import { PairingError, type PairingStore } from './pairing-store';
import { pcm16LeToWave } from './wav';

export type RemoteServerInfo = {
  port: number;
  token: string;
  localUrl: string;
  networkUrls: string[];
  simulatorUrl: string;
  realtimeVoiceAvailable: boolean;
};

export type RemoteCodexAgent = {
  id: string;
  name: string;
  surface: CodexSurface;
  realtimeVoiceAvailable?: () => boolean;
  readRecentMessages?: (threadId: string) => Promise<SurfaceMessage[]>;
  releaseThread?: (threadId: string) => Promise<void>;
};

const DEVICE_CONVERSATION_OPTIONS = {
  approvalMode: 'never',
  permissionMode: 'workspace-write',
  model: 'gpt-5.6-luna',
  reasoningEffort: 'medium',
  serviceTier: 'priority',
} as const;

const VOICE_CHAT_TITLE = 'Codex Remote Voice Chat';

export type RemoteServerOptions = {
  agents?: RemoteCodexAgent[];
  surface?: CodexSurface;
  token: string;
  agentId?: string;
  agentName?: string;
  simulatorHtml: string;
  listenAddress?: string;
  port?: number;
  advertise?: boolean;
  realtimeInstructions?: string;
  realtimeVoice?: string;
  realtimeVoiceAvailable?: () => boolean;
  pairing?: PairingStore;
  transcribeAudio?: (wave: Buffer) => Promise<{
    text: string;
    error?: string;
  }>;
  synthesizeSpeech?: SpeechSynthesizer;
};

export type SpeechAudio = Uint8Array | AsyncIterable<Uint8Array>;
export type SpeechSynthesizer = (
  text: string,
  signal?: AbortSignal,
) => Promise<SpeechAudio>;

type DeviceSpeech = {
  controller: AbortController;
  cancelled: Promise<void>;
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
  unsubscribe: () => void;
  outputIdleTimer: NodeJS.Timeout | null;
  speaking: boolean;
};

type DeviceSession = {
  socket: WebSocket;
  authorizationToken: string;
  agent: RemoteCodexAgent;
  threadId: string | null;
  audio: AudioCapture | null;
  realtime: DeviceRealtime | null;
  pending: Promise<void>;
  speech: DeviceSpeech | null;
  closed: boolean;
};

async function* speechAudioChunks(
  audio: SpeechAudio,
): AsyncGenerator<Uint8Array> {
  if (
    typeof (audio as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]
      === 'function'
  ) {
    yield* audio as AsyncIterable<Uint8Array>;
    return;
  }
  yield audio as Uint8Array;
}

export class CodexRemoteServer {
  private readonly httpServer: http.Server;
  private readonly wsServer = new WebSocketServer({
    noServer: true,
    maxPayload: Math.max(MAX_AUDIO_BYTES, 64 * 1024),
  });
  private readonly sessions = new Set<DeviceSession>();
  private readonly conversationBroadcastTimers = new Map<string, NodeJS.Timeout>();
  private readonly resolvingApprovalIds = new Set<string>();
  private readonly agents: RemoteCodexAgent[];
  private readonly unsubscribeAgentListeners: Array<() => void> = [];
  private bonjour: Bonjour | null = null;
  private mdnsService: ReturnType<Bonjour['publish']> | null = null;
  private mdnsProcess: ChildProcess | null = null;
  private info: RemoteServerInfo | null = null;
  constructor(private readonly options: RemoteServerOptions) {
    if (!options.token.trim()) throw new Error('A non-empty device token is required');
    this.agents = options.agents ?? (options.surface
      ? [{
          id: options.agentId?.trim() || 'codex',
          name: options.agentName?.trim() || 'Codex',
          surface: options.surface,
          realtimeVoiceAvailable: options.realtimeVoiceAvailable,
        }]
      : []);
    if (this.agents.length === 0) throw new Error('At least one Codex agent is required');
    if (new Set(this.agents.map((agent) => agent.id)).size !== this.agents.length) {
      throw new Error('Codex agent ids must be unique');
    }
    this.httpServer = http.createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.httpServer.on('upgrade', (request, socket, head) => {
      const requestUrl = request.url ? new URL(request.url, 'http://localhost') : null;
      const agent = requestUrl ? this.deviceAgent(requestUrl.pathname) : null;
      const authorizationToken = requestUrl
        ? requestAuthorizationToken(request, requestUrl)
        : '';
      if (
        !requestUrl
        || !agent
        || !this.isAuthorized(request, requestUrl, true)
      ) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wsServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.attachDevice(webSocket, agent, authorizationToken);
      });
    });
    for (const agent of this.agents) {
      this.unsubscribeAgentListeners.push(
        agent.surface.onStateChange((snapshot) => {
          this.denyPendingApprovals(agent, snapshot.approvals);
          this.broadcastThreads(agent.id);
        }),
        agent.surface.onEvent((event) => {
          if (event.type === 'approval.requested') {
            this.denyPendingApprovals(agent, [event.payload.approval]);
          }
          if ('conversationId' in event) {
            this.scheduleConversationBroadcast(agent.id, event.conversationId);
          }
        }),
      );
      this.denyPendingApprovals(agent, agent.surface.getSnapshot().approvals);
    }
  }

  async start(): Promise<RemoteServerInfo> {
    if (this.info) return this.info;
    const listenAddress = this.options.listenAddress ?? '0.0.0.0';
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
      this.httpServer.listen(requestedPort, listenAddress);
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
      localUrl,
      networkUrls,
      simulatorUrl: `${localUrl}/simulator?token=${
        encodeURIComponent(this.options.token)
      }&agentId=${encodeURIComponent(this.agents[0]!.id)}`,
      realtimeVoiceAvailable: this.agents.some((agent) => this.isRealtimeVoiceAvailable(agent)),
    };

    if (this.options.advertise !== false && port !== 0) {
      this.publishBonjour(port);
    }

    return this.info;
  }

  getInfo(): RemoteServerInfo {
    if (!this.info) throw new Error('Codex Remote server has not started');
    return {
      ...this.info,
      networkUrls: [...this.info.networkUrls],
      realtimeVoiceAvailable: this.agents.some((agent) => this.isRealtimeVoiceAvailable(agent)),
    };
  }

  disconnectAuthorizationToken(token: string): void {
    if (!token) return;
    for (const session of this.sessions) {
      if (safeTokenEquals(session.authorizationToken, token)) {
        session.socket.close(1008, 'Device access revoked');
      }
    }
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribeAgentListeners.splice(0)) unsubscribe();
    for (const timer of this.conversationBroadcastTimers.values()) clearTimeout(timer);
    this.conversationBroadcastTimers.clear();
    for (const session of this.sessions) session.closed = true;
    await Promise.all([...this.sessions].map(async (session) => {
      this.cancelSpeech(session);
      await this.releaseActiveThread(session);
      session.socket.close(1001, 'Server shutting down');
    }));
    this.sessions.clear();
    this.wsServer.close();
    this.mdnsService?.stop();
    this.mdnsService = null;
    this.bonjour?.destroy();
    this.bonjour = null;
    this.mdnsProcess?.kill('SIGTERM');
    this.mdnsProcess = null;

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
          agentCount: this.agents.length,
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
          hostId: this.options.pairing.hostId,
          hostName: this.options.pairing.hostName,
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
          hostId: this.options.pairing.hostId,
          hostName: this.options.pairing.hostName,
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

      if (request.method === 'GET' && url.pathname === '/api/v1/agents') {
        if (!this.isAuthorized(request, url, true)) {
          sendJson(response, 401, { error: 'Unauthorized' });
          return;
        }
        sendJson(response, 200, {
          agents: this.agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            status: agent.surface.getSnapshot().status,
          })),
        });
        return;
      }

      if (!url.pathname.startsWith('/api/v1/') || !this.isAuthorized(request, url, true)) {
        sendJson(response, url.pathname.startsWith('/api/v1/') ? 401 : 404, {
          error: url.pathname.startsWith('/api/v1/') ? 'Unauthorized' : 'Not found',
        });
        return;
      }

      const route = this.agentRoute(url.pathname);
      if (!route) {
        sendJson(response, 404, { error: 'Unknown agent or route' });
        return;
      }
      const { agent, path } = route;

      if (request.method === 'GET' && path === '/state') {
        const snapshot = agent.surface.getSnapshot();
        sendJson(response, 200, {
          status: snapshot.status,
          account: snapshot.authentication.account?.type ?? null,
          threadCount: snapshot.conversations.length,
          realtimeVoiceAvailable: this.isRealtimeVoiceAvailable(agent),
          agentId: agent.id,
          agentName: agent.name,
        });
        return;
      }

      if (request.method === 'GET' && path === '/threads') {
        const threads = await agent.surface.listConversations({ limit: 30 });
        sendJson(response, 200, { threads: toDeviceThreads(threads) });
        return;
      }

      if (request.method === 'POST' && path === '/threads') {
        const body = await readJsonBody(request);
        const snapshot = await agent.surface.createConversation(
          DEVICE_CONVERSATION_OPTIONS,
        );
        const threadId = snapshot.activeConversationId;
        if (!threadId) throw new Error('Codex did not return a new thread id');
        const prompt = recordString(body, 'text', false);
        if (prompt) {
          await this.sendPrompt(agent, threadId, prompt);
          sendJson(response, 201, await this.threadPayload(agent, threadId));
        } else {
          sendJson(response, 201, {
            thread: toDeviceThreadState(snapshot, threadId),
          });
        }
        return;
      }

      const messageMatch = path.match(/^\/threads\/([^/]+)\/messages$/);
      if (messageMatch) {
        const threadId = decodeURIComponent(messageMatch[1]!);
        if (request.method === 'GET') {
          sendJson(response, 200, await this.threadPayload(agent, threadId));
          return;
        }
        if (request.method === 'POST') {
          const body = await readJsonBody(request);
          const prompt = recordString(body, 'text', true);
          await this.sendPrompt(agent, threadId, prompt);
          sendJson(response, 202, await this.threadPayload(agent, threadId));
          return;
        }
      }

      const interruptMatch = path.match(/^\/threads\/([^/]+)\/interrupt$/);
      if (request.method === 'POST' && interruptMatch) {
        const threadId = decodeURIComponent(interruptMatch[1]!);
        await agent.surface.conversation(threadId).interrupt();
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

  private publishBonjour(port: number): void {
    const name = this.options.pairing?.hostName ?? `Codex Remote on ${os.hostname()}`;
    const txt = {
      api: String(API_VERSION),
      path: '/api/v1/agents/{agentId}/device',
      ...(this.options.pairing
        ? {
            hostId: this.options.pairing.hostId,
            hostName: this.options.pairing.hostName,
          }
        : {}),
    };
    if (process.platform === 'darwin') {
      const publisher = spawn('/usr/bin/dns-sd', [
        '-R',
        name,
        '_codex-remote._tcp',
        'local.',
        String(port),
        ...Object.entries(txt).map(([key, value]) => `${key}=${value}`),
      ], { stdio: 'ignore' });
      publisher.once('error', (error) => {
        console.warn('Codex Remote Bonjour advertisement failed:', error);
      });
      publisher.once('exit', (code, signal) => {
        if (this.mdnsProcess !== publisher) return;
        this.mdnsProcess = null;
        if (this.info && code !== 0 && signal !== 'SIGTERM') {
          console.warn(`Codex Remote Bonjour publisher exited with code ${code}`);
        }
      });
      publisher.unref();
      this.mdnsProcess = publisher;
      return;
    }
    this.bonjour = new Bonjour({}, (error: unknown) => {
      console.warn('Codex Remote Bonjour advertisement failed:', error);
    });
    this.mdnsService = this.bonjour.publish({
      name,
      type: 'codex-remote',
      protocol: 'tcp',
      port,
      txt,
    });
  }

  private attachDevice(
    socket: WebSocket,
    agent: RemoteCodexAgent,
    authorizationToken: string,
  ): void {
    const session: DeviceSession = {
      socket,
      authorizationToken,
      agent,
      threadId: null,
      audio: null,
      realtime: null,
      pending: Promise.resolve(),
      speech: null,
      closed: false,
    };
    this.sessions.add(session);
    this.send(session, {
      type: 'hello',
      apiVersion: API_VERSION,
      platform: process.platform,
      agentId: agent.id,
      agentName: agent.name,
      transcription: this.isRealtimeVoiceAvailable(agent) || this.options.transcribeAudio
        ? 'available'
        : 'unavailable',
    });
    void this.sendThreads(session, true).catch((error) => this.sendError(session, error));

    socket.on('message', (data, isBinary) => {
      if (isAudioStartControl(data, isBinary)) {
        this.cancelSpeech(session);
      }
      session.pending = session.pending.then(() => (
        session.closed
          ? undefined
          : this.handleDeviceMessage(session, data, isBinary)
      ));
    });
    const detach = () => {
      if (session.closed) return;
      session.closed = true;
      this.cancelSpeech(session);
      this.sessions.delete(session);
      void session.pending
        .then(() => this.releaseActiveThread(session))
        .catch((error) => console.warn('Failed to release device thread', error));
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
          await this.sendThreads(session, true);
          return;
        case 'close_thread':
          await this.releaseActiveThread(session);
          await this.sendThreads(session, true);
          return;
        case 'create_thread': {
          await this.releaseActiveThread(session);
          const snapshot = await session.agent.surface.createConversation(
            DEVICE_CONVERSATION_OPTIONS,
          );
          const threadId = snapshot.activeConversationId;
          if (!threadId) throw new Error('Codex did not return a new thread id');
          session.threadId = threadId;
          this.send(session, {
            type: 'thread',
            thread: toDeviceThreadState(snapshot, threadId),
          });
          this.broadcastThreads(session.agent.id);
          return;
        }
        case 'open_voice_chat': {
          await this.releaseActiveThread(session);
          if (command.threadId) {
            try {
              session.threadId = command.threadId;
              await this.sendThread(session, command.threadId);
              return;
            } catch (error) {
              session.threadId = null;
              session.agent.surface.forgetConversation(command.threadId);
              if (!isUnavailableVoiceThreadError(error)) throw error;
            }
          }
          let snapshot = await session.agent.surface.createConversation(
            DEVICE_CONVERSATION_OPTIONS,
          );
          const threadId = snapshot.activeConversationId;
          if (!threadId) throw new Error('Codex did not return a voice chat thread id');
          snapshot = await session.agent.surface.conversation(threadId).rename(
            VOICE_CHAT_TITLE,
          );
          session.threadId = threadId;
          this.send(session, {
            type: 'thread',
            thread: toDeviceThreadState(snapshot, threadId),
          });
          this.broadcastThreads(session.agent.id);
          return;
        }
        case 'open_thread':
          if (session.threadId !== command.threadId) {
            await this.releaseActiveThread(session);
          }
          session.threadId = command.threadId;
          await this.sendThread(session, command.threadId);
          return;
        case 'send_text': {
          const threadId = command.threadId ?? session.threadId;
          if (!threadId) throw new Error('Open a thread before sending a command');
          session.threadId = threadId;
          await this.sendPrompt(session.agent, threadId, command.text);
          await this.sendThread(session, threadId);
          return;
        }
        case 'interrupt': {
          const threadId = command.threadId ?? session.threadId;
          if (!threadId) throw new Error('Open a thread before interrupting it');
          await session.agent.surface.conversation(threadId).interrupt();
          return;
        }
        case 'speak_message': {
          const threadId = command.threadId ?? session.threadId;
          if (!threadId) throw new Error('Open a thread before reading a message');
          session.threadId = threadId;
          await this.speakMessage(session, threadId, command.messageId);
          return;
        }
        case 'audio_start': {
          const threadId = command.threadId ?? session.threadId;
          if (!threadId) throw new Error('Open a thread before recording');
          if (session.audio) throw new Error('A recording is already in progress');
          session.threadId = threadId;
          const sampleRate = command.sampleRate ?? REALTIME_SAMPLE_RATE;
          if (command.realtime) {
            if (!this.isRealtimeVoiceAvailable(session.agent)) {
              throw new Error('Realtime voice is unavailable on this agent');
            }
            const realtime = await this.ensureRealtime(session, threadId);
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
            if (session.realtime) await this.releaseRealtime(session);
            if (!this.options.transcribeAudio) {
              throw new Error('Speech transcription is unavailable');
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
          return;
        case 'audio_cancel':
          await this.cancelAudio(session);
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
    if (
      capture.mode === 'transcription'
      && capture.byteLength + chunk.byteLength > MAX_AUDIO_BYTES
    ) {
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
    capture.pending = capture.pending.then(() => realtime.handle.appendAudio({
      data: bytes,
      sampleRate: capture.sampleRate,
      numChannels: 1,
    }));
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
      await this.sendPrompt(session.agent, session.threadId, text);
      return;
    }
    const realtime = session.realtime;
    if (!realtime || realtime.threadId !== session.threadId) {
      throw new Error('Realtime voice session is not active');
    }

    await capture.pending;
    const silenceSamples = Math.floor(REALTIME_SAMPLE_RATE * 0.7);
    const silence = new Uint8Array(silenceSamples * 2);
    await realtime.handle.appendAudio({
      data: silence,
      sampleRate: REALTIME_SAMPLE_RATE,
      numChannels: 1,
      samplesPerChannel: silenceSamples,
    });
    this.send(session, {
      type: 'status',
      status: 'sending',
      detail: 'Waiting for Codex',
    });
  }

  private async cancelAudio(session: DeviceSession): Promise<void> {
    const capture = session.audio;
    session.audio = null;
    if (capture?.mode === 'realtime') {
      await this.releaseRealtime(session);
    }
    this.send(session, { type: 'status', status: 'ready' });
  }

  private async speakMessage(
    session: DeviceSession,
    threadId: string,
    messageId: string,
  ): Promise<void> {
    const payload = await this.threadPayload(session.agent, threadId);
    const message = payload.thread.messages.find((candidate) => candidate.id === messageId);
    if (!message) throw new Error('That message is no longer available on the device');
    if (message.role !== 'assistant') throw new Error('Only assistant replies can be read aloud');
    if (!message.text.trim()) throw new Error('That assistant reply has no readable text');

    const speech = this.beginSpeech(session);
    this.send(session, {
      type: 'status',
      status: 'speaking',
      detail: 'Reading the assistant reply',
    });
    try {
      if (this.options.synthesizeSpeech) {
        let audio: SpeechAudio | null;
        try {
          audio = await Promise.race([
            this.options.synthesizeSpeech(message.text, speech.controller.signal),
            speech.cancelled.then(() => null),
          ]);
        } catch (error) {
          if (speech.controller.signal.aborted) return;
          throw error;
        }
        if (audio === null) return;
        let sent: boolean | null;
        try {
          sent = await this.sendSpeechAudio(session, audio, speech);
        } catch (error) {
          if (speech.controller.signal.aborted) return;
          throw error;
        }
        if (sent === null) return;
        if (!sent) throw new Error('Speech synthesis returned no audio');
        this.send(session, { type: 'status', status: 'ready' });
        return;
      }

      if (!this.isRealtimeVoiceAvailable(session.agent)) {
        throw new Error('Reading replies aloud is unavailable on this desktop');
      }
      const realtime = await this.ensureRealtime(session, threadId);
      await realtime.handle.appendSpeech(message.text);
    } finally {
      if (session.speech === speech) session.speech = null;
    }
  }

  private async sendSpeechAudio(
    session: DeviceSession,
    audio: SpeechAudio,
    speech: DeviceSpeech,
  ): Promise<boolean | null> {
    let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let sentBytes = 0;
    const iterator = speechAudioChunks(audio)[Symbol.asyncIterator]();
    while (true) {
      const next = await Promise.race([
        iterator.next(),
        speech.cancelled.then(() => null),
      ]);
      if (next === null) {
        void iterator.return?.(undefined).catch(() => undefined);
        return null;
      }
      if (next.done) break;
      const value = next.value;
      if (session.closed || session.socket.readyState !== WebSocket.OPEN) {
        return sentBytes > 0;
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const combined = carry.byteLength > 0
        ? Buffer.concat([carry, chunk])
        : chunk;
      const available = Math.min(
        combined.byteLength,
        MAX_AUDIO_BYTES - sentBytes,
      );
      const playableLength = available - (available % 2);
      for (let offset = 0; offset < playableLength; offset += 4_800) {
        if (speech.controller.signal.aborted) return null;
        if (session.closed || session.socket.readyState !== WebSocket.OPEN) {
          return sentBytes > 0;
        }
        const frame = combined.subarray(
          offset,
          Math.min(offset + 4_800, playableLength),
        );
        session.socket.send(frame);
        sentBytes += frame.byteLength;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (sentBytes >= MAX_AUDIO_BYTES) break;
      carry = combined.subarray(playableLength);
    }
    return sentBytes > 0;
  }

  private beginSpeech(session: DeviceSession): DeviceSpeech {
    this.cancelSpeech(session);
    const controller = new AbortController();
    const cancelled = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const speech = { controller, cancelled };
    session.speech = speech;
    return speech;
  }

  private cancelSpeech(session: DeviceSession): void {
    session.speech?.controller.abort();
  }

  private async ensureRealtime(
    session: DeviceSession,
    threadId: string,
  ): Promise<DeviceRealtime> {
    if (session.realtime?.threadId === threadId) return session.realtime;
    await this.releaseRealtime(session);
    const conversation = session.agent.surface.conversation(threadId);
    await ensureConversationLoaded(conversation);
    let handle: CodexRealtimeSession | null = null;
    try {
      const realtimeVoice = this.options.realtimeVoice?.trim();
      const realtimeInstructions = this.options.realtimeInstructions?.trim();
      handle = await conversation.startRealtime({
        outputModality: 'audio',
        version: 'v2',
        ...(realtimeVoice ? { voice: realtimeVoice } : {}),
        ...(realtimeInstructions ? { prompt: realtimeInstructions } : {}),
        includeStartupContext: true,
        flushTranscriptTailOnSessionEnd: true,
        transport: { type: 'websocket' },
      });
      const realtime: DeviceRealtime = {
        threadId,
        handle,
        unsubscribe: () => undefined,
        outputIdleTimer: null,
        speaking: false,
      };
      realtime.unsubscribe = handle.onEvent((event) => {
        this.handleRealtimeEvent(session, realtime, event);
      });
      session.realtime = realtime;
      return realtime;
    } catch (error) {
      await handle?.stop().catch(() => undefined);
      throw error;
    }
  }

  private isRealtimeVoiceAvailable(agent: RemoteCodexAgent): boolean {
    return agent.realtimeVoiceAvailable?.() ?? true;
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
        if (event.payload.role === 'assistant') this.scheduleRealtimeOutputIdle(session, realtime);
        return;
      case 'realtime.audioDelta':
        if (!realtime.speaking) {
          realtime.speaking = true;
          this.send(session, {
            type: 'status',
            status: 'speaking',
            detail: 'Codex is replying',
          });
        }
        this.scheduleRealtimeOutputIdle(session, realtime);
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
        if (realtime.outputIdleTimer) clearTimeout(realtime.outputIdleTimer);
        realtime.unsubscribe();
        session.realtime = null;
        session.audio = null;
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
    if (realtime.outputIdleTimer) clearTimeout(realtime.outputIdleTimer);
    realtime.unsubscribe();
    try {
      await realtime.handle.stop();
    } catch {
      // The app-server may already have closed the experimental transport.
    }
  }

  private scheduleRealtimeOutputIdle(
    session: DeviceSession,
    realtime: DeviceRealtime,
  ): void {
    if (realtime.outputIdleTimer) clearTimeout(realtime.outputIdleTimer);
    realtime.outputIdleTimer = setTimeout(() => {
      realtime.outputIdleTimer = null;
      if (session.realtime !== realtime || session.closed) return;
      realtime.speaking = false;
      this.send(session, { type: 'status', status: 'ready' });
    }, 600);
  }

  private async releaseActiveThread(session: DeviceSession): Promise<void> {
    const threadId = session.threadId;
    session.threadId = null;
    this.cancelSpeech(session);
    await this.releaseRealtime(session);
    if (!threadId) return;
    const usedByAnotherSession = [...this.sessions].some((candidate) => (
      candidate !== session
      && !candidate.closed
      && candidate.agent.id === session.agent.id
      && candidate.threadId === threadId
    ));
    if (usedByAnotherSession) return;
    if (session.agent.releaseThread) {
      await session.agent.releaseThread(threadId);
      return;
    }
    session.agent.surface.forgetConversation(threadId);
  }

  private async sendPrompt(
    agent: RemoteCodexAgent,
    threadId: string,
    prompt: string,
  ): Promise<void> {
    const text = prompt.trim();
    if (!text) throw new Error('text must be a non-empty string');
    if (text.length > MAX_PROMPT_CHARS) throw new Error('text is too long');
    const conversation = agent.surface.conversation(threadId);
    await ensureConversationLoaded(conversation);
    await conversation.sendMessage(text);
  }

  private async threadPayload(
    agent: RemoteCodexAgent,
    threadId: string,
  ): Promise<{
    thread: ReturnType<typeof toDeviceThreadState>;
  }> {
    let snapshot: CodexSurfaceSnapshot;
    if (agent.readRecentMessages) {
      try {
        snapshot = recentThreadSnapshot(
          agent,
          threadId,
          await agent.readRecentMessages(threadId),
        );
      } catch (error) {
        if (!isUnmaterializedThreadError(error)) throw error;
        snapshot = recentThreadSnapshot(agent, threadId, []);
      }
    } else {
      snapshot = await loadConversationSnapshot(agent.surface.conversation(threadId));
    }
    return {
      thread: toDeviceThreadState(snapshot, threadId),
    };
  }

  private async sendThreads(session: DeviceSession, refresh = false): Promise<void> {
    const conversations = refresh
      ? await session.agent.surface.listConversations({ limit: 30 })
      : session.agent.surface.getSnapshot().conversations;
    this.send(session, {
      type: 'threads',
      threads: toDeviceThreads(conversations),
    });
  }

  private broadcastThreads(agentId: string): void {
    for (const session of this.sessions) {
      if (session.agent.id === agentId) {
        void this.sendThreads(session).catch((error) => this.sendError(session, error));
      }
    }
  }

  private scheduleConversationBroadcast(agentId: string, threadId: string): void {
    const key = `${agentId}:${threadId}`;
    if (this.conversationBroadcastTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.conversationBroadcastTimers.delete(key);
      void this.broadcastConversation(agentId, threadId);
    }, 80);
    this.conversationBroadcastTimers.set(key, timer);
  }

  private async broadcastConversation(agentId: string, threadId: string): Promise<void> {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return;
    const matching = [...this.sessions].filter((session) => (
      session.agent.id === agentId && session.threadId === threadId
    ));
    if (matching.length === 0) return;
    try {
      const { thread } = await this.threadPayload(agent, threadId);
      const message: DeviceServerMessage = {
        type: 'thread',
        thread,
      };
      for (const session of matching) this.send(session, message);
    } catch (error) {
      for (const session of matching) this.sendError(session, error);
    }
  }

  private denyPendingApprovals(
    agent: RemoteCodexAgent,
    approvals: readonly CodexSurfaceApproval[],
  ): void {
    for (const approval of approvals) {
      const key = `${agent.id}:${approval.conversationId}:${approval.id}`;
      if (this.resolvingApprovalIds.has(key)) continue;
      this.resolvingApprovalIds.add(key);
      void agent.surface.conversation(approval.conversationId)
        .resolveApproval(approval.id, 'deny', 'once')
        .catch((error) => {
          console.error('Failed to deny unsupported device approval', error);
        })
        .finally(() => this.resolvingApprovalIds.delete(key));
    }
  }

  private async sendThread(session: DeviceSession, threadId: string): Promise<void> {
    const payload = await this.threadPayload(session.agent, threadId);
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

  private deviceAgent(pathname: string): RemoteCodexAgent | null {
    const match = pathname.match(/^\/api\/v1\/agents\/([^/]+)\/device$/);
    if (!match) return null;
    const agentId = decodedPathSegment(match[1]!);
    return agentId
      ? this.agents.find((agent) => agent.id === agentId) ?? null
      : null;
  }

  private agentRoute(pathname: string): {
    agent: RemoteCodexAgent;
    path: string;
  } | null {
    const match = pathname.match(/^\/api\/v1\/agents\/([^/]+)(\/.*)$/);
    if (!match) return null;
    const agentId = decodedPathSegment(match[1]!);
    if (!agentId) return null;
    const agent = this.agents.find(
      (candidate) => candidate.id === agentId,
    );
    return agent ? { agent, path: match[2]! } : null;
  }
}

function recentThreadSnapshot(
  agent: RemoteCodexAgent,
  threadId: string,
  messages: SurfaceMessage[],
): CodexSurfaceSnapshot {
  const snapshot = agent.surface.getSnapshot();
  const summary = snapshot.conversations.find((conversation) => conversation.id === threadId);
  return {
    ...snapshot,
    messages,
    busy: summary?.status === 'active',
    error: null,
  };
}

function decodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
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

function isAudioStartControl(data: RawData, isBinary: boolean): boolean {
  if (isBinary) return false;
  try {
    const value = JSON.parse(rawDataBuffer(data).toString('utf8')) as unknown;
    return Boolean(
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (value as Record<string, unknown>).type === 'audio_start',
    );
  } catch {
    return false;
  }
}

function isUnmaterializedThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('is not materialized yet')
    && message.includes('thread/turns/list');
}

function isThreadNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes('thread not found');
}

function isUnavailableVoiceThreadError(error: unknown): boolean {
  if (isThreadNotFoundError(error)) return true;
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('thread-store conflict')
    && normalized.includes('active writer');
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

function requestAuthorizationToken(request: IncomingMessage, url: URL): string {
  const header = request.headers['x-codex-remote-token'];
  const headerToken = Array.isArray(header) ? header[0] : header;
  return headerToken ?? url.searchParams.get('token') ?? '';
}
