import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { kubectlJson, kubectlText } from './kubectl'

interface ListArgs {
  context: string
  namespace?: string
  kind: string
}

// Allowlisted resource kinds — read-only MVP surface.
const ALLOWED_KINDS = new Set([
  'pods',
  'deployments',
  'services',
  'nodes',
  'events',
  'namespaces',
  'configmaps',
  'secrets',
  'persistentvolumeclaims',
  'ingresses'
])

function assertKind(kind: string): void {
  if (!ALLOWED_KINDS.has(kind)) {
    throw new Error(`resource kind not allowed: ${kind}`)
  }
}

function assertContext(context: string): void {
  // Contexts come from `kubectl config get-contexts`; block flag injection.
  if (typeof context !== 'string' || !context || context.startsWith('-')) {
    throw new Error('invalid context')
  }
}

function registerIpc(): void {
  ipcMain.handle('k8s:contexts', async () => {
    const out = await kubectlText(['config', 'get-contexts', '-o', 'name'])
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  })

  ipcMain.handle('k8s:currentContext', async () => {
    const out = await kubectlText(['config', 'current-context'])
    return out.trim()
  })

  ipcMain.handle('k8s:list', async (_e, args: ListArgs) => {
    assertContext(args.context)
    assertKind(args.kind)
    const cmd = ['get', args.kind, '--context', args.context]
    if (args.kind !== 'nodes' && args.kind !== 'namespaces') {
      cmd.push(args.namespace ? '-n' : '-A')
      if (args.namespace) cmd.push(args.namespace)
    }
    return kubectlJson(cmd)
  })

  ipcMain.handle(
    'k8s:logs',
    async (_e, args: { context: string; namespace: string; pod: string; container?: string }) => {
      assertContext(args.context)
      const cmd = [
        'logs',
        args.pod,
        '-n',
        args.namespace,
        '--context',
        args.context,
        '--tail=500',
        '--all-containers=true'
      ]
      if (args.container) cmd.push('-c', args.container)
      return kubectlText(cmd)
    }
  )

  ipcMain.handle(
    'k8s:describe',
    async (_e, args: { context: string; namespace?: string; kind: string; name: string }) => {
      assertContext(args.context)
      assertKind(args.kind)
      const cmd = ['describe', args.kind, args.name, '--context', args.context]
      if (args.namespace) cmd.push('-n', args.namespace)
      return kubectlText(cmd)
    }
  )
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'K8s Desktop',
    backgroundColor: '#0a1224',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.devopstoolkit.k8s-desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpc()
  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
