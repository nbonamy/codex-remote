import type { CodexAppServerClient } from 'codex-app-sdk/codex';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVICE_RECENT_TURN_LIMIT,
  readDeviceRecentMessages,
} from '../src/server/device-history';

describe('device history', () => {
  it('requests exactly five summary turns and no older page', async () => {
    const request = vi.fn(async () => ({
      data: [],
      nextCursor: 'older-page-that-the-device-must-not-load',
      backwardsCursor: null,
    }));

    await expect(readDeviceRecentMessages(
      { request } as unknown as CodexAppServerClient,
      'thread-1',
    )).resolves.toEqual([]);

    expect(DEVICE_RECENT_TURN_LIMIT).toBe(5);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'thread-1',
      cursor: null,
      limit: 5,
      sortDirection: 'desc',
      itemsView: 'summary',
    });
  });
});
