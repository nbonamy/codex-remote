import { join } from 'node:path';

export type CodexRemoteAgentProfile = {
  id: 'codex' | 'claw';
  name: string;
  codexHome: string;
  transport:
    | { type: 'unixSocket'; socketPath: string }
    | { type: 'stdio' };
};

export function codexAgentProfiles(homeDirectory: string): CodexRemoteAgentProfile[] {
  return [
    socketAgentProfile('codex', 'Codex', join(homeDirectory, '.codex')),
    managedAgentProfile(
      'claw',
      'Claw',
      join(homeDirectory, '.codex-claw', 'codex-home'),
    ),
  ];
}

function socketAgentProfile(
  id: CodexRemoteAgentProfile['id'],
  name: string,
  codexHome: string,
): CodexRemoteAgentProfile {
  return {
    id,
    name,
    codexHome,
    transport: {
      type: 'unixSocket',
      socketPath: join(codexHome, 'app-server-control', 'app-server-control.sock'),
    },
  };
}

function managedAgentProfile(
  id: CodexRemoteAgentProfile['id'],
  name: string,
  codexHome: string,
): CodexRemoteAgentProfile {
  return {
    id,
    name,
    codexHome,
    transport: { type: 'stdio' },
  };
}
