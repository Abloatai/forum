import {contextBridge, ipcRenderer} from 'electron';
import type {Draft, Request} from '../document/index.js';
// Explicit capability surface, adapted from Coding's isolated preload.
contextBridge.exposeInMainWorld('lobbyDocs', {
  authState:()=>ipcRenderer.invoke('docs:auth-state'),
  signIn:()=>ipcRenderer.invoke('docs:sign-in'),
  signOut:()=>ipcRenderer.invoke('docs:sign-out'),
  list: () => ipcRenderer.invoke('docs:list'),
  create: (title: string) => ipcRenderer.invoke('docs:create', title),
  open: (id: string) => ipcRenderer.invoke('docs:open', id),
  request: (input: Request) => ipcRenderer.invoke('docs:request', input),
  saveDraft: (draft: Draft) => ipcRenderer.sendSync('docs:save-draft', draft),
  offline: (value: boolean) => ipcRenderer.invoke('docs:offline', value),
  newWindow: () => ipcRenderer.invoke('docs:new-window'),
});
