import type { SpeechSynthesizer } from '../server/remote-server';
import { synthesizeWithAppleSpeech } from './apple-speech';
import { createOpenAiSpeechSynthesizer } from './openai-speech';

export type HostSpeechOptions = {
  platform: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  appleSpeech?: SpeechSynthesizer;
  fetch?: typeof globalThis.fetch;
  onOpenAiError?: (error: unknown) => void;
};

export function createHostSpeechSynthesizer(
  options: HostSpeechOptions,
): SpeechSynthesizer | undefined {
  const environment = options.environment ?? process.env;
  const appleSpeech = options.platform === 'darwin'
    ? options.appleSpeech ?? synthesizeWithAppleSpeech
    : undefined;
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey) return appleSpeech;

  const openAiSpeech = createOpenAiSpeechSynthesizer({
    apiKey,
    model: environment.CODEX_REMOTE_TTS_MODEL,
    voice: environment.CODEX_REMOTE_TTS_VOICE,
    instructions: environment.CODEX_REMOTE_TTS_INSTRUCTIONS,
    fetch: options.fetch,
  });
  return async (text, signal) => {
    try {
      return await openAiSpeech(text, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      options.onOpenAiError?.(error);
      if (appleSpeech) return appleSpeech(text, signal);
      throw error;
    }
  };
}
