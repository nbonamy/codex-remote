import { describe, expect, it } from 'vitest';
import { codexHostProfiles } from '../src/main/host-profiles';

describe('codexHostProfiles', () => {
  it('exposes normal Codex as the active logical host', () => {
    expect(codexHostProfiles('/Users/tester')).toEqual([
      {
        id: 'codex',
        name: 'Codex',
        codexHome: '/Users/tester/.codex',
        appServerSocketPath: '/Users/tester/.codex/app-server-control/app-server-control.sock',
      },
      // Codex ADE support is intentionally disabled for now.
      // {
      //   id: 'codex-ade',
      //   name: 'Codex ADE',
      //   codexHome: '/Users/tester/.codex-ade',
      //   appServerSocketPath: '/Users/tester/.codex-ade/app-server-control/app-server-control.sock',
      // },
    ]);
  });
});
