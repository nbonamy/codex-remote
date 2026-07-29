import type { MenuItemConstructorOptions } from 'electron';
import type { CodexRemoteDesktopState } from './contracts';

export type TrayMenuActions = {
  openSimulator(): void;
  openPairing(): void;
  closePairing(): void;
  approvePairing(requestId: string): void;
  rejectPairing(requestId: string): void;
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
    {
      label: state.pairingOpenUntil && state.pairingOpenUntil > Date.now()
        ? 'Stop Pairing'
        : 'Pair New Device…',
      enabled: simulatorReady,
      click: state.pairingOpenUntil && state.pairingOpenUntil > Date.now()
        ? actions.closePairing
        : actions.openPairing,
    },
    ...(state.pendingPairings.map((request) => ({
      label: `${request.deviceName} · ${request.code}`,
      submenu: [
        {
          label: `Approve ${request.code}`,
          click: () => actions.approvePairing(request.id),
        },
        {
          label: 'Reject',
          click: () => actions.rejectPairing(request.id),
        },
      ],
    }))),
    ...(state.pairedDeviceCount > 0
      ? [{
          label: `${state.pairedDeviceCount} paired device${
            state.pairedDeviceCount === 1 ? '' : 's'
          }`,
          enabled: false,
        }]
      : []),
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
