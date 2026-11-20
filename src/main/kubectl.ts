import { execFile } from 'node:child_process'

/**
 * Thin kubectl wrapper — shells out to the user's kubectl so that
 * exec-credential auth plugins (gke/eks/aks SSO, oidc, etc.) work
 * transparently. Read-only MVP: only `get`, `logs`, `config` verbs
 * are ever invoked.
 */

const TIMEOUT_MS = 20_000
const MAX_BUFFER = 32 * 1024 * 1024

export interface KubectlResult {
  ok: boolean
  stdout: string
  stderr: string
}

function run(args: string[]): Promise<KubectlResult> {
  return new Promise((resolve) => {
    execFile(
      'kubectl',
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? '') || String(err.message ?? err)
          })
          return
        }
        resolve({ ok: true, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

export async function kubectlJson<T>(args: string[]): Promise<T> {
  const r = await run([...args, '-o', 'json'])
  if (!r.ok) {
    throw new Error(r.stderr.trim() || 'kubectl failed')
  }
  return JSON.parse(r.stdout) as T
}

export async function kubectlText(args: string[]): Promise<string> {
  const r = await run(args)
  if (!r.ok) {
    throw new Error(r.stderr.trim() || 'kubectl failed')
  }
  return r.stdout
}
