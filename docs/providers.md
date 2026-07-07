# Models and API keys

English | [简体中文](./providers.zh-CN.md)

Loopward routes through any OpenAI-compatible chat endpoint. You pick the model with `--model` and,
if it is not one of the built-in presets, point `--base-url` at the gateway. Keys are read from
environment variables only. Nothing secret is written to the repo, and there is no config file that
holds a key.

## The one rule

A key is passed through the environment, never on the command line and never in a committed file:

```bash
export OPENAI_API_KEY=sk-...
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5
```

`mock` is the exception. It is an offline, deterministic stand-in that needs no key, useful for trying
the commands or running them in CI without spending anything.

## Built-in presets

Each preset bakes in a base URL and reads its own key variable. Pick the preset with `--provider` and
the model with `--model`.

| `--provider`  | base URL                                            | key variable         |
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

## Any other endpoint

If your model is behind a gateway that is not listed, use `--provider openai` with `--base-url`. This is
how the same command reaches a self-hosted vLLM, an Azure deployment, or any OpenAI-compatible proxy.

```bash
export OPENAI_API_KEY=...            # whatever the gateway expects as a bearer token
npx loopward attack --tools ./tools.json \
  --provider openai --model my-model --base-url http://localhost:8000/v1
```

You can also set `OPENAI_BASE_URL` and `OPENAI_MODEL` in the environment instead of passing the flags.

## Reasoning models

Some newer reasoning models reject `temperature` and `seed`. Loopward sends them by default for
reproducibility, and if the endpoint returns a 400 naming those fields it retries once without them. You
do not need to configure anything; runs against such models are just slightly less reproducible.

## Interactive mode

Run `npx loopward` with no command and it walks you through the choices (command, tools file, provider,
model), so you do not have to remember the flags on a first run.
