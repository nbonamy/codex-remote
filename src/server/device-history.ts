import type { CodexAppServerClient } from 'codex-app-sdk/codex';
import { codexTurnToSurfaceMessages } from 'codex-app-sdk/node';
import type { SurfaceMessage } from 'codex-app-sdk/surface';

export const DEVICE_RECENT_TURN_LIMIT = 5;

export async function readDeviceRecentMessages(
  client: CodexAppServerClient,
  threadId: string,
): Promise<SurfaceMessage[]> {
  const page = await client.request('thread/turns/list', {
    threadId,
    cursor: null,
    limit: DEVICE_RECENT_TURN_LIMIT,
    sortDirection: 'desc',
    itemsView: 'summary',
  });
  return [...page.data]
    .reverse()
    .flatMap((turn) => codexTurnToSurfaceMessages(threadId, turn));
}
