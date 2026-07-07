# Models and API keys

[English](./providers.md) | 简体中文

Loopward 通过任意兼容 OpenAI 的 chat 接口进行路由。你用 `--model` 指定模型，如果它不在内置预设之列，再用 `--base-url` 指向对应网关。密钥只从环境变量读取。不会有任何机密写入仓库，也没有任何配置文件保存密钥。

## The one rule

密钥一律通过环境变量传入，绝不写在命令行上，也绝不放进被提交的文件里：

```bash
export OPENAI_API_KEY=sk-...
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5
```

`mock` 是个例外。它是一个离线、确定性的替身，不需要密钥，适合用来试跑命令，或者在 CI 里运行而不产生任何花费。

## Built-in presets

每个预设都内置了一个 base URL，并读取各自的密钥变量。用 `--provider` 选预设，用 `--model` 选模型。

| `--provider`  | base URL                                            | key variable         |
|---------------|-----------------------------------------------------|----------------------|
| `openai`      | `https://api.openai.com/v1`                         | `OPENAI_API_KEY`     |
| `deepseek`    | `https://api.deepseek.com/v1`                       | `DEEPSEEK_API_KEY`   |
| `openrouter`  | `https://openrouter.ai/api/v1`                      | `OPENROUTER_API_KEY` |
| `together`    | `https://api.together.xyz/v1`                       | `TOGETHER_API_KEY`   |
| `groq`        | `https://api.groq.com/openai/v1`                    | `GROQ_API_KEY`       |
| `moonshot`    | `https://api.moonshot.cn/v1`                        | `MOONSHOT_API_KEY`   |
| `dashscope`   | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY`  |
| `siliconflow` | `https://api.siliconflow.cn/v1`                     | `SILICONFLOW_API_KEY`|

```bash
export GROQ_API_KEY=gsk_...
npx loopward attack --tools ./tools.json --provider groq --model llama-4-70b
```

## Any other endpoint

如果你的模型位于一个未列出的网关之后，就用 `--provider openai` 搭配 `--base-url`。同一条命令正是靠这种方式接入自托管的 vLLM、Azure 部署，或者任意兼容 OpenAI 的代理。

```bash
export OPENAI_API_KEY=...            # whatever the gateway expects as a bearer token
npx loopward attack --tools ./tools.json \
  --provider openai --model my-model --base-url http://localhost:8000/v1
```

你也可以在环境变量里设置 `OPENAI_BASE_URL` 和 `OPENAI_MODEL`，而不必通过 flag 传入。

## Reasoning models

一些较新的 reasoning 模型会拒绝 `temperature` 和 `seed`。Loopward 为了可复现，默认会带上这两个参数；如果接口返回 400 并指出这些字段有问题，它会自动去掉它们重试一次。你不需要配置任何东西；只是针对这类模型的运行结果，可复现性会略微降低。

## Interactive mode

直接运行 `npx loopward` 而不带任何命令，它会引导你逐项做出选择（命令、tools 文件、provider、模型），这样你第一次运行时就不必去记那些 flag。
