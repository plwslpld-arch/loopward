# Models and API keys

[English](./providers.md) | 简体中文

Loopward 对接任意兼容 OpenAI 的 chat 接口。用 `--model` 选模型；如果模型不在内置预设里，再用 `--base-url` 指到对应网关。密钥只从环境变量读取，既不写进仓库，也没有任何配置文件存放它。

## 唯一的铁律

密钥只走环境变量，不写在命令行上，也不进提交的文件：

```bash
export OPENAI_API_KEY=sk-...
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5
```

`mock` 是唯一的例外。它是个离线、确定性的替身，不用密钥，拿来试命令、或者在 CI 里跑又不花钱，都很合适。

## 内置预设

每个预设都内置了一个 base URL，各自读各自的密钥变量。用 `--provider` 选预设，用 `--model` 选模型。

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

如果模型挂在表里没列出来的网关后面，就用 `--provider openai` 加 `--base-url`。自托管的 vLLM、Azure 部署、任何兼容 OpenAI 的代理，都靠这个办法用同一条命令接进来。

```bash
export OPENAI_API_KEY=...            # whatever the gateway expects as a bearer token
npx loopward attack --tools ./tools.json \
  --provider openai --model my-model --base-url http://localhost:8000/v1
```

也可以不传这两个 flag，直接在环境变量里设 `OPENAI_BASE_URL` 和 `OPENAI_MODEL`。

## Reasoning 模型

有些较新的 reasoning 模型不接受 `temperature` 和 `seed`。Loopward 为了可复现默认会带上这两个参数；如果接口返回 400 并点名了这些字段，就去掉它们重试一次。你不用配任何东西，只是跑这类模型时结果的可复现性会差一点。

## 交互模式

`npx loopward` 不带命令直接跑，它会一步步问你要选什么（命令、tools 文件、provider、模型），第一次用就不必去记那些 flag。
