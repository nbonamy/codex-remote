import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { CodexRemoteDesktopState } from '../src/main/contracts';
import {
  trayMenuTemplate,
  type TrayMenuActions,
} from '../src/main/tray-menu';

describe('trayMenuTemplate', () => {
  it('shows a compact disabled menu while services connect', () => {
    const openSimulator = vi.fn();
    const quit = vi.fn();
    const menu = trayMenuTemplate(state(), actions({ openSimulator, quit }));

    expect(item(menu, 'Codex Remote: Connecting…').enabled).toBe(false);
    expect(item(menu, 'Open Device Simulator').enabled).toBe(false);
    expect(item(menu, 'Quit Codex Remote').click).toBe(quit);
  });

  it('exposes the simulator and account once the server is ready', () => {
    const openSimulator = vi.fn();
    const menu = trayMenuTemplate(state({
      phase: 'ready',
      codexStatus: 'ready',
      accountLabel: 'test@example.test',
      server: {
        port: 47_776,
        defaultCwd: '/tmp/project',
        localUrl: 'http://127.0.0.1:47776',
        networkUrls: [],
        simulatorUrl: 'http://127.0.0.1:47776/simulator?token=secret',
        token: 'secret',
      },
    }), actions({ openSimulator }));

    expect(item(menu, 'Codex Remote: Ready').enabled).toBe(false);
    expect(item(menu, 'test@example.test').enabled).toBe(false);
    const simulator = item(menu, 'Open Device Simulator');
    expect(simulator.enabled).toBe(true);
    expect(simulator.click).toBe(openSimulator);
  });

  it('surfaces startup failure without enabling the simulator', () => {
    const menu = trayMenuTemplate(state({
      phase: 'error',
      codexStatus: 'error',
      error: 'boom',
    }), actions());

    expect(item(menu, 'Codex Remote: Error').enabled).toBe(false);
    expect(item(menu, 'Open Device Simulator').enabled).toBe(false);
  });

  it('opens pairing and exposes pending approval actions', () => {
    const openPairing = vi.fn();
    const approvePairing = vi.fn();
    const rejectPairing = vi.fn();
    const menu = trayMenuTemplate(state({
      phase: 'ready',
      codexStatus: 'ready',
      pairingOpenUntil: Date.now() + 60_000,
      pendingPairings: [{
        id: 'request-1',
        deviceName: 'Codex Remote A1B2',
        code: '123456',
        expiresAt: Date.now() + 60_000,
      }],
      server: {
        port: 47_776,
        defaultCwd: '/tmp/project',
        localUrl: 'http://127.0.0.1:47776',
        networkUrls: [],
        simulatorUrl: 'http://127.0.0.1:47776/simulator?token=secret',
        token: 'secret',
      },
    }), actions({ openPairing, approvePairing, rejectPairing }));

    expect(item(menu, 'Stop Pairing').enabled).toBe(true);
    const pending = item(menu, 'Codex Remote A1B2 · 123456');
    const submenu = pending.submenu as MenuItemConstructorOptions[];
    submenu.find((entry) => entry.label === 'Approve 123456')?.click?.(
      {} as never,
      {} as never,
      {} as never,
    );
    submenu.find((entry) => entry.label === 'Reject')?.click?.(
      {} as never,
      {} as never,
      {} as never,
    );
    expect(approvePairing).toHaveBeenCalledWith('request-1');
    expect(rejectPairing).toHaveBeenCalledWith('request-1');
  });
});

function state(
  patch: Partial<CodexRemoteDesktopState> = {},
): CodexRemoteDesktopState {
  return {
    phase: 'starting',
    codexStatus: 'idle',
    accountLabel: null,
    error: null,
    pairingOpenUntil: null,
    pairedDeviceCount: 0,
    pendingPairings: [],
    server: null,
    ...patch,
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

function item(
  menu: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions {
  const result = menu.find((entry) => entry.label === label);
  if (!result) throw new Error(`Missing menu item: ${label}`);
  return result;
}
