import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceBridge, WorkspaceShortcut } from '../shared/types';
const bridge: WorkspaceBridge = {
  platform: process.platform,
  call: (method, params = {}) => ipcRenderer.invoke('workspace:call', method, params),
  onShortcut: listener => {
    const handler = (_event: Electron.IpcRendererEvent, shortcut: WorkspaceShortcut) => listener(shortcut);
    ipcRenderer.on('workspace:shortcut', handler);
    return () => ipcRenderer.removeListener('workspace:shortcut', handler);
  },
  onChange: listener => {
    const handler = () => listener();
    ipcRenderer.on('workspace:changed', handler);
    return () => ipcRenderer.removeListener('workspace:changed', handler);
  }
};
contextBridge.exposeInMainWorld('workspace', bridge);
