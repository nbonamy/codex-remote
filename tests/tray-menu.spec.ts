import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { CodexRemoteDesktopState } from '../src/main/contracts';
import {
  trayMenuTemplate,
  type TrayMenuActions,
} from '../src/main/tray-menu';

describe('trayMenuTemplate', () => {
  it('shows one host with two agents', () => {
    const quit = vi.fn();
    const menu = trayMenuTemplate(state(), actions({ quit }));

    expect(item(menu, 'Codex Remote: Starting…').enabled).toBe(false);
    expect(item(menu, 'Open Device Simulator').enabled).toBe(false);
    const agents = submenu(item(menu, 'Agents'));
    expect(item(agents, 'Codex').submenu).toBeDefined();
    expect(item(agents, 'Claw').submenu).toBeDefined();
    expect(item(menu, 'Quit Codex Remote').click).toBe(quit);
  });

  it('exposes one simulator and one pairing relationship', () => {
    const openSimulator = vi.fn();
    const openPairing = vi.fn();
    const menu = trayMenuTemplate(state({
      phase: 'ready',
      agents: [
        agent({ codexStatus: 'ready', accountLabel: 'codex@example.test' }),
        agent({
          id: 'claw',
          name: 'Claw',
          codexHome: '/Users/tester/.codex-claw/codex-home',
          codexStatus: 'ready',
          accountLabel: 'claw@example.test',
        }),
      ],
      server: server(),
    }), actions({ openSimulator, openPairing }));

    expect(item(menu, 'Codex Remote: Ready').enabled).toBe(false);
    item(menu, 'Open Device Simulator').click?.({} as never, {} as never, {} as never);
    item(menu, 'Pair New Device…').click?.({} as never, {} as never, {} as never);
    expect(openSimulator).toHaveBeenCalledOnce();
    expect(openPairing).toHaveBeenCalledOnce();

    const claw = submenu(item(submenu(item(menu, 'Agents')), 'Claw'));
    expect(item(claw, 'Ready').enabled).toBe(false);
    expect(item(claw, 'claw@example.test').enabled).toBe(false);
  });

  it('routes a pairing approval through the unique router', () => {
    const approvePairing = vi.fn();
    const menu = trayMenuTemplate(state({
      phase: 'ready',
      pairingOpenUntil: Date.now() + 60_000,
      pendingPairings: [{
        id: 'request-1',
        deviceName: 'Pocket Remote A1B2',
        code: '123456',
        expiresAt: Date.now() + 60_000,
      }],
      server: server(),
    }), actions({ approvePairing }));

    const requestMenu = submenu(item(menu, 'Pocket Remote A1B2 · 123456'));
    item(requestMenu, 'Approve 123456').click?.({} as never, {} as never, {} as never);
    expect(approvePairing).toHaveBeenCalledWith('request-1');
  });

  it('revokes a paired device from its submenu', () => {
    const revokeDevice = vi.fn();
    const menu = trayMenuTemplate(state({
      pairedDeviceCount: 1,
      pairedDevices: [{
        id: 'esp32-a1b2',
        name: 'Pocket Remote A1B2',
        pairedAt: '2026-08-10T12:00:00.000Z',
        lastSeenAt: null,
      }],
    }), actions({ revokeDevice }));

    const devices = submenu(item(menu, 'Paired Devices (1)'));
    const device = submenu(item(devices, 'Pocket Remote A1B2'));
    item(device, 'Revoke Access').click?.({} as never, {} as never, {} as never);
    expect(revokeDevice).toHaveBeenCalledWith('esp32-a1b2');
  });

  it('keeps the host ready when one Codex agent fails', () => {
    const menu = trayMenuTemplate(state({
      phase: 'ready',
      agents: [
        agent({ codexStatus: 'ready' }),
        agent({
          id: 'claw',
          name: 'Claw',
          codexHome: '/Users/tester/.codex-claw/codex-home',
          codexStatus: 'error',
          error: 'failed',
        }),
      ],
      server: server(),
    }), actions());

    expect(item(menu, 'Codex Remote: Ready · 1/2 agents').enabled).toBe(false);
    expect(item(menu, 'Open Device Simulator').enabled).toBe(true);
    const claw = submenu(item(submenu(item(menu, 'Agents')), 'Claw'));
    expect(item(claw, 'Codex error').enabled).toBe(false);
  });
});

function state(
  patch: Partial<CodexRemoteDesktopState> = {},
): CodexRemoteDesktopState {
  return {
    phase: 'starting',
    error: null,
    agents: [
      agent(),
      agent({
        id: 'claw',
        name: 'Claw',
        codexHome: '/Users/tester/.codex-claw/codex-home',
      }),
    ],
    pairingOpenUntil: null,
    pairedDeviceCount: 0,
    pairedDevices: [],
    pendingPairings: [],
    server: null,
    ...patch,
  };
}

function agent(
  patch: Partial<CodexRemoteDesktopState['agents'][number]> = {},
): CodexRemoteDesktopState['agents'][number] {
  return {
    id: 'codex',
    name: 'Codex',
    codexHome: '/Users/tester/.codex',
    codexStatus: 'idle',
    accountLabel: null,
    error: null,
    ...patch,
  };
}

function server(): NonNullable<CodexRemoteDesktopState['server']> {
  return {
    port: 47_776,
    localUrl: 'http://127.0.0.1:47776',
    networkUrls: [],
    simulatorUrl: 'http://127.0.0.1:47776/simulator?token=secret&agentId=codex',
    token: 'secret',
  };
}

function actions(
  patch: Partial<TrayMenuActions> = {},
): TrayMenuActions {
  return {
    openSimulator: vi.fn(),
    openPairing: vi.fn(),
    closePairing: vi.fn(),
    approvePairing: vi.fn(),
    rejectPairing: vi.fn(),
    revokeDevice: vi.fn(),
    quit: vi.fn(),
    ...patch,
  };
}

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[];
}

function item(
  menu: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions {
  const result = menu.find((entry) => entry.label === label);
  if (!result) throw new Error(`Missing menu item: ${label}`);
  return result;
}
