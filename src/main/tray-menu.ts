import type { MenuItemConstructorOptions } from 'electron';
import type { CodexRemoteDesktopState } from './contracts';

export type TrayMenuActions = {
  openSimulator(): void;
  quit(): void;
};

export function trayMenuTemplate(
  state: CodexRemoteDesktopState,
  actions: TrayMenuActions,
): MenuItemConstructorOptions[] {
  const simulatorReady = state.phase === 'ready' && state.server !== null;
  return [
    {
      label: statusLabel(state),
      enabled: false,
    },
    ...(state.accountLabel
      ? [{
          label: state.accountLabel,
          enabled: false,
        }]
      : []),
    { type: 'separator' },
    {
      label: 'Open Device Simulator',
      enabled: simulatorReady,
      click: actions.openSimulator,
    },
    { type: 'separator' },
    {
      label: 'Quit Codex Remote',
      click: actions.quit,
    },
  ];
}

function statusLabel(state: CodexRemoteDesktopState): string {
  if (state.phase === 'error') return 'Codex Remote: Error';
  if (state.phase === 'starting' || state.codexStatus === 'connecting') {
    return 'Codex Remote: Connecting…';
  }
  if (state.codexStatus === 'error') return 'Codex Remote: Codex error';
  return 'Codex Remote: Ready';
}
