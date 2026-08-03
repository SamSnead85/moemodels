# `@moemodels/core`

Browser-safe types, strict registry validation, static data, and deterministic
integer residency math for MOEModels.ai. Importing the package performs no
filesystem, environment, or network access.

```ts
import {
  buildDeploymentPlan,
  calculateResidencyFit,
  evaluationRegistry,
  findHardware,
  findModel,
  listReportedBenchmarkClaims,
  registry,
} from "@moemodels/core";

const model = findModel("moonshotai/kimi-k3");
const hardware = findHardware("nvidia/h200-sxm-141gb");

if (model && hardware) {
  const result = calculateResidencyFit(model, hardware, {
    reserveBasisPoints: 1300,
    acceleratorsPerNode: 8,
  });
  console.log(result);

  const plan = buildDeploymentPlan({
    model,
    hardware,
    compatibility: registry.compatibility,
    requestedAccelerators: 16,
    acceleratorsPerNode: 8,
    reserveBasisPoints: 1300,
    runtime: "vllm",
    workload: {
      inputTokens: 4096,
      outputTokens: 1024,
      concurrency: 32,
      targetTtftMs: 800,
      targetInterTokenMs: 50,
      availability: "ha",
    },
  });
  console.log(plan.readiness, plan.validationGates);
}

console.log(evaluationRegistry.schemaVersion);
console.log(listReportedBenchmarkClaims("qwen3-30b-a3b"));
```

The calculation is a pinned-checkpoint tensor residency lower bound. It does
not infer framework compatibility, usable throughput, cost, KV-cache capacity,
or peak runtime memory.

The deployment-plan engine is deterministic and browser-safe. It combines the
static floor with exact artifact identity, a declared workload/SLA, explicit
unknowns, and ordered validation gates. It does not predict or certify the
unmeasured dimensions.

The evaluation registry is also statically bundled and validated. Its
owner-reported claims retain artifact association and evidence gaps and are not
comparison eligible.
