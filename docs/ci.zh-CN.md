# 在 CI 中为 agent 的路由把关

[English](./ci.md) | 简体中文

一旦指标越过阈值，Loopward 命令就以非零状态退出，于是你能拦下那些让 agent 工具路由变差的合并。

## 快速把关，无需 API key

在有问题的工具进生产之前先揪出容易混淆的工具名。确定性执行，毫秒级完成。

```bash
npx loopward audit --tools ./tools.json --fail-on-high
# exits 1 if any HIGH-risk confusable pair exists (e.g. get_status vs fetch_status)
```

## 完整鲁棒性把关（需要模型）

为每个工具合成一个测试意图，跑完六种 attack，只要最差情况下被攻击后的准确率跌破你设的下限就判失败。

```bash
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70
# exits 1 if any attack pushes routing accuracy under 70%
```

多步任务另有一道把关：

```bash
npx loopward multi --suite ./tasks.json --provider openai --model gpt-5.5 --fail-under 80
# exits 1 if multi-step task success is under 80%
```

## 相对基线的回归门

`--fail-under` 是一条绝对下限。`gate` 则是*相对*门：只有当本次运行明显差于一份保存好的基线时才判失败，用的是整套 suite 一贯的按用例配对 bootstrap 加 Holm 校正，所以单个用例在 temperature-0 抖动下翻车不会误报。

```bash
# once: save a baseline you trust
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --out baseline.json
# in CI: produce the current report, then gate it
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --out cur.json
npx loopward gate   --baseline baseline.json --report cur.json
# exits 1 only if clean or any attack regressed (Holm-p < 0.05 AND the drop's CI lower bound clears --tolerance)
```

它拒绝跨不同模型、变体或工具 schema 作比较（会报 guard 错误），少掉一种 attack 则算覆盖率回归。加上 `--tolerance 3`，要求跌幅超过 3 个点才判失败。

## Stop 轴脆弱性门

探查*停止*决策（而非路由）：如果一次 stop-bias 微调把 premature-stop、over-run 或 success 显著推向它预先登记的方向，就判失败。

```bash
npx loopward multi --suite ./tasks.json --provider openai --model gpt-5.5 --stop-axis --fail-on-fragile
# exits 1 if any non-control nudge is Holm-significant (the neutral control is a placebo and is ignored)
```

## 面向 GitHub code scanning 的 SARIF

把易混淆工具对的发现以 SARIF 2.1.0 格式输出，让它们显示为 code-scanning 告警：

```bash
npx loopward audit --tools ./tools.json --sarif loopward.sarif
```

再用 `github/codeql-action/upload-sarif` 上传。这些发现只是名称与描述的启发式重叠，因此等级封顶在 `warning`/`note`，绝不声称任何安全严重性。

## 常驻 PR 评论 + 徽章

把 [`.github/workflows/loopward-pr.yml`](../.github/workflows/loopward-pr.yml) 放进去，每个 PR 就发一张鲁棒性表格（靠一个隐藏标记做 upsert，不会刷屏）。设置 `LOOPWARD_MODEL_KEY` secret 才能跑出完整的被攻击准确率表；没有它时，同仓库 PR 拿到的是纯 audit 评论，fork 则降级到 job step 摘要（fork 代码永远看不到写 token 或 secret）。[`pages.yml`](../.github/workflows/pages.yml) 工作流会从默认分支发布一个 shields endpoint 徽章（`robustness.json`）和在线 dashboard。

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

密钥只从环境变量读取。把 `OPENAI_BASE_URL` 指向任意兼容 OpenAI 的网关即可。
