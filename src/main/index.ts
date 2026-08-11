import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
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
  CodexAppServerStdioTransport,
  CodexAppServerUnixSocketTransport,
  CodexSurface,
  transcribeWithAppleSpeechAnalyzer,
} from 'codex-app-sdk/node';
import { CodexAppServerClient } from 'codex-app-sdk/codex';
import simulatorHtml from '../server/simulator.html?raw';
import { readDeviceRecentMessages } from '../server/device-history';
import { PairingStore } from '../server/pairing-store';
import {
  CodexRemoteServer,
  type RemoteCodexAgent,
} from '../server/remote-server';
import {
  codexAgentProfiles,
  type CodexRemoteAgentProfile,
} from './agent-profiles';
import type {
  CodexRemoteDesktopState,
  CodexRemoteAgentState,
} from './contracts';
import { synthesizeWithAppleSpeech } from './apple-speech';
import { trayMenuTemplate } from './tray-menu';

const FALLBACK_TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAACOSURBVHgBpZLRDYAgEEOrEzgCozCCGzkCbKArOIlugJvgoRAUNcLRpvGH19TkgFQWkqIohhK8UEaKwKcsOg/+WR1vX+AlA74u6q4FqgCOSzwsGHCwbKliAF89Cv89tWmOT4VaVMoVbOBrdQUz+FrD6XItzh4LzYB1HFJ9yrEkZ4l+wvcid9pTssh4UKbPd+4vED2Nd54iAAAAAElFTkSuQmCC';

type AgentRuntime = {
  profile: CodexRemoteAgentProfile;
  client: CodexAppServerClient;
  surface: CodexSurface;
};

let tray: Tray | null = null;
let agentRuntimes: AgentRuntime[] = [];
let server: CodexRemoteServer | null = null;
let pairing: PairingStore | null = null;
let pairingTimer: NodeJS.Timeout | null = null;
let desktopState: CodexRemoteDesktopState = {
  phase: 'starting',
  error: null,
  agents: [],
  pairingOpenUntil: null,
  pairedDeviceCount: 0,
  pairedDevices: [],
  pendingPairings: [],
  server: null,
};

function publishState(patch: Partial<CodexRemoteDesktopState>): void {
  desktopState = { ...desktopState, ...patch };
  refreshTrayMenu();
}

function publishAgentState(
  agentId: string,
  patch: Partial<CodexRemoteAgentState>,
): void {
  publishState({
    agents: desktopState.agents.map((agent) => (
      agent.id === agentId ? { ...agent, ...patch } : agent
    )),
  });
}

function createTray(): void {
  if (process.platform === 'darwin') app.dock?.hide();
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Codex Remote');
  refreshTrayMenu();
}

function createTrayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    const trayIconPath = app.isPackaged
      ? join(process.resourcesPath, 'trayTemplate.png')
      : join(app.getAppPath(), 'build', 'trayTemplate.png');
    const icon = nativeImage.createFromPath(trayIconPath);
    if (!icon.isEmpty()) {
      icon.setTemplateImage(true);
      return icon;
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
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    openPairing: () => {
      const expiresAt = pairing?.openPairingWindow();
      if (expiresAt) schedulePairingRefresh(expiresAt);
    },
    closePairing: () => pairing?.closePairingWindow(),
    approvePairing: (requestId) => {
      void pairing?.approve(requestId).catch((error) => {
        publishState({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    rejectPairing: (requestId) => pairing?.reject(requestId),
    revokeDevice: (deviceId) => {
      void pairing?.revoke(deviceId).then((device) => {
        if (device) server?.disconnectAuthorizationToken(device.token);
      }).catch((error) => {
        publishState({
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    quit: () => app.quit(),
  })));
}

async function startServices(): Promise<void> {
  const defaultCwd = process.env.CODEX_REMOTE_CWD?.trim() || join(homedir(), 'src');
  const profiles = codexAgentProfiles(homedir());
  desktopState = {
    ...desktopState,
    agents: profiles.map(initialAgentState),
  };
  refreshTrayMenu();

  const token = await loadOrCreateToken();
  pairing = await PairingStore.open(
    join(app.getPath('userData'), 'device-pairings.json'),
    `Codex Remote on ${hostname()}`,
  );
  pairing.onChange(refreshPairingState);
  refreshPairingState();

  agentRuntimes = profiles.map((profile) => {
    const transport = profile.transport.type === 'unixSocket'
      ? new CodexAppServerUnixSocketTransport(profile.transport)
      : new CodexAppServerStdioTransport({
        codexHome: profile.codexHome,
        cwd: defaultCwd,
      });
    const client = new CodexAppServerClient(
      transport,
    );
    const surface = new CodexSurface({
      client,
      codexHome: profile.codexHome,
      cwd: defaultCwd,
      autoSelectFirstConversation: false,
      loadingStrategy: 'lazy',
      clientInfo: {
        name: profile.id === 'codex' ? 'codex_remote' : `codex_remote_${profile.id}`,
        title: `Codex Remote · ${profile.name}`,
        version: app.getVersion(),
      },
    });
    surface.onStateChange((snapshot) => {
      publishAgentState(profile.id, {
        codexStatus: snapshot.status,
        accountLabel: snapshot.authentication.account
          ? accountLabel(snapshot.authentication.account)
          : null,
        error: snapshot.status === 'error' ? snapshot.error : null,
      });
    });
    return { profile, client, surface };
  });

  await Promise.all(agentRuntimes.map(async ({ profile, surface }) => {
    publishAgentState(profile.id, { codexStatus: 'connecting', error: null });
    try {
      await surface.connect();
    } catch (error) {
      publishAgentState(profile.id, {
        codexStatus: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  const remoteAgents: RemoteCodexAgent[] = agentRuntimes.map(({ profile, client, surface }) => ({
    id: profile.id,
    name: profile.name,
    surface,
    realtimeVoiceAvailable: () => (
      surface.getSnapshot().authentication.account?.type === 'apiKey'
      || Boolean(process.env.OPENAI_API_KEY?.trim())
    ),
    readRecentMessages: (threadId) => readDeviceRecentMessages(client, threadId),
  }));
  server = new CodexRemoteServer({
    agents: remoteAgents,
    token,
    defaultCwd,
    simulatorHtml,
    port: parsedPort(process.env.CODEX_REMOTE_PORT),
    pairing,
    transcribeAudio: process.platform === 'darwin'
      ? (wave) => transcribeWithAppleSpeechAnalyzer(wave)
      : undefined,
    synthesizeSpeech: process.platform === 'darwin'
      ? synthesizeWithAppleSpeech
      : undefined,
  });
  const info = await server.start();
  publishState({
    phase: 'ready',
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

function initialAgentState(profile: CodexRemoteAgentProfile): CodexRemoteAgentState {
  return {
    id: profile.id,
    name: profile.name,
    codexHome: profile.codexHome,
    codexStatus: 'idle',
    accountLabel: null,
    error: null,
  };
}

function refreshPairingState(): void {
  if (!pairing) return;
  const pairedDevices = pairing.pairedDevices();
  publishState({
    pairingOpenUntil: pairing.pairingExpiresAt(),
    pairedDeviceCount: pairedDevices.length,
    pairedDevices: pairedDevices.map((device) => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
    })),
    pendingPairings: pairing.pendingRequests().map((request) => ({
      id: request.id,
      deviceName: request.deviceName,
      code: request.code,
      expiresAt: request.expiresAt,
    })),
  });
}

function schedulePairingRefresh(expiresAt: number): void {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = setTimeout(() => {
    pairingTimer = null;
    refreshPairingState();
  }, Math.max(0, expiresAt - Date.now()) + 25);
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
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.on('window-all-closed', () => {
  // The tray is the application UI, so closing browser windows must not stop it.
});

app.on('before-quit', () => {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = null;
  void server?.close();
  server = null;
  for (const runtime of agentRuntimes) void runtime.surface.close();
  agentRuntimes = [];
  tray?.destroy();
  tray = null;
});
