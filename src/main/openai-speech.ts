import type { SpeechSynthesizer } from '../server/remote-server';

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech';
const MAX_INPUT_CHARS = 4_096;

export type OpenAiSpeechOptions = {
  apiKey: string;
  model?: string;
  voice?: string;
  instructions?: string;
  fetch?: typeof globalThis.fetch;
};

export function createOpenAiSpeechSynthesizer(
  options: OpenAiSpeechOptions,
): SpeechSynthesizer {
  const fetchSpeech = options.fetch ?? globalThis.fetch;
  const model = options.model?.trim() || 'gpt-4o-mini-tts';
  const voice = options.voice?.trim() || 'marin';
  const instructions = options.instructions?.trim()
    || 'Speak naturally in English with a warm, conversational tone, clear pacing, and subtle expression.';

  return async (text, signal) => {
    const response = await fetchSpeech(OPENAI_SPEECH_URL, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice,
        input: text.slice(0, MAX_INPUT_CHARS),
        instructions,
        response_format: 'pcm',
        stream_format: 'audio',
      }),
    });
    if (!response.ok) {
      throw new Error(await speechApiError(response));
    }
    if (!response.body) {
      throw new Error('OpenAI speech returned no audio stream');
    }
    return responseBodyChunks(response.body);
  };
}

async function speechApiError(response: Response): Promise<string> {
  let detail = '';
  try {
    const payload = await response.json() as { error?: { message?: string } };
    detail = payload.error?.message?.trim() || '';
  } catch {
    // Keep the status-only error when the response is not JSON.
  }
  const suffix = detail ? `: ${detail.slice(0, 300)}` : '';
  return `OpenAI speech failed (${response.status})${suffix}`;
}

async function* responseBodyChunks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        return;
      }
      if (value.byteLength > 0) yield value;
    }
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
