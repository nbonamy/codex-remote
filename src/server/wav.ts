export function pcm16LeToWave(
  pcm: Uint8Array,
  sampleRate: number,
  channels = 1,
): Buffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new TypeError('sampleRate must be a positive integer');
  }
  if (!Number.isInteger(channels) || channels <= 0) {
    throw new TypeError('channels must be a positive integer');
  }
  const dataLength = pcm.byteLength - (pcm.byteLength % 2);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([
    header,
    Buffer.from(pcm.buffer, pcm.byteOffset, dataLength),
  ]);
}
