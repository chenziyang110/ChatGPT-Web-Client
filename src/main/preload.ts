import { contextBridge, ipcRenderer } from 'electron';
import type { WorkspaceBridge } from '../shared/types';
const bridge: WorkspaceBridge = {
  call: (method, params = {}) => ipcRenderer.invoke('workspace:call', method, params),
  onChange: listener => {
    const handler = () => listener();
    ipcRenderer.on('workspace:changed', handler);
    return () => ipcRenderer.removeListener('workspace:changed', handler);
  }
};
contextBridge.exposeInMainWorld('workspace', bridge);
