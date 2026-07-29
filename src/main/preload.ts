import { contextBridge, ipcRenderer } from 'electron';
import type {
  CodexRemoteDesktopApi,
  CodexRemoteDesktopState,
  RealtimeRendererCommand,
} from './contracts';

const api: CodexRemoteDesktopApi = {
  getState: () => ipcRenderer.invoke('codex-remote:get-state'),
  copy: (value) => ipcRenderer.invoke('codex-remote:copy', value),
  openExternal: (url) => ipcRenderer.invoke('codex-remote:open-external', url),
  onStateChange: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: CodexRemoteDesktopState) => {
      listener(state);
    };
    ipcRenderer.on('codex-remote:state', handler);
    return () => ipcRenderer.off('codex-remote:state', handler);
  },
  sendRealtimeEvent: (event) => {
    ipcRenderer.send('codex-remote:realtime-event', event);
  },
  onRealtimeCommand: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, command: RealtimeRendererCommand) => {
      listener(command);
    };
    ipcRenderer.on('codex-remote:realtime-command', handler);
    return () => ipcRenderer.off('codex-remote:realtime-command', handler);
  },
};

contextBridge.exposeInMainWorld('codexRemote', api);
