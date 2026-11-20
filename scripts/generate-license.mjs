#!/usr/bin/env node
/**
 * Generate a signed K8s Desktop Pro license key.
 *
 * Usage:
 *   node scripts/generate-license.mjs <email> [expiry]
 *
 *   node scripts/generate-license.mjs user@example.com
 *   node scripts/generate-license.mjs user@example.com 2027-01-01
 *
 * Requires license-private.pem in the repo root (gitignored — never
 * commit it). If the file doesn't exist, a fresh keypair is generated
 * and the new public key is printed so it can be embedded in
 * src/main/license.ts (PUBLIC_KEY_B64).
 */

import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRIV_PATH = join(root, 'license-private.pem')

const email = process.argv[2]
const expiry = process.argv[3] // optional ISO date, e.g. 2027-01-01

if (!existsSync(PRIV_PATH)) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  writeFileSync(PRIV_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }))
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  console.error('Generated new keypair at license-private.pem')
  console.error(`Embed this public key in src/main/license.ts (PUBLIC_KEY_B64):\n${pubB64}\n`)
}

if (!email) {
  console.error('usage: node scripts/generate-license.mjs <email> [expiry ISO date]')
  process.exit(1)
}

const payload = { email, iat: new Date().toISOString() }
if (expiry) {
  if (Number.isNaN(Date.parse(expiry))) {
    console.error(`invalid expiry date: ${expiry}`)
    process.exit(1)
  }
  payload.exp = new Date(expiry).toISOString()
}

const priv = createPrivateKey(readFileSync(PRIV_PATH))
const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
const sigB64 = sign(null, Buffer.from(payloadB64), priv).toString('base64url')

console.log(`K8SD-${payloadB64}.${sigB64}`)
