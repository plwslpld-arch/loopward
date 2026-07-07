# 在 CI 中为 agent 的路由把关

[English](./ci.md) | 简体中文

当指标突破阈值时，Loopward 命令会以非零状态退出，因此你可以拦下那些会让 agent 工具路由变差的合并。

## 快速把关，无需 API key

在有问题的工具进入生产之前，先揪出容易混淆的工具名。整个过程是确定性的，毫秒级完成。

```bash
npx loopward audit --tools ./tools.json --fail-on-high
# exits 1 if any HIGH-risk confusable pair exists (e.g. get_status vs fetch_status)
```

## 完整鲁棒性把关（需要模型）

为每个工具合成一个测试意图，跑完六种 attack，若最差情况下被攻击后的准确率跌破你设定的下限就判定失败。

```bash
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70
# exits 1 if any attack pushes routing accuracy under 70%
```

多步任务有各自的把关：

```bash
npx loopward multi --suite ./tasks.json --provider openai --model gpt-5.5 --fail-under 80
# exits 1 if multi-step task success is under 80%
```

## GitHub Actions

```yaml
name: routing-robustness
on: [pull_request]
jobs:
  loopward:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
      # fast, no secret needed:
      - run: npx loopward audit --tools ./tools.json --fail-on-high
      # full gate (add OPENAI_API_KEY as a repo secret):
      - run: npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

密钥只从环境变量中读取。把 `OPENAI_BASE_URL` 指向任意兼容 OpenAI 的网关即可。
