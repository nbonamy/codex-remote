import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  session,
  shell,
} from 'electron';
import {
  CodexSurface,
  transcribeWithAppleSpeechAnalyzer,
} from 'codex-app-sdk/node';
import simulatorHtml from '../server/simulator.html?raw';
import { CodexRemoteServer } from '../server/remote-server';
import type { CodexRemoteDesktopState } from './contracts';
import { ElectronWebRtcBridge } from './realtime-webrtc-bridge';

let mainWindow: BrowserWindow | null = null;
let surface: CodexSurface | null = null;
let remoteServer: CodexRemoteServer | null = null;
let realtimeBridge: ElectronWebRtcBridge | null = null;
let desktopState: CodexRemoteDesktopState = {
  phase: 'starting',
  codexStatus: 'idle',
  accountLabel: null,
  error: null,
  server: null,
};

function publishState(patch: Partial<CodexRemoteDesktopState>): void {
  desktopState = { ...desktopState, ...patch };
  mainWindow?.webContents.send('codex-remote:state', structuredClone(desktopState));
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    backgroundColor: '#080a0c',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(import.meta.dirname, 'preload.cjs'),
    },
  });
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(join(import.meta.dirname, '../dist-renderer/index.html'));
  }
  return window;
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
      ...(snapshot.status === 'error' ? { error: snapshot.error } : {}),
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
    realtimeBridge: realtimeBridge ?? undefined,
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

function isTrustedMicrophoneOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function configureMicrophonePermissions(): void {
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin) =>
      permission === 'media' && isTrustedMicrophoneOrigin(requestingOrigin),
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const audioOnly = 'mediaTypes' in details
        && details.mediaTypes?.every((mediaType) => mediaType === 'audio') === true;
      callback(
        permission === 'media'
        && audioOnly
        && isTrustedMicrophoneOrigin(details.requestingUrl),
      );
    },
  );
}

ipcMain.handle('codex-remote:get-state', () => structuredClone(desktopState));
ipcMain.handle('codex-remote:copy', (_event, value: unknown) => {
  if (typeof value !== 'string') throw new TypeError('Clipboard value must be a string');
  clipboard.writeText(value);
});
ipcMain.handle('codex-remote:open-external', async (_event, value: unknown) => {
  if (typeof value !== 'string') throw new TypeError('URL must be a string');
  await shell.openExternal(safeExternalUrl(value).toString());
});

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

app.whenReady().then(async () => {
  configureMicrophonePermissions();
  mainWindow = await createMainWindow();
  realtimeBridge = new ElectronWebRtcBridge(() => mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

app.on('activate', () => {
  if (!mainWindow) {
    void createMainWindow().then((window) => {
      mainWindow = window;
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  realtimeBridge?.dispose();
  void remoteServer?.close();
  void surface?.close();
});
