/// <reference types="vite/client" />

import type { CodexRemoteDesktopApi } from '../main/contracts';

declare global {
  interface Window {
    codexRemote: CodexRemoteDesktopApi;
  }
}

export {};
