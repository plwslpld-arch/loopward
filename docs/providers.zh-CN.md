# Models and API keys

[English](./providers.md) | 简体中文

Loopward 会路由到任意兼容 OpenAI 的 chat 接口。模型用 `--model` 指定，如果它不属于内置预设，再用 `--base-url` 指向对应网关。密钥只从环境变量读取，不会写进仓库，也没有任何配置文件保存密钥。

## 唯一的铁律

密钥一律走环境变量，不写在命令行上，也不进被提交的文件：

```bash
export OPENAI_API_KEY=sk-...
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5
```

`mock` 是唯一的例外。它是个离线的确定性替身，不用密钥，拿来试命令、或者在 CI 里跑而不花钱都合适。

## 内置预设

每个预设都写死了一个 base URL，各自读自己的密钥变量。用 `--provider` 挑预设，用 `--model` 挑模型。

| `--provider`  | base URL                                            | 密钥变量             |
|---------------|-----------------------------------------------------|----------------------|
| `openai`      | `https://api.openai.com/v1`                         | `OPENAI_API_KEY`     |
| `deepseek`    | `https://api.deepseek.com/v1`                       | `DEEPSEEK_API_KEY`   |
| `together`    | `https://api.together.xyz/v1`                       | `TOGETHER_API_KEY`   |
| `groq`        | `https://api.groq.com/openai/v1`                    | `GROQ_API_KEY`       |
| `moonshot`    | `https://api.moonshot.cn/v1`                        | `MOONSHOT_API_KEY`   |
| `dashscope`   | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY`  |
| `siliconflow` | `https://api.siliconflow.cn/v1`                     | `SILICONFLOW_API_KEY`|

```bash
export GROQ_API_KEY=gsk_...
npx loopward attack --tools ./tools.json --provider groq --model llama-4-70b
```

## 接入其他任意接口

如果你的模型挂在一个没列出来的网关后面，就用 `--provider openai` 配上 `--base-url`。自托管的 vLLM、Azure 部署、任意兼容 OpenAI 的代理，同一条命令都靠这个办法接进去。

```bash
export OPENAI_API_KEY=...            # whatever the gateway expects as a bearer token
npx loopward attack --tools ./tools.json \
  --provider openai --model my-model --base-url http://localhost:8000/v1
```

也可以不传 flag，直接在环境变量里设 `OPENAI_BASE_URL` 和 `OPENAI_MODEL`。

## Reasoning 模型

有些较新的 reasoning 模型会拒收 `temperature` 和 `seed`。为了可复现，Loopward 默认会带上这两个参数；一旦接口返回 400 并点名这些字段，它就去掉它们自动重试一次。这里你不用配任何东西，只是跑这类模型时可复现性会稍微差一点。

## 交互模式

`npx loopward` 不带命令直接运行，它会一步步问你要选什么（命令、tools 文件、provider、模型），第一次上手不必去记那些 flag。
