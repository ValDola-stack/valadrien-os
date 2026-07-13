# Manual smoke test — `@valadrien-os/plugin-kubernetes`

Manual sanity check that the plugin works end-to-end against a real
valadrien-os-server instance and a real Kubernetes cluster (kind for local
dev). Future work may automate this in CI.

## Prerequisites

- A running kind cluster:
  ```bash
  kind create cluster --name valadrien-os
  ```
- `kubectl --context kind-valadrien-os get nodes` returns a node in `Ready` state.

## Steps

### 1. Build the plugin

```bash
cd packages/plugins/sandbox-providers/kubernetes
pnpm install --ignore-workspace
pnpm build
```

Expected: `dist/` populated with compiled `.js` and `.d.ts` files. No errors.

### 2. Start valadrien-os-server in dev mode

In a separate terminal:

```bash
cd /path/to/valadrien-os
export VALADRIEN_OS_HOME=/tmp/valadrien-os-smoke
export VALADRIEN_OS_INSTANCE_ID=smoke
export VALADRIEN_OS_DEPLOYMENT_MODE=local_trusted
pnpm --filter @valadrien-os/server dev
```

Wait for `Server listening on 127.0.0.1:3100`.

### 3. Install the plugin via the CLI

```bash
pnpm paperclipai plugin install \
  --local /path/to/valadrien-os/packages/plugins/sandbox-providers/kubernetes \
  --api-base http://127.0.0.1:3100
```

Expected: `✓ Installed valadrien-os.kubernetes-sandbox-provider v0.1.0 (ready)`.

### 4. Create a company and a kubernetes sandbox environment

```bash
CO_ID=$(curl -s -X POST -H "Content-Type: application/json" \
  -d '{"name":"SmokeCo"}' \
  http://127.0.0.1:3100/api/companies | jq -r '.id')

KUBECONFIG_CONTENT=$(cat ~/.kube/config | jq -Rs .)

curl -s -X POST -H "Content-Type: application/json" \
  -d "{
    \"name\": \"k8s-sandbox\",
    \"driver\": \"sandbox\",
    \"config\": {
      \"provider\": \"kubernetes\",
      \"kubeconfig\": $KUBECONFIG_CONTENT,
      \"companySlug\": \"smoke\",
      \"adapterType\": \"claude_local\",
      \"imageAllowList\": [\"ghcr.io/paperclipai/agent-runtime-claude:v1\"]
    }
  }" \
  http://127.0.0.1:3100/api/companies/$CO_ID/environments | jq
```

Expected: HTTP 201 with the new environment row.

### 5. Probe the environment

```bash
ENV_ID=$(curl -s http://127.0.0.1:3100/api/companies/$CO_ID/environments | jq -r '.[0].id')
curl -s -X POST -d '{}' -H "Content-Type: application/json" \
  http://127.0.0.1:3100/api/environments/$ENV_ID/probe | jq
```

Expected: `{"ok": true, ...}` with a summary mentioning the tenant namespace
(`valadrien-os-smoke`). On first probe the namespace may not yet exist —
the plugin treats a 404 on `listNamespacedPod` as a successful reachability
check.

### 6. Trigger an agent run

Use the UI or the API to dispatch a run against the `k8s-sandbox` environment.
The plugin's `onEnvironmentAcquireLease` will:

1. `ensureTenant` — provision the `valadrien-os-smoke` namespace, SA, Role,
   RoleBinding, ResourceQuota, LimitRange, NetworkPolicies
2. `buildJobManifest` — render the security-hardened Job manifest
3. `createJob` — submit to `batch/v1`
4. `createPerRunSecret` — owned by the Job for cascade-delete

### 7. Verify the tenant resources

```bash
kubectl --context kind-valadrien-os get namespace valadrien-os-smoke
kubectl --context kind-valadrien-os get all,networkpolicy,resourcequota,limitrange,sa,role,rolebinding -n valadrien-os-smoke
```

Expected:

- Namespace `valadrien-os-smoke` exists with PSS labels
  (`pod-security.kubernetes.io/enforce=restricted`)
- ServiceAccount `valadrien-os-tenant-sa`
- Role `valadrien-os-tenant-role`, RoleBinding `valadrien-os-tenant-rb`
- ResourceQuota `valadrien-os-quota`, LimitRange `valadrien-os-limits`
- NetworkPolicies `valadrien-os-deny-all` + `valadrien-os-egress-allow`
- Job `pc-{ulid}` and its child Pod
- Secret `pc-{ulid}-env` with `ownerReferences` pointing at the Job

### 8. Tear down

```bash
kubectl --context kind-valadrien-os delete namespace valadrien-os-smoke
kill %1  # valadrien-os-server
```

### 9. Document the result

In the PR description (or appended to this file as a dated section),
record:

- Date + git SHA
- `kubectl version` server version
- Output of `kubectl get all -n valadrien-os-smoke` after step 6
- Probe response from step 5
- Time-to-acquire-lease (target: <30s on kind for a cold tenant)
