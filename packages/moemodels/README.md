# `moemodels`

The public launcher for the MOEModels developer toolchain. It keeps the common
workflow under one binary while delegating to the independently versioned
`@moemodels/*` packages.

```sh
npx moemodels plan moonshotai/kimi-k3 nvidia/h200-sxm-141gb --devices 16
npx moemodels run --endpoint http://127.0.0.1:8000/v1/chat/completions --model served-model
npx moemodels verify passport.json
```

`run` measures an endpoint you control. It does not launch a serving runtime,
download weights, or prove the checkpoint behind the endpoint. See the root
README and the DeployBench methodology before publishing results.
