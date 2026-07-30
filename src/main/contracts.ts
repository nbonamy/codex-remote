export type CodexRemoteHostState = {
  id: string;
  name: string;
  codexHome: string;
  codexStatus: 'idle' | 'connecting' | 'ready' | 'error';
  accountLabel: string | null;
  error: string | null;
};

export type CodexRemoteDesktopState = {
  phase: 'starting' | 'ready' | 'error';
  error: string | null;
  hosts: CodexRemoteHostState[];
  pairingOpenUntil: number | null;
  pairedDeviceCount: number;
  pendingPairings: Array<{
    id: string;
    deviceName: string;
    code: string;
    expiresAt: number;
  }>;
  server: {
    port: number;
    defaultCwd: string;
    localUrl: string;
    networkUrls: string[];
    simulatorUrl: string;
    token: string;
  } | null;
};

export type CodexRemoteDesktopApi = {
  getState(): Promise<CodexRemoteDesktopState>;
  copy(value: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  onStateChange(listener: (state: CodexRemoteDesktopState) => void): () => void;
  sendRealtimeEvent(event: RealtimeRendererEvent): void;
  onRealtimeCommand(listener: (command: RealtimeRendererCommand) => void): () => void;
};

export type RealtimeRendererCommand =
  | { id: string; type: 'create-offer' }
  | { id: string; type: 'apply-answer'; sdp: string }
  | { id: string; type: 'append-audio'; data: Uint8Array; sampleRate: number }
  | { id: string; type: 'close' };

export type RealtimeRendererEvent =
  | { id: string; type: 'offer'; sdp: string }
  | { id: string; type: 'ready' }
  | { id: string; type: 'audio'; data: Uint8Array }
  | { id: string; type: 'error'; message: string }
  | { id: string; type: 'closed' };
