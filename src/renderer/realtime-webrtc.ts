import type {
  RealtimeRendererCommand,
  RealtimeRendererEvent,
} from '../main/contracts';

type RendererPeer = {
  pc: RTCPeerConnection;
  context: AudioContext;
  input: MediaStreamAudioDestinationNode;
  keepAlive: ConstantSourceNode;
  outputSource: MediaStreamAudioSourceNode | null;
  outputProcessor: ScriptProcessorNode | null;
  nextInputAt: number;
};

const peers = new Map<string, RendererPeer>();

export function installRealtimeWebRtcBridge(): void {
  window.codexRemote.onRealtimeCommand((command) => {
    void handleCommand(command).catch((error) => {
      send({
        id: command.id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      closePeer(command.id, false);
    });
  });
}

async function handleCommand(command: RealtimeRendererCommand): Promise<void> {
  switch (command.type) {
    case 'create-offer':
      await createOffer(command.id);
      return;
    case 'apply-answer':
      await applyAnswer(command.id, command.sdp);
      return;
    case 'append-audio':
      appendAudio(command.id, command.data, command.sampleRate);
      return;
    case 'close':
      closePeer(command.id, true);
  }
}

async function createOffer(id: string): Promise<void> {
  closePeer(id, false);
  const context = new AudioContext({ sampleRate: 48_000 });
  await context.resume();
  const input = context.createMediaStreamDestination();
  const keepAlive = context.createConstantSource();
  const keepAliveGain = context.createGain();
  keepAliveGain.gain.value = 0;
  keepAlive.connect(keepAliveGain).connect(input);
  keepAlive.start();

  const pc = new RTCPeerConnection();
  const peer: RendererPeer = {
    pc,
    context,
    input,
    keepAlive,
    outputSource: null,
    outputProcessor: null,
    nextInputAt: 0,
  };
  peers.set(id, peer);
  pc.addTrack(input.stream.getAudioTracks()[0]!, input.stream);
  pc.createDataChannel('oai-events');
  pc.ontrack = (event) => attachOutputTrack(id, event);
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      send({ id, type: 'error', message: 'WebRTC realtime connection failed' });
      closePeer(id, false);
    } else if (pc.connectionState === 'closed') {
      closePeer(id, true);
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForIceGathering(pc);
  const sdp = pc.localDescription?.sdp;
  if (!sdp) throw new Error('WebRTC did not produce an SDP offer');
  send({ id, type: 'offer', sdp });
}

async function applyAnswer(id: string, sdp: string): Promise<void> {
  const peer = requirePeer(id);
  await peer.pc.setRemoteDescription({ type: 'answer', sdp });
  if (peer.pc.connectionState !== 'connected') {
    await waitForConnection(peer.pc);
  }
  send({ id, type: 'ready' });
}

function appendAudio(
  id: string,
  data: Uint8Array,
  sampleRate: number,
): void {
  const peer = requirePeer(id);
  const bytes = new Uint8Array(data);
  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (!sampleCount) return;
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
  const buffer = peer.context.createBuffer(1, sampleCount, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let index = 0; index < sampleCount; index += 1) {
    channel[index] = samples[index]! / 32_768;
  }
  const source = peer.context.createBufferSource();
  source.buffer = buffer;
  source.connect(peer.input);
  const startAt = Math.max(peer.context.currentTime + 0.025, peer.nextInputAt);
  source.start(startAt);
  peer.nextInputAt = startAt + buffer.duration;
}

function attachOutputTrack(id: string, event: RTCTrackEvent): void {
  const peer = requirePeer(id);
  const stream = event.streams[0] ?? new MediaStream([event.track]);
  const source = peer.context.createMediaStreamSource(stream);
  const processor = peer.context.createScriptProcessor(4_096, 1, 1);
  const mute = peer.context.createGain();
  mute.gain.value = 0;
  processor.onaudioprocess = (audioEvent) => {
    const pcm = downsampleToPcm16(
      audioEvent.inputBuffer.getChannelData(0),
      peer.context.sampleRate,
      24_000,
    );
    if (pcm.byteLength) {
      send({ id, type: 'audio', data: new Uint8Array(pcm.buffer) });
    }
  };
  source.connect(processor);
  processor.connect(mute).connect(peer.context.destination);
  peer.outputSource = source;
  peer.outputProcessor = processor;
}

function downsampleToPcm16(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Int16Array {
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);
  for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      sum += input[inputIndex]!;
    }
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[outputIndex] = sample < 0 ? sample * 32_768 : sample * 32_767;
  }
  return output;
}

function closePeer(id: string, notify: boolean): void {
  const peer = peers.get(id);
  if (!peer) return;
  peers.delete(id);
  peer.outputProcessor?.disconnect();
  peer.outputSource?.disconnect();
  peer.keepAlive.stop();
  for (const sender of peer.pc.getSenders()) sender.track?.stop();
  peer.pc.close();
  void peer.context.close();
  if (notify) send({ id, type: 'closed' });
}

function requirePeer(id: string): RendererPeer {
  const peer = peers.get(id);
  if (!peer) throw new Error('WebRTC realtime peer is unavailable');
  return peer;
}

function send(event: RealtimeRendererEvent): void {
  window.codexRemote.sendRealtimeEvent(event);
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

function waitForConnection(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve, reject) => {
    const onChange = () => {
      if (pc.connectionState === 'connected') {
        cleanup();
        resolve();
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanup();
        reject(new Error(`WebRTC realtime connection ${pc.connectionState}`));
      }
    };
    const cleanup = () => pc.removeEventListener('connectionstatechange', onChange);
    pc.addEventListener('connectionstatechange', onChange);
    onChange();
  });
}
