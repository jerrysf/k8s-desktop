import { useCallback, useEffect, useMemo, useState } from 'react'

interface ContainerStatus {
  name?: string
  ready?: boolean
  restartCount?: number
  state?: {
    waiting?: { reason?: string; message?: string }
    terminated?: { reason?: string; exitCode?: number }
    running?: unknown
  }
}

interface K8sObject {
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
  }
  status?: Record<string, unknown>
  spec?: {
    containers?: { name?: string }[]
    [key: string]: unknown
  }
}

interface K8sList {
  items: K8sObject[]
}

const KINDS = [
  { id: 'pods', label: 'Pods' },
  { id: 'deployments', label: 'Deployments' },
  { id: 'services', label: 'Services' },
  { id: 'configmaps', label: 'ConfigMaps' },
  { id: 'persistentvolumeclaims', label: 'PVCs' },
  { id: 'ingresses', label: 'Ingresses' },
  { id: 'nodes', label: 'Nodes' },
  { id: 'events', label: 'Events' }
]

const CLUSTER_SCOPED = new Set(['nodes', 'namespaces'])

function waitingReason(item: K8sObject): string | null {
  const cs = item.status?.containerStatuses as ContainerStatus[] | undefined
  for (const c of cs ?? []) {
    const r = c.state?.waiting?.reason
    if (r) return r
  }
  for (const c of cs ?? []) {
    const t = c.state?.terminated
    if (t?.reason && t.reason !== 'Completed') return t.reason
  }
  return null
}

function podStatus(item: K8sObject): string {
  const waiting = waitingReason(item)
  if (waiting) return waiting
  const phase = item.status?.phase
  if (phase && phase !== 'Running') return String(phase)
  const cs = item.status?.containerStatuses as ContainerStatus[] | undefined
  if (cs) {
    const ready = cs.filter((c) => c.ready).length
    return `${ready}/${cs.length} ${phase ?? ''}`.trim()
  }
  const ready = item.status?.readyReplicas
  const total = item.status?.replicas
  if (typeof ready === 'number' && typeof total === 'number') return `${ready}/${total}`
  const conds = item.status?.conditions as { type?: string; status?: string }[] | undefined
  const readyCond = conds?.find((c) => c.type === 'Ready')
  if (readyCond) return readyCond.status === 'True' ? 'Ready' : 'NotReady'
  return String(phase ?? '—')
}

function restartCount(item: K8sObject): number {
  const cs = item.status?.containerStatuses as ContainerStatus[] | undefined
  return (cs ?? []).reduce((n, c) => n + (c.restartCount ?? 0), 0)
}

function containerNames(item: K8sObject): string[] {
  const fromSpec = (item.spec?.containers ?? []).map((c) => c.name).filter(Boolean) as string[]
  if (fromSpec.length) return fromSpec
  const cs = item.status?.containerStatuses as ContainerStatus[] | undefined
  return (cs ?? []).map((c) => c.name).filter(Boolean) as string[]
}

function statusClass(s: string): string {
  if (/Failed|Error|CrashLoop|BackOff|OOMKill|NotReady|Unknown|ImagePull|Evicted/.test(s))
    return 'bad'
  if (/Pending|ContainerCreating|Terminating|Progressing|^0\//.test(s)) return 'warn'
  if (/Running|Ready$|Active|Bound|Running$/.test(s)) return 'ok'
  return ''
}

function age(ts?: string): string {
  if (!ts) return '—'
  const s = (Date.now() - new Date(ts).getTime()) / 1000
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function friendlyError(raw: string): string {
  // kubectl stderr is verbose — keep the actionable line(s).
  const lines = raw.split('\n').filter((l) => !/memcache|Unhandled Error|at /.test(l) && l.trim())
  return lines.slice(-4).join('\n') || raw
}

interface LicenseState {
  pro: boolean
  key?: string
  email?: string
  expiresAt?: string
}

interface Forward {
  id: number
  spec: string
  localPort: number
}

export default function App(): React.JSX.Element {
  const [contexts, setContexts] = useState<string[]>([])
  const [context, setContext] = useState('')
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [namespace, setNamespace] = useState('default')
  const [kind, setKind] = useState('pods')
  const [items, setItems] = useState<K8sObject[]>([])
  const [query, setQuery] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [selected, setSelected] = useState<K8sObject | null>(null)
  const [detail, setDetail] = useState('')
  const [detailTab, setDetailTab] = useState<'describe' | 'logs'>('describe')
  const [logContainer, setLogContainer] = useState('')
  const [logPrevious, setLogPrevious] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [license, setLicense] = useState<LicenseState>({ pro: false })
  const [showLicense, setShowLicense] = useState(false)
  const [licenseKey, setLicenseKey] = useState('')
  const [licenseErr, setLicenseErr] = useState('')
  const [forwards, setForwards] = useState<Forward[]>([])
  const [pfLocal, setPfLocal] = useState('')
  const [pfRemote, setPfRemote] = useState('')
  const [actionMsg, setActionMsg] = useState('')

  useEffect(() => {
    window.k8s
      .listContexts()
      .then(async (ctxs) => {
        setContexts(ctxs)
        const cur = await window.k8s.currentContext().catch(() => '')
        setContext(cur || ctxs[0] || '')
      })
      .catch((e) => setError(`Cannot reach kubectl: ${friendlyError(String(e))}`))
    window.k8s
      .proStatus()
      .then(setLicense)
      .catch(() => undefined)
    window.k8s
      .portForwardList()
      .then(setForwards)
      .catch(() => undefined)
  }, [])

  async function runProAction(fn: () => Promise<unknown>, ok: string): Promise<void> {
    setActionMsg('')
    try {
      const out = await fn()
      setActionMsg(typeof out === 'string' && out.trim() ? out.trim() : ok)
      loadResources()
    } catch (e) {
      setActionMsg(`Error: ${friendlyError(String(e))}`)
    }
  }

  useEffect(() => {
    if (!context) return
    window.k8s
      .list({ context, kind: 'namespaces' })
      .then((list) => setNamespaces((list as K8sList).items.map((i) => i.metadata.name)))
      .catch(() => setNamespaces([]))
  }, [context])

  const loadResources = useCallback(() => {
    if (!context) return
    setLoading(true)
    setError('')
    window.k8s
      .list({
        context,
        namespace: CLUSTER_SCOPED.has(kind) ? undefined : namespace,
        kind
      })
      .then((list) => setItems((list as K8sList).items))
      .catch((e) => setError(friendlyError(String(e))))
      .finally(() => setLoading(false))
  }, [context, namespace, kind])

  useEffect(() => {
    const t = setTimeout(loadResources, 0)
    return () => clearTimeout(t)
  }, [loadResources])

  // Auto-refresh every 15s when enabled.
  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(loadResources, 15_000)
    return () => clearInterval(t)
  }, [autoRefresh, loadResources])

  // Detail panel — kind is plural; kubectl accepts plurals natively.
  useEffect(() => {
    if (!selected || !context) return
    const name = selected.metadata.name
    const ns = selected.metadata.namespace
    if (detailTab === 'logs' && kind === 'pods') {
      window.k8s
        .logs({
          context,
          namespace: ns ?? namespace,
          pod: name,
          container: logContainer || undefined,
          previous: logPrevious
        })
        .then(setDetail)
        .catch((e) => setDetail(`Error: ${friendlyError(String(e))}`))
    } else {
      window.k8s
        .describe({ context, namespace: ns, kind, name })
        .then(setDetail)
        .catch((e) => setDetail(`Error: ${friendlyError(String(e))}`))
    }
  }, [selected, detailTab, context, kind, namespace, logContainer, logPrevious])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (i) =>
        i.metadata.name.toLowerCase().includes(q) ||
        (i.metadata.namespace ?? '').toLowerCase().includes(q) ||
        podStatus(i).toLowerCase().includes(q)
    )
  }, [items, query])

  const isPod = kind === 'pods'
  const containers = selected && isPod ? containerNames(selected) : []

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">K8s Desktop</div>
        <label className="lbl">Context</label>
        <select
          value={context}
          onChange={(e) => {
            setContext(e.target.value)
            setSelected(null)
            setDetail('')
          }}
        >
          {contexts.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="lbl">Namespace</label>
        <select
          value={namespace}
          onChange={(e) => {
            setNamespace(e.target.value)
            setSelected(null)
            setDetail('')
          }}
        >
          {namespaces.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <nav className="kinds">
          {KINDS.map((k) => (
            <button
              key={k.id}
              className={k.id === kind ? 'active' : ''}
              onClick={() => {
                setKind(k.id)
                setSelected(null)
                setDetail('')
              }}
            >
              {k.label}
            </button>
          ))}
        </nav>
        <button className="pro-btn" onClick={() => setShowLicense(true)}>
          {license.pro ? `Pro ✓ ${license.email ?? ''}` : 'Unlock Pro'}
        </button>
        <div className="sidebar-foot">
          Free: read-only browsing · Pro: actions &amp; port-forward
        </div>
      </aside>

      <main className="main">
        <header className="main-head">
          <h1>
            {KINDS.find((k) => k.id === kind)?.label}
            <span className="ns">
              {CLUSTER_SCOPED.has(kind) ? ' cluster-scoped' : ` · ${namespace}`}
            </span>
          </h1>
          <div className="head-actions">
            <input
              className="search"
              placeholder="Filter…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="auto">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
              />
              15s
            </label>
            <button className="refresh" onClick={loadResources} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                {!CLUSTER_SCOPED.has(kind) && <th>Namespace</th>}
                <th>Status</th>
                {isPod && <th>Restarts</th>}
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                const st = podStatus(it)
                const sel = selected?.metadata.name === it.metadata.name
                const restarts = restartCount(it)
                return (
                  <tr
                    key={`${it.metadata.namespace}/${it.metadata.name}`}
                    className={sel ? 'sel' : ''}
                    onClick={() => {
                      setSelected(it)
                      setDetailTab('describe')
                      setLogContainer('')
                      setLogPrevious(false)
                      setDetail('Loading…')
                    }}
                  >
                    <td className="mono">{it.metadata.name}</td>
                    {!CLUSTER_SCOPED.has(kind) && <td>{it.metadata.namespace ?? '—'}</td>}
                    <td>
                      <span className={`pill ${statusClass(st)}`}>{st}</span>
                    </td>
                    {isPod && <td className={restarts > 0 ? 'warn-text' : ''}>{restarts}</td>}
                    <td>{age(it.metadata.creationTimestamp)}</td>
                  </tr>
                )
              })}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    {query ? `No ${kind} matching "${query}".` : `No ${kind} found.`}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      {selected && (
        <section className="detail">
          <header className="detail-head">
            <div>
              <h2 className="mono">{selected.metadata.name}</h2>
              <div className="tabs">
                <button
                  className={detailTab === 'describe' ? 'active' : ''}
                  onClick={() => {
                    setDetailTab('describe')
                    setDetail('Loading…')
                  }}
                >
                  Describe
                </button>
                {isPod && (
                  <button
                    className={detailTab === 'logs' ? 'active' : ''}
                    onClick={() => {
                      setDetailTab('logs')
                      setDetail('Loading…')
                    }}
                  >
                    Logs
                  </button>
                )}
              </div>
              {detailTab === 'logs' && isPod && (
                <div className="log-opts">
                  <select value={logContainer} onChange={(e) => setLogContainer(e.target.value)}>
                    <option value="">all containers</option>
                    {containers.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label className="auto">
                    <input
                      type="checkbox"
                      checked={logPrevious}
                      onChange={(e) => setLogPrevious(e.target.checked)}
                    />
                    --previous
                  </label>
                </div>
              )}
            </div>
            <button className="close" onClick={() => setSelected(null)}>
              ×
            </button>
          </header>

          {/* Pro actions */}
          <div className="actions-bar">
            {kind === 'deployments' && (
              <>
                <button
                  disabled={!license.pro}
                  title={license.pro ? '' : 'Pro feature'}
                  onClick={() => {
                    if (confirm(`Restart deployment ${selected.metadata.name}?`)) {
                      runProAction(
                        () =>
                          window.k8s.rolloutRestart({
                            context,
                            namespace: selected.metadata.namespace ?? namespace,
                            name: selected.metadata.name
                          }),
                        'Rollout restarted'
                      )
                    }
                  }}
                >
                  Restart
                </button>
                <button
                  disabled={!license.pro}
                  title={license.pro ? '' : 'Pro feature'}
                  onClick={() => {
                    const n = prompt(
                      `Replicas for ${selected.metadata.name}?`,
                      String(selected.status?.replicas ?? 1)
                    )
                    if (n === null) return
                    runProAction(
                      () =>
                        window.k8s.scale({
                          context,
                          namespace: selected.metadata.namespace ?? namespace,
                          name: selected.metadata.name,
                          replicas: Number(n)
                        }),
                      'Scaled'
                    )
                  }}
                >
                  Scale
                </button>
              </>
            )}
            {kind === 'services' && (
              <div className="pf">
                <input
                  placeholder="local"
                  value={pfLocal}
                  onChange={(e) => setPfLocal(e.target.value.replace(/\D/g, ''))}
                />
                <span>→</span>
                <input
                  placeholder="remote"
                  value={pfRemote}
                  onChange={(e) => setPfRemote(e.target.value.replace(/\D/g, ''))}
                />
                <button
                  disabled={!license.pro || !pfLocal || !pfRemote}
                  title={license.pro ? '' : 'Pro feature'}
                  onClick={() =>
                    runProAction(
                      () =>
                        window.k8s
                          .portForwardStart({
                            context,
                            namespace: selected.metadata.namespace ?? namespace,
                            target: `svc/${selected.metadata.name}`,
                            localPort: Number(pfLocal),
                            remotePort: Number(pfRemote)
                          })
                          .then(async (r) => {
                            setForwards(await window.k8s.portForwardList())
                            return r.spec
                          }),
                      'Forward started'
                    )
                  }
                >
                  Forward
                </button>
              </div>
            )}
            <button
              className="danger"
              disabled={!license.pro}
              title={license.pro ? '' : 'Pro feature'}
              onClick={() => {
                if (confirm(`Delete ${kind} ${selected.metadata.name}? This cannot be undone.`)) {
                  runProAction(
                    () =>
                      window.k8s.deleteResource({
                        context,
                        namespace: selected.metadata.namespace,
                        kind,
                        name: selected.metadata.name
                      }),
                    'Deleted'
                  )
                }
              }}
            >
              Delete
            </button>
          </div>
          {actionMsg && <div className="action-msg">{actionMsg}</div>}

          {forwards.length > 0 && kind === 'services' && (
            <div className="forwards">
              <p className="lbl">Active port-forwards</p>
              {forwards.map((f) => (
                <div key={f.id} className="forward-row">
                  <span className="mono">{f.spec}</span>
                  <button
                    disabled={!license.pro}
                    onClick={() =>
                      window.k8s
                        .portForwardStop(f.id)
                        .then(() => window.k8s.portForwardList())
                        .then(setForwards)
                    }
                  >
                    Stop
                  </button>
                </div>
              ))}
            </div>
          )}

          <pre className="detail-body">{detail}</pre>
        </section>
      )}

      {/* License modal */}
      {showLicense && (
        <div className="modal-bg" onClick={() => setShowLicense(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>K8s Desktop Pro</h2>
            {license.pro ? (
              <>
                <p className="muted">
                  Active{license.email ? ` · ${license.email}` : ''}
                  {license.expiresAt ? ` · expires ${license.expiresAt}` : ''}
                </p>
                <button
                  className="danger"
                  onClick={async () => {
                    await window.k8s.proDeactivate()
                    setLicense({ pro: false })
                  }}
                >
                  Deactivate license
                </button>
              </>
            ) : (
              <>
                <p className="muted">
                  Paste your license key to unlock actions and port-forward. Get a key from the
                  DevOps Toolkit store.
                </p>
                <input
                  className="license-input"
                  placeholder="XXXX-XXXX-XXXX-XXXX"
                  value={licenseKey}
                  onChange={(e) => setLicenseKey(e.target.value)}
                />
                {licenseErr && <p className="error-text">{licenseErr}</p>}
                <div className="modal-actions">
                  <button
                    className="refresh"
                    onClick={async () => {
                      setLicenseErr('')
                      const s = await window.k8s.proActivate(licenseKey)
                      if (s.pro) {
                        setLicense(s)
                        setShowLicense(false)
                      } else {
                        setLicenseErr(s.error ?? 'Invalid key')
                      }
                    }}
                  >
                    Activate
                  </button>
                  <button onClick={() => setShowLicense(false)}>Cancel</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
