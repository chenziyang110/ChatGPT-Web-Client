import { BrowserWindow } from 'electron';
import path from 'path';

export function createWindow(){
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      contextIsolation: true
    }
  });

  win.loadURL('https://chatgpt.com');
}
