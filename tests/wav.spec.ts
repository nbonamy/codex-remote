import { describe, expect, it } from 'vitest';
import { pcm16LeToWave, waveToPcm16Le } from '../src/server/wav';

describe('WAVE conversion', () => {
  it('extracts mono 24 kHz PCM from a WAVE container', () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    expect(waveToPcm16Le(pcm16LeToWave(pcm, 24_000))).toStrictEqual(pcm);
  });

  it('rejects audio in the wrong playback format', () => {
    expect(() => waveToPcm16Le(pcm16LeToWave(Buffer.from([1, 2]), 16_000)))
      .toThrow('Speech synthesizer must return mono 16-bit PCM at 24 kHz');
  });
});
