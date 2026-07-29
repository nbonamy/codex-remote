export type RemoteRealtimePeer = {
  readonly offerSdp: string;
  applyAnswer(sdp: string): Promise<void>;
  appendAudio(data: Uint8Array, sampleRate: number): Promise<void>;
  close(): Promise<void>;
};

export type RemoteRealtimeBridge = {
  createPeer(onAudio: (data: Uint8Array) => void): Promise<RemoteRealtimePeer>;
};
