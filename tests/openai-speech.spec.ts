import { describe, expect, it, vi } from 'vitest';
import { createHostSpeechSynthesizer } from '../src/main/host-speech';
import { createOpenAiSpeechSynthesizer } from '../src/main/openai-speech';

describe('OpenAI speech synthesis', () => {
  it('requests streaming 24 kHz PCM with the configured English voice', async () => {
    const fetchSpeech = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4]));
        controller.close();
      },
    })));
    const synthesize = createOpenAiSpeechSynthesizer({
      apiKey: 'test-key',
      voice: 'coral',
      instructions: 'Speak conversationally.',
      fetch: fetchSpeech,
    });

    const chunks: number[][] = [];
    const audio = await synthesize(
      'Hello from the device.',
    ) as AsyncIterable<Uint8Array>;
    for await (const chunk of audio) {
      chunks.push(Array.from(chunk));
    }

    expect(chunks).toEqual([[1, 2], [3, 4]]);
    expect(fetchSpeech).toHaveBeenCalledOnce();
    const [url, init] = fetchSpeech.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-4o-mini-tts',
      voice: 'coral',
      input: 'Hello from the device.',
      instructions: 'Speak conversationally.',
      response_format: 'pcm',
      stream_format: 'audio',
    });
  });

  it('uses Apple speech when an OpenAI request cannot start on macOS', async () => {
    const appleSpeech = vi.fn(async () => Buffer.from([5, 6]));
    const onOpenAiError = vi.fn();
    const synthesize = createHostSpeechSynthesizer({
      platform: 'darwin',
      environment: { OPENAI_API_KEY: 'test-key' },
      appleSpeech,
      onOpenAiError,
      fetch: vi.fn(async () => new Response(JSON.stringify({
        error: { message: 'Unavailable' },
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })),
    });

    expect(await synthesize?.('Fallback')).toStrictEqual(Buffer.from([5, 6]));
    expect(onOpenAiError).toHaveBeenCalledOnce();
    expect(appleSpeech).toHaveBeenCalledWith('Fallback');
  });

  it('keeps Apple speech as the keyless macOS provider', async () => {
    const appleSpeech = vi.fn(async () => Buffer.from([7, 8]));
    const synthesize = createHostSpeechSynthesizer({
      platform: 'darwin',
      environment: {},
      appleSpeech,
    });

    expect(await synthesize?.('Local')).toStrictEqual(Buffer.from([7, 8]));
  });
});
