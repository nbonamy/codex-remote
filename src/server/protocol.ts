import type {
  CodexConversationSummary,
  CodexSurfaceSnapshot,
  SurfaceMessage,
} from 'codex-app-sdk/surface';

export const API_VERSION = 1;
export const MAX_DEVICE_THREADS = 12;
export const MAX_DEVICE_MESSAGES = 14;
export const REALTIME_SAMPLE_RATE = 24_000;
export const MAX_AUDIO_BYTES = REALTIME_SAMPLE_RATE * 2 * 45;
export const MAX_PROMPT_CHARS = 16_000;

export type DeviceThread = {
  id: string;
  title: string;
  preview: string;
  status: CodexConversationSummary['status'];
  updatedAt: string;
};

export type DeviceMessage = {
  id: string;
  role: SurfaceMessage['role'];
  status: SurfaceMessage['status'];
  text: string;
};

export type DeviceThreadState = {
  id: string;
  title: string;
  busy: boolean;
  error: string | null;
  messages: DeviceMessage[];
};

export type DeviceClientCommand =
  | { type: 'hello'; device?: string }
  | { type: 'list_threads' }
  | { type: 'close_thread' }
  | { type: 'create_thread' }
  | { type: 'open_thread'; threadId: string }
  | { type: 'send_text'; threadId?: string; text: string }
  | { type: 'interrupt'; threadId?: string }
  | { type: 'speak_message'; threadId?: string; messageId: string }
  | { type: 'audio_start'; threadId?: string; sampleRate?: number }
  | { type: 'audio_end' }
  | { type: 'audio_cancel' };

export type DeviceServerMessage =
  | {
    type: 'hello';
    apiVersion: number;
    platform: NodeJS.Platform;
    agentId: string;
    agentName: string;
    transcription: 'available' | 'unavailable';
  }
  | { type: 'threads'; threads: DeviceThread[] }
  | { type: 'thread'; thread: DeviceThreadState }
  | { type: 'transcript'; role: string; text: string }
  | {
    type: 'status';
    status: 'ready' | 'recording' | 'transcribing' | 'sending' | 'speaking';
    detail?: string;
  }
  | { type: 'error'; message: string };

export function toDeviceThreads(
  conversations: readonly CodexConversationSummary[],
): DeviceThread[] {
  return conversations.slice(0, MAX_DEVICE_THREADS).map((conversation) => ({
    id: conversation.id,
    title: boundedText(conversation.title || 'Untitled thread', 80),
    preview: boundedText(conversation.preview, 160),
    status: conversation.status,
    updatedAt: conversation.updatedAt,
  }));
}

export function toDeviceMessages(messages: readonly SurfaceMessage[]): DeviceMessage[] {
  return messages
    .map((message) => ({
      id: message.id,
      role: message.role,
      status: message.status,
      text: normalizedMessageText(messageText(message)),
    }))
    .filter((message) => message.text.length > 0)
    .slice(-MAX_DEVICE_MESSAGES);
}

export function toDeviceThreadState(
  snapshot: Pick<CodexSurfaceSnapshot, 'conversations' | 'messages' | 'busy' | 'error'>,
  threadId: string,
): DeviceThreadState {
  const summary = snapshot.conversations.find((conversation) => conversation.id === threadId);
  return {
    id: threadId,
    title: boundedText(summary?.title || 'Codex thread', 80),
    busy: snapshot.busy,
    error: snapshot.error,
    messages: toDeviceMessages(snapshot.messages),
  };
}

export function parseDeviceCommand(value: unknown): DeviceClientCommand {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Control frame must be a JSON object with a type');
  }

  switch (value.type) {
    case 'hello':
    case 'list_threads':
    case 'close_thread':
    case 'create_thread':
    case 'audio_end':
    case 'audio_cancel':
      return { type: value.type };
    case 'open_thread':
      return {
        type: value.type,
        threadId: requiredString(value.threadId, 'threadId'),
      };
    case 'send_text':
      return {
        type: value.type,
        ...(optionalString(value.threadId) ? { threadId: optionalString(value.threadId) } : {}),
        text: requiredString(value.text, 'text', MAX_PROMPT_CHARS),
      };
    case 'interrupt':
      return {
        type: value.type,
        ...(optionalString(value.threadId) ? { threadId: optionalString(value.threadId) } : {}),
      };
    case 'speak_message':
      return {
        type: value.type,
        ...(optionalString(value.threadId) ? { threadId: optionalString(value.threadId) } : {}),
        messageId: requiredString(value.messageId, 'messageId'),
      };
    case 'audio_start': {
      const sampleRate = value.sampleRate === undefined
        ? REALTIME_SAMPLE_RATE
        : Number(value.sampleRate);
      if (sampleRate !== REALTIME_SAMPLE_RATE) {
        throw new Error('Only 24 kHz microphone audio is supported');
      }
      return {
        type: value.type,
        sampleRate,
        ...(optionalString(value.threadId) ? { threadId: optionalString(value.threadId) } : {}),
      };
    }
    default:
      throw new Error(`Unknown control frame '${value.type}'`);
  }
}

function messageText(message: SurfaceMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === 'text') {
        return message.role === 'assistant' && part.phase === 'commentary'
          ? ''
          : part.text;
      }
      if (part.type === 'attachment') return `[${part.attachment.name}]`;
      if (part.type === 'media') return part.media.alt || part.media.title || '[media]';
      return '';
    })
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
    .trim();
}

function requiredString(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${name} is too long`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boundedText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function normalizedMessageText(value: string): string {
  const normalized = value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n');
  return normalized
    .split(/\n[ \t]*\n+/)
    .map((block) => (
      preservesLineBreaks(block)
        ? block.trim()
        : block.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
    ))
    .filter(Boolean)
    .join('\n\n');
}

function preservesLineBreaks(block: string): boolean {
  return block.split('\n').some((line) => (
    /^\s*(?:```|~~~|#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|\|)/.test(line)
    || /^\s{4}\S/.test(line)
  ));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
