import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { CodexRemoteDesktopState } from '../src/main/contracts';
import { trayMenuTemplate } from '../src/main/tray-menu';

describe('trayMenuTemplate', () => {
  it('shows a compact disabled menu while services connect', () => {
    const openSimulator = vi.fn();
    const quit = vi.fn();
    const menu = trayMenuTemplate(state(), { openSimulator, quit });

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
    }), { openSimulator, quit: vi.fn() });

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
    }), { openSimulator: vi.fn(), quit: vi.fn() });

    expect(item(menu, 'Codex Remote: Error').enabled).toBe(false);
    expect(item(menu, 'Open Device Simulator').enabled).toBe(false);
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
    server: null,
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
