import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Pro license gate — Lemon Squeezy license API.
 *
 * Validation requires network once; the result is cached in
 * userData/license.json so the app keeps working offline.
 * Dev override: K8S_DESKTOP_PRO=1 in the environment.
 *
 * Note: this source is public — the check is honest, not airtight.
 * What you actually sell is the signed build + updates, like every
 * open-core desktop app.
 */

const VALIDATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/validate'
const DEACTIVATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/deactivate'

export interface LicenseState {
  pro: boolean
  key?: string
  email?: string
  expiresAt?: string
  error?: string
}

interface StoredLicense {
  key: string
  email?: string
  expiresAt?: string
  validatedAt: string
}

function licenseFile(): string {
  return join(app.getPath('userData'), 'license.json')
}

async function readStored(): Promise<StoredLicense | null> {
  try {
    return JSON.parse(await readFile(licenseFile(), 'utf8'))
  } catch {
    return null
  }
}

async function storeLicense(l: StoredLicense): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(licenseFile(), JSON.stringify(l, null, 2))
}

export async function licenseStatus(): Promise<LicenseState> {
  if (process.env.K8S_DESKTOP_PRO === '1' || process.env.K8S_DESKTOP_PRO === 'true') {
    return { pro: true, email: 'dev-override' }
  }
  const stored = await readStored()
  if (!stored) return { pro: false }
  return {
    pro: true,
    email: stored.email,
    expiresAt: stored.expiresAt,
    key: `${stored.key.slice(0, 8)}…`
  }
}

interface ValidateResponse {
  valid: boolean
  error?: string
  license_key?: { status: string; expires_at?: string }
  meta?: { customer_email?: string }
}

export async function activateLicense(key: string): Promise<LicenseState> {
  const trimmed = key.trim()
  if (!trimmed || trimmed.startsWith('-')) return { pro: false, error: 'Invalid key' }
  try {
    const res = await fetch(VALIDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        license_key: trimmed,
        instance_name: `k8s-desktop-${app.getVersion()}`
      })
    })
    const data = (await res.json()) as ValidateResponse
    if (!data.valid) {
      return { pro: false, error: data.error ?? 'License key not valid' }
    }
    const email = data.meta?.customer_email
    const expiresAt = data.license_key?.expires_at
    await storeLicense({
      key: trimmed,
      email,
      expiresAt,
      validatedAt: new Date().toISOString()
    })
    return { pro: true, email, expiresAt, key: `${trimmed.slice(0, 8)}…` }
  } catch (e) {
    // Offline: honor a previously stored license, else fail closed.
    const stored = await readStored()
    if (stored?.key === trimmed) {
      return { pro: true, email: stored.email, expiresAt: stored.expiresAt }
    }
    return { pro: false, error: `Validation failed: ${String(e)}` }
  }
}

export async function deactivateLicense(): Promise<void> {
  const stored = await readStored()
  if (stored) {
    try {
      await fetch(DEACTIVATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ license_key: stored.key })
      })
    } catch {
      // Best effort — local state clears regardless.
    }
  }
  await writeFile(licenseFile(), '{}')
}
