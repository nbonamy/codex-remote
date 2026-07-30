import { join } from 'node:path';

export type CodexRemoteHostProfile = {
  id: 'codex' | 'codex-ade';
  name: string;
  codexHome: string;
  appServerSocketPath: string;
};

export function codexHostProfiles(homeDirectory: string): CodexRemoteHostProfile[] {
  return [
    hostProfile('codex', 'Codex', join(homeDirectory, '.codex')),
    // Codex ADE support is intentionally disabled for now. Keep this registration
    // in place so it can be restored without rebuilding the multi-host plumbing.
    // hostProfile('codex-ade', 'Codex ADE', join(homeDirectory, '.codex-ade')),
  ];
}

function hostProfile(
  id: CodexRemoteHostProfile['id'],
  name: string,
  codexHome: string,
): CodexRemoteHostProfile {
  return {
    id,
    name,
    codexHome,
    appServerSocketPath: join(codexHome, 'app-server-control', 'app-server-control.sock'),
  };
}
