# `@moemodels/cli`

Query the versioned registry and run deterministic, offline static-residency
checks. No command calls a model provider or downloads checkpoint weights.

The public `moemodels` launcher exposes these commands under the `moemodels`
binary. Installing this scoped package directly exposes `moemodels-registry`.

```sh
moemodels models
moemodels model moonshotai/kimi-k3
moemodels compatibility kimi-k3
moemodels fit gemma-4-26b-a4b-it nvidia/rtx-6000-ada-48gb --gpus 2
moemodels fit moonshotai/kimi-k3 --hardware nvidia/h200-sxm-141gb --devices 8 --devices-per-node 8 --reserve-bps 1300
moemodels plan moonshotai/kimi-k3 nvidia/h200-sxm-141gb --devices 16 --runtime vllm --input-tokens 4096 --output-tokens 1024 --concurrency 32 --target-ttft-ms 800 --target-inter-token-ms 50 --availability ha --json
moemodels validate --json
moemodels evals --model qwen3-30b-a3b --json
moemodels eval <evidence-id> --json
moemodels validate-evals --json
moemodels ingest lm-eval ./results.json --source-url https://example.org/pinned/results.json --retrieved-at 2026-08-03 --model qwen3-30b-a3b --json
moemodels validate-evals ./normalized.json --json
```

Residency uses pinned checkpoint tensor bytes and vendor-advertised decimal GPU
memory. The default 13% reserve and 8-GPU node topology are adjustable with
`--reserve-pct` and `--per-node`. Results do not assert framework support or
peak runtime memory; compatibility remains `unknown` unless a versioned evidence
record establishes otherwise.

`plan` carries the same static calculation into a versioned deployment-
validation plan. It records workload and SLA inputs, preserves runtime and
performance unknowns, and emits seven ordered evidence gates. Use `--output`
to write JSON without overwriting an existing file. A plan is an execution
protocol, not a measured result or deployment certification.

Owner-reported benchmark claims remain non-comparable. The ingestion command
parses local aggregate JSON only; it does not fetch the source URL or execute
model, task, or sample code. Its output is a versioned staging envelope, not a
published run. `validate-evals` accepts either that envelope or the canonical
evaluation registry. Admission still requires independent artifact review,
hardware topology, and the complete comparison fingerprint.
