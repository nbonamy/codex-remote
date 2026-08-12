import type { RpcTransport } from 'codex-app-sdk/codex';
import {
  CodexAppServerStdioTransport,
  CodexAppServerUnixSocketTransport,
  type CodexAppServerStdioTransportOptions,
  type CodexAppServerUnixSocketTransportOptions,
} from 'codex-app-sdk/node';
import type { CodexRemoteAgentProfile } from './agent-profiles';

type AgentTransportDependencies = {
  createStdioTransport?: (
    options: CodexAppServerStdioTransportOptions,
  ) => RpcTransport;
  createUnixSocketTransport?: (
    options: CodexAppServerUnixSocketTransportOptions,
  ) => RpcTransport;
  onSocketFallback?: (error: unknown) => void;
};

/**
 * Prefer the desktop-owned Codex socket, but keep the remote usable when the
 * desktop app was launched without its optional shared daemon.
 */
export async function createAgentTransport(
  profile: CodexRemoteAgentProfile,
  dependencies: AgentTransportDependencies = {},
): Promise<RpcTransport> {
  const createStdioTransport = dependencies.createStdioTransport
    ?? ((options) => new CodexAppServerStdioTransport(options));
  if (profile.transport.type === 'stdio') {
    return createStdioTransport({ codexHome: profile.codexHome });
  }

  const createUnixSocketTransport = dependencies.createUnixSocketTransport
    ?? ((options) => new CodexAppServerUnixSocketTransport(options));
  const sharedTransport = createUnixSocketTransport(profile.transport);
  try {
    await sharedTransport.start();
    return sharedTransport;
  } catch (error) {
    await sharedTransport.close().catch(() => undefined);
    dependencies.onSocketFallback?.(error);
    return createStdioTransport({ codexHome: profile.codexHome });
  }
}
