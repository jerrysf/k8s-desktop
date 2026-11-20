import { useCallback, useEffect, useMemo, useState } from 'react'

interface K8sObject {
  metadata: {
    name: string
    namespace?: string
    creationTimestamp?: string
    labels?: Record<string, string>
  }
  status?: Record<string, unknown>
  spec?: Record<string, unknown>
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

function podStatus(item: K8sObject): string {
  if (item.status?.phase) return String(item.status.phase)
  const cs = item.status?.containerStatuses as { ready?: boolean }[] | undefined
  if (cs) {
    const ready = cs.filter((c) => c.ready).length
    return `${ready}/${cs.length}`
  }
  const ready = item.status?.readyReplicas
  const total = item.status?.replicas
  if (typeof ready === 'number' && typeof total === 'number') return `${ready}/${total}`
  const conds = item.status?.conditions as { type?: string; status?: string }[] | undefined
  const readyCond = conds?.find((c) => c.type === 'Ready')
  if (readyCond) return readyCond.status === 'True' ? 'Ready' : 'NotReady'
  return '—'
}

function statusClass(s: string): string {
  if (/Running|Ready|Active|Bound|^(\d+)\/\1$/.test(s)) return 'ok'
  if (/Pending|ContainerCreating|Progressing/.test(s)) return 'warn'
  if (/Failed|Error|CrashLoop|BackOff|NotReady|Unknown/.test(s)) return 'bad'
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

export default function App(): React.JSX.Element {
  const [contexts, setContexts] = useState<string[]>([])
  const [context, setContext] = useState('')
  const [namespaces, setNamespaces] = useState<string[]>([])
  const [namespace, setNamespace] = useState('default')
  const [kind, setKind] = useState('pods')
  const [items, setItems] = useState<K8sObject[]>([])
  const [selected, setSelected] = useState<K8sObject | null>(null)
  const [detail, setDetail] = useState('')
  const [detailTab, setDetailTab] = useState<'describe' | 'logs'>('describe')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Load contexts once.
  useEffect(() => {
    window.k8s
      .listContexts()
      .then(async (ctxs) => {
        setContexts(ctxs)
        const cur = await window.k8s.currentContext().catch(() => '')
        setContext(cur || ctxs[0] || '')
      })
      .catch((e) => setError(`Cannot reach kubectl: ${String(e)}`))
  }, [])

  // Load namespaces when context changes.
  useEffect(() => {
    if (!context) return
    window.k8s
      .list({ context, kind: 'namespaces' })
      .then((list) =>
        setNamespaces((list as K8sList).items.map((i) => i.metadata.name))
      )
      .catch(() => setNamespaces([]))
  }, [context])

  const loadResources = useCallback(() => {
    if (!context) return
    setLoading(true)
    setError('')
    setSelected(null)
    setDetail('')
    const clusterScoped = kind === 'nodes' || kind === 'namespaces'
    window.k8s
      .list({ context, namespace: clusterScoped ? undefined : namespace, kind })
      .then((list) => setItems((list as K8sList).items))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [context, namespace, kind])

  useEffect(() => {
    loadResources()
  }, [loadResources])

  // Load detail when selection or tab changes.
  useEffect(() => {
    if (!selected || !context) return
    const name = selected.metadata.name
    const ns = selected.metadata.namespace
    setDetail('Loading…')
    if (detailTab === 'logs' && kind === 'pods') {
      window.k8s
        .logs({ context, namespace: ns ?? namespace, pod: name })
        .then(setDetail)
        .catch((e) => setDetail(`Error: ${String(e)}`))
    } else {
      window.k8s
        .describe({ context, namespace: ns, kind: kind.replace(/s$/, ''), name })
        .then(setDetail)
        .catch((e) => setDetail(`Error: ${String(e)}`))
    }
  }, [selected, detailTab, context, kind, namespace])

  const rows = useMemo(() => items, [items])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">K8s Desktop</div>
        <label className="lbl">Context</label>
        <select value={context} onChange={(e) => setContext(e.target.value)}>
          {contexts.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="lbl">Namespace</label>
        <select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
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
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">Read-only MVP · uses your kubeconfig via kubectl</div>
      </aside>

      <main className="main">
        <header className="main-head">
          <h1>
            {KINDS.find((k) => k.id === kind)?.label}
            <span className="ns">
              {kind === 'nodes' || kind === 'events' ? ' all namespaces' : ` · ${namespace}`}
            </span>
          </h1>
          <button className="refresh" onClick={loadResources} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </header>

        {error && <div className="error">{error}</div>}

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                {kind !== 'nodes' && <th>Namespace</th>}
                <th>Status</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                const st = podStatus(it)
                const sel = selected?.metadata.name === it.metadata.name
                return (
                  <tr
                    key={`${it.metadata.namespace}/${it.metadata.name}`}
                    className={sel ? 'sel' : ''}
                    onClick={() => {
                      setSelected(it)
                      setDetailTab('describe')
                    }}
                  >
                    <td className="mono">{it.metadata.name}</td>
                    {kind !== 'nodes' && <td>{it.metadata.namespace ?? '—'}</td>}
                    <td>
                      <span className={`pill ${statusClass(st)}`}>{st}</span>
                    </td>
                    <td>{age(it.metadata.creationTimestamp)}</td>
                  </tr>
                )
              })}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    No {kind} found.
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
                  onClick={() => setDetailTab('describe')}
                >
                  Describe
                </button>
                {kind === 'pods' && (
                  <button
                    className={detailTab === 'logs' ? 'active' : ''}
                    onClick={() => setDetailTab('logs')}
                  >
                    Logs
                  </button>
                )}
              </div>
            </div>
            <button className="close" onClick={() => setSelected(null)}>
              ×
            </button>
          </header>
          <pre className="detail-body">{detail}</pre>
        </section>
      )}
    </div>
  )
}
