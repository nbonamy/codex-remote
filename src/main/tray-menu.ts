import type { MenuItemConstructorOptions } from 'electron';
import type {
  CodexRemoteDesktopState,
  CodexRemoteHostState,
} from './contracts';

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
  const serverReady = state.phase === 'ready' && state.server !== null;
  const pairingOpen = Boolean(
    state.pairingOpenUntil && state.pairingOpenUntil > Date.now(),
  );
  return [
    {
      label: overallStatusLabel(state),
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open Device Simulator',
      enabled: serverReady,
      click: actions.openSimulator,
    },
    {
      label: pairingOpen ? 'Stop Pairing' : 'Pair New Device…',
      enabled: serverReady,
      click: pairingOpen ? actions.closePairing : actions.openPairing,
    },
    ...state.pendingPairings.map((request) => ({
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
    })),
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
      label: 'Hosts',
      submenu: state.hosts.map(hostMenu),
    },
    { type: 'separator' },
    {
      label: 'Quit Codex Remote',
      click: actions.quit,
    },
  ];
}

function hostMenu(host: CodexRemoteHostState): MenuItemConstructorOptions {
  return {
    label: host.name,
    submenu: [
      {
        label: hostStatusLabel(host),
        enabled: false,
      },
      ...(host.accountLabel
        ? [{
            label: host.accountLabel,
            enabled: false,
          }]
        : []),
      ...(host.error
        ? [{
            label: host.error,
            enabled: false,
          }]
        : []),
    ],
  };
}

function overallStatusLabel(state: CodexRemoteDesktopState): string {
  if (state.phase === 'starting') return 'Codex Remote: Starting…';
  if (state.phase === 'error') return 'Codex Remote: Error';
  const ready = state.hosts.filter((host) => host.codexStatus === 'ready').length;
  if (ready === state.hosts.length) return 'Codex Remote: Ready';
  return `Codex Remote: Ready · ${ready}/${state.hosts.length} hosts`;
}

function hostStatusLabel(host: CodexRemoteHostState): string {
  if (host.codexStatus === 'error') return 'Codex error';
  if (host.codexStatus === 'connecting' || host.codexStatus === 'idle') {
    return 'Connecting…';
  }
  return 'Ready';
}
