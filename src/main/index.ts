import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  Menu,
  nativeImage,
  shell,
  Tray,
  type NativeImage,
} from 'electron';
import {
  CodexSurface,
  transcribeWithAppleSpeechAnalyzer,
} from 'codex-app-sdk/node';
import simulatorHtml from '../server/simulator.html?raw';
import { CodexRemoteServer } from '../server/remote-server';
import type { CodexRemoteDesktopState } from './contracts';
import { trayMenuTemplate } from './tray-menu';

const FALLBACK_TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAACOSURBVHgBpZLRDYAgEEOrEzgCozCCGzkCbKArOIlugJvgoRAUNcLRpvGH19TkgFQWkqIohhK8UEaKwKcsOg/+WR1vX+AlA74u6q4FqgCOSzwsGHCwbKliAF89Cv89tWmOT4VaVMoVbOBrdQUz+FrD6XItzh4LzYB1HFJ9yrEkZ4l+wvcid9pTssh4UKbPd+4vED2Nd54iAAAAAElFTkSuQmCC';

let tray: Tray | null = null;
let surface: CodexSurface | null = null;
let remoteServer: CodexRemoteServer | null = null;
let desktopState: CodexRemoteDesktopState = {
  phase: 'starting',
  codexStatus: 'idle',
  accountLabel: null,
  error: null,
  server: null,
};

function publishState(patch: Partial<CodexRemoteDesktopState>): void {
  desktopState = { ...desktopState, ...patch };
  refreshTrayMenu();
}

function createTray(): void {
  if (process.platform === 'darwin') app.dock?.hide();
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Codex Remote');
  refreshTrayMenu();
}

function createTrayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    const symbol = nativeImage.createFromNamedImage('terminal', {
      pointSize: 16,
      weight: 'semibold',
      scale: 'small',
    });
    if (!symbol.isEmpty()) {
      symbol.setTemplateImage(true);
      return symbol;
    }
  }
  return nativeImage.createFromDataURL(FALLBACK_TRAY_ICON);
}

function refreshTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate(desktopState, {
    openSimulator: () => {
      const simulatorUrl = desktopState.server?.simulatorUrl;
      if (!simulatorUrl) return;
      void shell.openExternal(safeExternalUrl(simulatorUrl).toString()).catch((error) => {
        publishState({
          phase: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    quit: () => app.quit(),
  })));
}

async function startServices(): Promise<void> {
  const defaultCwd = process.env.CODEX_REMOTE_CWD?.trim() || join(homedir(), 'src');
  const port = parsedPort(process.env.CODEX_REMOTE_PORT);
  const token = await loadOrCreateToken();

  surface = new CodexSurface({
    cwd: defaultCwd,
    autoSelectFirstConversation: false,
    clientInfo: {
      name: 'codex_remote',
      title: 'Codex Remote',
      version: app.getVersion(),
    },
    transport: {
      configOverrides: ['features.realtime_conversation=true'],
    },
  });
  surface.onStateChange((snapshot) => {
    publishState({
      codexStatus: snapshot.status,
      accountLabel: snapshot.authentication.account
        ? accountLabel(snapshot.authentication.account)
        : null,
      error: snapshot.status === 'error' ? snapshot.error : null,
    });
  });

  publishState({ codexStatus: 'connecting', error: null });
  await surface.connect();
  remoteServer = new CodexRemoteServer({
    surface,
    token,
    defaultCwd,
    simulatorHtml,
    port,
    transcribeAudio: process.platform === 'darwin'
      ? (wave) => transcribeWithAppleSpeechAnalyzer(wave)
      : undefined,
  });
  const info = await remoteServer.start();
  publishState({
    phase: 'ready',
    codexStatus: surface.getSnapshot().status,
    error: null,
    server: {
      port: info.port,
      defaultCwd: info.defaultCwd,
      localUrl: info.localUrl,
      networkUrls: info.networkUrls,
      simulatorUrl: info.simulatorUrl,
      token: info.token,
    },
  });
}

async function loadOrCreateToken(): Promise<string> {
  const configDirectory = app.getPath('userData');
  const tokenPath = join(configDirectory, 'device-token');
  try {
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First launch.
  }
  const token = randomBytes(24).toString('base64url');
  await mkdir(configDirectory, { recursive: true });
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}

function parsedPort(value: string | undefined): number {
  if (!value?.trim()) return 47_776;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('CODEX_REMOTE_PORT must be an integer between 0 and 65535');
  }
  return port;
}

function accountLabel(account: { type: string; email?: string | null }): string {
  return account.email?.trim() || account.type;
}

function safeExternalUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs can be opened');
  }
  return url;
}

app.disableHardwareAcceleration();
Menu.setApplicationMenu(null);

app.whenReady().then(async () => {
  createTray();
  try {
    await startServices();
  } catch (error) {
    publishState({
      phase: 'error',
      codexStatus: surface?.getSnapshot().status ?? 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.on('window-all-closed', () => {
  // The tray is the application UI, so closing browser windows must not stop it.
});

app.on('before-quit', () => {
  tray?.destroy();
  tray = null;
  void remoteServer?.close();
  void surface?.close();
});
