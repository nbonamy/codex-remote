export type CodexRemoteAgentState = {
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
  agents: CodexRemoteAgentState[];
  pairingOpenUntil: number | null;
  pairedDeviceCount: number;
  pairedDevices: Array<{
    id: string;
    name: string;
    pairedAt: string;
    lastSeenAt: string | null;
  }>;
  pendingPairings: Array<{
    id: string;
    deviceName: string;
    code: string;
    expiresAt: number;
  }>;
  server: {
    port: number;
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
};
