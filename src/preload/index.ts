import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface ListArgs {
  context: string
  namespace?: string
  kind: string
}

const api = {
  listContexts: (): Promise<string[]> => ipcRenderer.invoke('k8s:contexts'),
  currentContext: (): Promise<string> => ipcRenderer.invoke('k8s:currentContext'),
  list: (args: ListArgs): Promise<unknown> => ipcRenderer.invoke('k8s:list', args),
  logs: (args: {
    context: string
    namespace: string
    pod: string
    container?: string
    previous?: boolean
  }): Promise<string> => ipcRenderer.invoke('k8s:logs', args),
  describe: (args: {
    context: string
    namespace?: string
    kind: string
    name: string
  }): Promise<string> => ipcRenderer.invoke('k8s:describe', args),

  // Pro
  proStatus: (): Promise<{
    pro: boolean
    key?: string
    email?: string
    expiresAt?: string
    error?: string
  }> => ipcRenderer.invoke('pro:status'),
  proActivate: (key: string) => ipcRenderer.invoke('pro:activate', key),
  proDeactivate: (): Promise<void> => ipcRenderer.invoke('pro:deactivate'),
  rolloutRestart: (args: { context: string; namespace: string; name: string }) =>
    ipcRenderer.invoke('pro:rolloutRestart', args),
  scale: (args: { context: string; namespace: string; name: string; replicas: number }) =>
    ipcRenderer.invoke('pro:scale', args),
  deleteResource: (args: { context: string; namespace?: string; kind: string; name: string }) =>
    ipcRenderer.invoke('pro:delete', args),
  portForwardStart: (args: {
    context: string
    namespace: string
    target: string
    localPort: number
    remotePort: number
  }): Promise<{ id: number; spec: string }> => ipcRenderer.invoke('pro:portForwardStart', args),
  portForwardStop: (id: number): Promise<boolean> => ipcRenderer.invoke('pro:portForwardStop', id),
  portForwardList: (): Promise<{ id: number; spec: string; localPort: number }[]> =>
    ipcRenderer.invoke('pro:portForwardList')
}

export type K8sApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('k8s', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.k8s = api
}
