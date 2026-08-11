import type { MenuItemConstructorOptions } from 'electron';
import type {
  CodexRemoteDesktopState,
  CodexRemoteAgentState,
} from './contracts';

export type TrayMenuActions = {
  openSimulator(): void;
  openPairing(): void;
  closePairing(): void;
  approvePairing(requestId: string): void;
  rejectPairing(requestId: string): void;
  revokeDevice(deviceId: string): void;
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
    ...(state.pairedDevices.length > 0
      ? [{
          label: `Paired Devices (${state.pairedDevices.length})`,
          submenu: state.pairedDevices.map((device) => ({
            label: device.name,
            submenu: [
              {
                label: 'Revoke Access',
                click: () => actions.revokeDevice(device.id),
              },
            ],
          })),
        }]
      : []),
    { type: 'separator' },
    {
      label: 'Agents',
      submenu: state.agents.map(agentMenu),
    },
    { type: 'separator' },
    {
      label: 'Quit Codex Remote',
      click: actions.quit,
    },
  ];
}

function agentMenu(agent: CodexRemoteAgentState): MenuItemConstructorOptions {
  return {
    label: agent.name,
    submenu: [
      {
        label: agentStatusLabel(agent),
        enabled: false,
      },
      ...(agent.accountLabel
        ? [{
            label: agent.accountLabel,
            enabled: false,
          }]
        : []),
      ...(agent.error
        ? [{
            label: agent.error,
            enabled: false,
          }]
        : []),
    ],
  };
}

function overallStatusLabel(state: CodexRemoteDesktopState): string {
  if (state.phase === 'starting') return 'Codex Remote: Starting…';
  if (state.phase === 'error') return 'Codex Remote: Error';
  const ready = state.agents.filter((agent) => agent.codexStatus === 'ready').length;
  if (ready === state.agents.length) return 'Codex Remote: Ready';
  return `Codex Remote: Ready · ${ready}/${state.agents.length} agents`;
}

function agentStatusLabel(agent: CodexRemoteAgentState): string {
  if (agent.codexStatus === 'error') return 'Codex error';
  if (agent.codexStatus === 'connecting' || agent.codexStatus === 'idle') {
    return 'Connecting…';
  }
  return 'Ready';
}
