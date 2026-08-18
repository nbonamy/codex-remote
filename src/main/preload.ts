import { contextBridge, ipcRenderer } from 'electron';
import type {
  CodexRemoteDesktopApi,
  CodexRemoteDesktopState,
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
};

contextBridge.exposeInMainWorld('codexRemote', api);
