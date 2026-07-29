import { randomUUID } from 'node:crypto';
import {
  BrowserWindow,
  ipcMain,
  type IpcMainEvent,
} from 'electron';
import type {
  RealtimeRendererCommand,
  RealtimeRendererEvent,
} from './contracts';
import type {
  RemoteRealtimeBridge,
  RemoteRealtimePeer,
} from '../server/realtime-media';

type PendingPeer = {
  onAudio: (data: Uint8Array) => void;
  offer: Deferred<string>;
  ready: Deferred<void>;
  closed: boolean;
};

type Deferred<Value> = {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: Error): void;
};

export class ElectronWebRtcBridge implements RemoteRealtimeBridge {
  private readonly peers = new Map<string, PendingPeer>();

  constructor(private readonly getWindow: () => BrowserWindow | null) {
    ipcMain.on('codex-remote:realtime-event', this.handleEvent);
  }

  async createPeer(onAudio: (data: Uint8Array) => void): Promise<RemoteRealtimePeer> {
    const id = randomUUID();
    const peer: PendingPeer = {
      onAudio,
      offer: deferred<string>(),
      ready: deferred<void>(),
      closed: false,
    };
    void peer.offer.promise.catch(() => undefined);
    void peer.ready.promise.catch(() => undefined);
    this.peers.set(id, peer);
    try {
      this.send({ id, type: 'create-offer' });
      const offerSdp = await withTimeout(
        peer.offer.promise,
        15_000,
        'Timed out creating the local WebRTC offer',
      );
      return {
        offerSdp,
        applyAnswer: async (sdp) => {
          this.requirePeer(id);
          this.send({ id, type: 'apply-answer', sdp });
          await withTimeout(
            peer.ready.promise,
            20_000,
            'Timed out connecting the WebRTC realtime session',
          );
        },
        appendAudio: async (data, sampleRate) => {
          this.requirePeer(id);
          this.send({ id, type: 'append-audio', data, sampleRate });
        },
        close: async () => {
          if (peer.closed) return;
          peer.closed = true;
          this.peers.delete(id);
          this.send({ id, type: 'close' }, false);
        },
      };
    } catch (error) {
      this.peers.delete(id);
      this.send({ id, type: 'close' }, false);
      throw error;
    }
  }

  dispose(): void {
    ipcMain.off('codex-remote:realtime-event', this.handleEvent);
    for (const [id, peer] of this.peers) {
      peer.closed = true;
      this.send({ id, type: 'close' }, false);
    }
    this.peers.clear();
  }

  private readonly handleEvent = (
    event: IpcMainEvent,
    message: RealtimeRendererEvent,
  ): void => {
    const window = this.getWindow();
    if (!window || event.sender !== window.webContents) return;
    const peer = this.peers.get(message?.id);
    if (!peer || peer.closed) return;
    switch (message.type) {
      case 'offer':
        peer.offer.resolve(message.sdp);
        return;
      case 'ready':
        peer.ready.resolve(undefined);
        return;
      case 'audio':
        peer.onAudio(new Uint8Array(message.data));
        return;
      case 'error': {
        const error = new Error(message.message);
        peer.offer.reject(error);
        peer.ready.reject(error);
        return;
      }
      case 'closed':
        peer.closed = true;
        this.peers.delete(message.id);
    }
  };

  private requirePeer(id: string): PendingPeer {
    const peer = this.peers.get(id);
    if (!peer || peer.closed) throw new Error('WebRTC realtime peer is closed');
    return peer;
  }

  private send(command: RealtimeRendererCommand, required = true): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) {
      if (required) throw new Error('The Electron WebRTC renderer is unavailable');
      return;
    }
    window.webContents.send('codex-remote:realtime-command', command);
  }
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  message: string,
): Promise<Value> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
