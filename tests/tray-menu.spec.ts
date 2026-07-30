import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { CodexRemoteDesktopState } from '../src/main/contracts';
import {
  trayMenuTemplate,
  type TrayMenuActions,
} from '../src/main/tray-menu';

describe('trayMenuTemplate', () => {
  it('shows one router with two logical hosts', () => {
    const quit = vi.fn();
    const menu = trayMenuTemplate(state(), actions({ quit }));

    expect(item(menu, 'Codex Remote: Starting…').enabled).toBe(false);
    expect(item(menu, 'Open Device Simulator').enabled).toBe(false);
    const hosts = submenu(item(menu, 'Hosts'));
    expect(item(hosts, 'Codex').submenu).toBeDefined();
    expect(item(hosts, 'Codex ADE').submenu).toBeDefined();
    expect(item(menu, 'Quit Codex Remote').click).toBe(quit);
  });

  it('exposes one simulator and one pairing relationship', () => {
    const openSimulator = vi.fn();
    const openPairing = vi.fn();
    const menu = trayMenuTemplate(state({
      phase: 'ready',
      hosts: [
        host({ codexStatus: 'ready', accountLabel: 'codex@example.test' }),
        host({
          id: 'codex-ade',
          name: 'Codex ADE',
          codexHome: '/Users/tester/.codex-ade',
          codexStatus: 'ready',
          accountLabel: 'ade@example.test',
        }),
      ],
      server: server(),
    }), actions({ openSimulator, openPairing }));

    expect(item(menu, 'Codex Remote: Ready').enabled).toBe(false);
    item(menu, 'Open Device Simulator').click?.({} as never, {} as never, {} as never);
    item(menu, 'Pair New Device…').click?.({} as never, {} as never, {} as never);
    expect(openSimulator).toHaveBeenCalledOnce();
    expect(openPairing).toHaveBeenCalledOnce();

    const ade = submenu(item(submenu(item(menu, 'Hosts')), 'Codex ADE'));
    expect(item(ade, 'Ready').enabled).toBe(false);
    expect(item(ade, 'ade@example.test').enabled).toBe(false);
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

  it('keeps the router ready when one Codex host fails', () => {
    const menu = trayMenuTemplate(state({
      phase: 'ready',
      hosts: [
        host({ codexStatus: 'ready' }),
        host({
          id: 'codex-ade',
          name: 'Codex ADE',
          codexHome: '/Users/tester/.codex-ade',
          codexStatus: 'error',
          error: 'failed',
        }),
      ],
      server: server(),
    }), actions());

    expect(item(menu, 'Codex Remote: Ready · 1/2 hosts').enabled).toBe(false);
    expect(item(menu, 'Open Device Simulator').enabled).toBe(true);
    const ade = submenu(item(submenu(item(menu, 'Hosts')), 'Codex ADE'));
    expect(item(ade, 'Codex error').enabled).toBe(false);
  });
});

function state(
  patch: Partial<CodexRemoteDesktopState> = {},
): CodexRemoteDesktopState {
  return {
    phase: 'starting',
    error: null,
    hosts: [
      host(),
      host({
        id: 'codex-ade',
        name: 'Codex ADE',
        codexHome: '/Users/tester/.codex-ade',
      }),
    ],
    pairingOpenUntil: null,
    pairedDeviceCount: 0,
    pendingPairings: [],
    server: null,
    ...patch,
  };
}

function host(
  patch: Partial<CodexRemoteDesktopState['hosts'][number]> = {},
): CodexRemoteDesktopState['hosts'][number] {
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
    defaultCwd: '/tmp/project',
    localUrl: 'http://127.0.0.1:47776',
    networkUrls: [],
    simulatorUrl: 'http://127.0.0.1:47776/simulator?token=secret&hostId=codex',
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
