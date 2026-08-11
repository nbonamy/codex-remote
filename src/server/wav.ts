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

export function waveToPcm16Le(wave: Uint8Array): Buffer {
  const bytes = Buffer.from(wave.buffer, wave.byteOffset, wave.byteLength);
  if (
    bytes.byteLength < 12
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('Speech synthesizer returned an invalid WAVE file');
  }

  let formatValid = false;
  let data: Buffer | null = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + length;
    if (bodyEnd > bytes.byteLength) {
      throw new Error('Speech synthesizer returned a truncated WAVE file');
    }
    if (type === 'fmt ' && length >= 16) {
      formatValid = (
        bytes.readUInt16LE(bodyStart) === 1
        && bytes.readUInt16LE(bodyStart + 2) === 1
        && bytes.readUInt32LE(bodyStart + 4) === 24_000
        && bytes.readUInt16LE(bodyStart + 14) === 16
      );
    } else if (type === 'data') {
      data = bytes.subarray(bodyStart, bodyEnd - (length % 2));
    }
    offset = bodyEnd + (length % 2);
  }
  if (!formatValid || !data) {
    throw new Error('Speech synthesizer must return mono 16-bit PCM at 24 kHz');
  }
  return Buffer.from(data);
}
