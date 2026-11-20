# K8s Desktop

A lightweight desktop Kubernetes cluster viewer — read-only MVP.
Part of the DevOps Toolkit product family.

## What it does

- Lists all kubeconfig contexts; switch between clusters
- Namespace picker + resource browser (Pods, Deployments, Services,
  ConfigMaps, PVCs, Ingresses, Nodes, Events)
- Resource detail: `kubectl describe` output
- Pod logs viewer (`--tail=500`, all containers)
- Status pills (Running / Pending / CrashLoopBackOff etc.)

## Architecture

- **Electron + React + TypeScript** (electron-vite template)
- **No k8s client library** — the main process shells out to `kubectl`,
  so exec-credential auth plugins (GKE/EKS/AKS SSO, OIDC) work
  transparently with your existing kubeconfig.
- **Read-only by design**: only `get` / `describe` / `logs` /
  `config get-contexts` verbs are invoked. Resource kinds are
  allowlisted in `src/main/index.ts` — no create/apply/delete paths exist.
- IPC surface: `k8s:contexts`, `k8s:currentContext`, `k8s:list`,
  `k8s:logs`, `k8s:describe` (`src/preload/index.ts`)

## Develop

```bash
pnpm install
pnpm dev        # electron + vite dev server
pnpm build      # typecheck + build
pnpm build:mac  # unsigned macOS bundle (electron-builder)
```

Requires `kubectl` on PATH and a reachable cluster context.

## Roadmap candidates (not implemented)

- Write operations behind explicit confirmation (restart, scale, delete)
- exec/shell into containers (needs WebSocket + xterm.js)
- YAML editor view, port-forward, multi-cluster compare
- Signed/notarized builds + auto-update for distribution
- License gating for a Pro tier
