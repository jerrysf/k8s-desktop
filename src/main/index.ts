import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { spawn, ChildProcess } from 'node:child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { kubectlJson, kubectlText } from './kubectl'
import { licenseStatus, activateLicense, deactivateLicense } from './license'

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

function assertName(name: string): void {
  if (typeof name !== 'string' || !name || name.startsWith('-')) {
    throw new Error('invalid resource name')
  }
}

async function assertPro(): Promise<void> {
  const s = await licenseStatus()
  if (!s.pro) {
    throw new Error('This feature requires K8s Desktop Pro')
  }
}

// ── Port-forward process registry (Pro) ──────────────────────────
interface Forward {
  id: number
  spec: string
  localPort: number
  child: ChildProcess
}

const forwards = new Map<number, Forward>()
let nextForwardId = 1

function killAllForwards(): void {
  for (const f of forwards.values()) {
    try {
      f.child.kill('SIGTERM')
    } catch {
      // already dead
    }
  }
  forwards.clear()
}

app.on('before-quit', killAllForwards)

function registerIpc(): void {
  ipcMain.handle('k8s:contexts', async () => {
    const out = await kubectlText(['config', 'get-contexts', '-o', 'name'])
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
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
    async (
      _e,
      args: {
        context: string
        namespace: string
        pod: string
        container?: string
        previous?: boolean
      }
    ) => {
      assertContext(args.context)
      assertName(args.pod)
      assertName(args.namespace)
      const cmd = ['logs', args.pod, '-n', args.namespace, '--context', args.context, '--tail=500']
      if (args.container) {
        assertName(args.container)
        cmd.push('-c', args.container)
      } else {
        cmd.push('--all-containers=true')
      }
      if (args.previous) cmd.push('--previous')
      return kubectlText(cmd)
    }
  )

  ipcMain.handle(
    'k8s:describe',
    async (_e, args: { context: string; namespace?: string; kind: string; name: string }) => {
      assertContext(args.context)
      assertKind(args.kind)
      assertName(args.name)
      const cmd = ['describe', args.kind, args.name, '--context', args.context]
      if (args.namespace) cmd.push('-n', args.namespace)
      return kubectlText(cmd)
    }
  )

  // ── Pro: license ──────────────────────────────────────────────
  ipcMain.handle('pro:status', () => licenseStatus())
  ipcMain.handle('pro:activate', (_e, key: string) => activateLicense(key))
  ipcMain.handle('pro:deactivate', () => deactivateLicense())

  // ── Pro: write operations (explicit, confirm in UI) ──────────
  ipcMain.handle(
    'pro:rolloutRestart',
    async (_e, args: { context: string; namespace: string; name: string }) => {
      await assertPro()
      assertContext(args.context)
      assertName(args.name)
      assertName(args.namespace)
      return kubectlText([
        'rollout',
        'restart',
        `deployment/${args.name}`,
        '-n',
        args.namespace,
        '--context',
        args.context
      ])
    }
  )

  ipcMain.handle(
    'pro:scale',
    async (_e, args: { context: string; namespace: string; name: string; replicas: number }) => {
      await assertPro()
      assertContext(args.context)
      assertName(args.name)
      assertName(args.namespace)
      const n = Math.floor(Number(args.replicas))
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('invalid replica count')
      return kubectlText([
        'scale',
        `deployment/${args.name}`,
        `--replicas=${n}`,
        '-n',
        args.namespace,
        '--context',
        args.context
      ])
    }
  )

  ipcMain.handle(
    'pro:delete',
    async (_e, args: { context: string; namespace?: string; kind: string; name: string }) => {
      await assertPro()
      assertContext(args.context)
      assertKind(args.kind)
      assertName(args.name)
      const cmd = ['delete', args.kind, args.name, '--context', args.context]
      if (args.namespace) {
        assertName(args.namespace)
        cmd.push('-n', args.namespace)
      }
      return kubectlText(cmd)
    }
  )

  // ── Pro: port-forward ─────────────────────────────────────────
  ipcMain.handle(
    'pro:portForwardStart',
    async (
      _e,
      args: {
        context: string
        namespace: string
        target: string
        localPort: number
        remotePort: number
      }
    ) => {
      await assertPro()
      assertContext(args.context)
      assertName(args.namespace)
      // target like "pod/name" or "svc/name" — allow letters, digits, dash, slash.
      if (!/^[a-z0-9-]+\/[a-z0-9.-]+$/i.test(args.target)) {
        throw new Error('invalid forward target')
      }
      const lp = Math.floor(Number(args.localPort))
      const rp = Math.floor(Number(args.remotePort))
      if (!(lp > 0 && lp < 65536) || !(rp > 0 && rp < 65536)) {
        throw new Error('invalid port')
      }
      const child = spawn(
        'kubectl',
        [
          'port-forward',
          args.target,
          `${lp}:${rp}`,
          '-n',
          args.namespace,
          '--context',
          args.context
        ],
        { stdio: 'ignore' }
      )
      const id = nextForwardId++
      forwards.set(id, {
        id,
        spec: `${args.target} → localhost:${lp} (remote ${rp})`,
        localPort: lp,
        child
      })
      child.on('exit', () => forwards.delete(id))
      return { id, spec: `${args.target} → localhost:${lp}` }
    }
  )

  ipcMain.handle('pro:portForwardStop', async (_e, id: number) => {
    await assertPro()
    const f = forwards.get(Number(id))
    if (f) {
      f.child.kill('SIGTERM')
      forwards.delete(Number(id))
    }
    return true
  })

  ipcMain.handle('pro:portForwardList', async () => {
    await assertPro()
    return [...forwards.values()].map((f) => ({
      id: f.id,
      spec: f.spec,
      localPort: f.localPort
    }))
  })
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
