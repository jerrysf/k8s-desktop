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
  }): Promise<string> => ipcRenderer.invoke('k8s:logs', args),
  describe: (args: {
    context: string
    namespace?: string
    kind: string
    name: string
  }): Promise<string> => ipcRenderer.invoke('k8s:describe', args)
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
