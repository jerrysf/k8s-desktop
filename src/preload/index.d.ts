import { ElectronAPI } from '@electron-toolkit/preload'
import type { K8sApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    k8s: K8sApi
  }
}
