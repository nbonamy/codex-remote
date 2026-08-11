import { join } from 'node:path';

export type CodexRemoteHostProfile = {
  id: 'codex' | 'claw';
  name: string;
  codexHome: string;
  transport:
    | { type: 'unixSocket'; socketPath: string }
    | { type: 'stdio' };
};

export function codexHostProfiles(homeDirectory: string): CodexRemoteHostProfile[] {
  return [
    socketHostProfile('codex', 'Codex', join(homeDirectory, '.codex')),
    managedHostProfile(
      'claw',
      'Claw',
      join(homeDirectory, '.codex-claw', 'codex-home'),
    ),
  ];
}

function socketHostProfile(
  id: CodexRemoteHostProfile['id'],
  name: string,
  codexHome: string,
): CodexRemoteHostProfile {
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

function managedHostProfile(
  id: CodexRemoteHostProfile['id'],
  name: string,
  codexHome: string,
): CodexRemoteHostProfile {
  return {
    id,
    name,
    codexHome,
    transport: { type: 'stdio' },
  };
}
