import { describe, expect, it } from 'vitest';
import { codexAgentProfiles } from '../src/main/agent-profiles';

describe('codexAgentProfiles', () => {
  it('exposes normal Codex and a managed Claw agent', () => {
    expect(codexAgentProfiles('/Users/tester')).toEqual([
      {
        id: 'codex',
        name: 'Codex',
        codexHome: '/Users/tester/.codex',
        transport: {
          type: 'unixSocket',
          socketPath: '/Users/tester/.codex/app-server-control/app-server-control.sock',
        },
      },
      {
        id: 'claw',
        name: 'Claw',
        codexHome: '/Users/tester/.codex-claw/codex-home',
        transport: { type: 'stdio' },
      },
    ]);
  });
});
