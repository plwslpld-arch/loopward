<!-- 洁净室项目,无任何前雇主或第三方的代码、数据、命名。见 PROVENANCE.md。 -->

<div align="center">

<img src="assets/logo.png" width="96" alt="Loopward" />

# Loopward

**把你智能体的外层框架(harness)也拉来受测。** 找出路由和停止决策在你自己的工具上会从哪里崩,改动 harness,再用一个确定性判分器证明这次改动确实让指标动了。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/loopward.svg)](https://www.npmjs.com/package/loopward)
[![CI](https://github.com/plwslpld-arch/loopward/actions/workflows/ci.yml/badge.svg)](https://github.com/plwslpld-arch/loopward/actions/workflows/ci.yml)
[![Zero deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg)](./package.json)
[![routing robustness](https://img.shields.io/endpoint?url=https%3A%2F%2Fplwslpld-arch.github.io%2Floopward%2Frobustness.json)](https://plwslpld-arch.github.io/loopward/)

简体中文 | [English](./README.md)  ·  [**在线发现看板 →**](https://plwslpld-arch.github.io/loopward/)

</div>

每个会用工具的智能体,都在反复做同一件事:决定调用**哪个**工具。Loopward 只测这一个决定,而且用你自己的工具来测,判分靠写死的标准答案 oracle,不用大模型当裁判。它审计容易混淆的工具名、用六种方式红队攻击路由、提出改名并复验、对比不同循环策略、再把失败变成一份实测到的提分。大家都在设计智能体循环,却几乎没人检查这个循环的**决定**本身站不站得住。

> 我们这套用例里,13 个前沿模型在干净输入上选工具几乎都很准(多数 100%,没有低于 90% 的)。只在上下文里注入一句话,准确率下降就从 **0 分**(Claude Opus-4-8 几乎不动)到 **100 分**(Gemini-3.1-pro 在这套用例上每条都错)不等。单 seed、n=42,是初步测试,不是排行榜。详见 [`docs/findings.md`](./docs/findings.md)。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/heatmap-dark.svg">
  <img alt="Model × attack routing-robustness heatmap: each cell is the accuracy points lost to that attack (green held, red broke); the signed number is printed in every cell, so it reads without color. Rows are 13 models, columns are the 6 attacks, sorted by prompt injection." src="assets/heatmap.svg" width="100%">
</picture>

<sub>每种攻击让路由准确率掉了多少分。绿色是扛住了,红色是崩了;每个格子里都印着数字(色盲友好)。单 seed、n=42、确定性判分器——是初步测试,不是定论。[在线看板](https://plwslpld-arch.github.io/loopward/)有悬停细节和中英切换。</sub>

## 快速开始

无需安装步骤。`npx` 跑的是已编译好的发布版,你这边什么都不用编译。需要 Node 24+。

```bash
# 1) 你的哪些工具会让路由犯迷糊?确定性判定,不用密钥,秒级返回。
npx loopward audit --tools ./my-tools.json

# 2) 用真实模型在你自己的工具上压测路由(六种攻击 + 置信区间)。
OPENAI_API_KEY=sk-... npx loopward attack --tools ./my-tools.json --provider openai --model gpt-5.5

# 3) 提一个修复,并证明它确实让指标动了。
OPENAI_API_KEY=sk-... npx loopward fix --tools ./my-tools.json --provider openai --model gpt-5.5
```

不确定该用哪些参数?直接 `npx loopward` 不带命令,进引导式问答。

`--tools` 收的就是你平时调用模型时那份工具 schema —— OpenAI 的函数调用格式:

```json
{
  "tools": [
    { "type": "function", "function": { "name": "get_status",     "description": "Get the current status of a service or job." } },
    { "type": "function", "function": { "name": "fetch_status",   "description": "Fetch the latest status for a given resource." } },
    { "type": "function", "function": { "name": "refund_payment", "description": "Issue a refund for a completed payment." } }
  ]
}
```

Anthropic 的 `{ name, description, input_schema }` 数组,以及扁平的 `[{ name, description }]` 列表,也都认。

## 命令

| 命令 | 作用 |
|---|---|
| `audit`    | 标出路由容易混淆的工具名(`get_status` vs `fetch_status`)。不调模型,毫秒级返回。 |
| `attack`   | 把每条请求改写成六种说法,报告路由准确率下降多少,并附配对自助法 95% 区间。 |
| `fix`      | 给容易混淆的工具提一个更清晰的改名,再用同一个 oracle 复验前后差值。 |
| `matrix`   | 同一个固定模型,把同一套攻击跑过 `single` / `self-check` / `react` / `observe`——让 harness 受测。 |
| `flywheel` | 切分你的用例,把失败提炼成一条 guardrail,测出留出集上的路由提分,并给出置信区间。 |
| `multi`    | 跑真正的多步循环,评那些单步选工具看不到的:过早停止、停不下来、任务完成率。加 `--stop-axis` 专门探**停止**决策。 |
| `gate`     | 当路由相对已存基线出现回退时让 CI 失败(退出码 1)——用的是用例配对自助法 + Holm,不是那种忽高忽低的固定阈值。 |
| `multiseed`| 跑 N 个 seed,老实报告 seed 之间的离散度(以 seed 为复现单位,用例配对绝不混池)。 |
| `mcp-tools`| 通过 stdio 导入一个在跑的 MCP server 的工具目录,让上面每个命令都作用在它实际发出的那份 schema 上。 |
| `coevo`    | 把每个错误路由导出成 DPO 偏好对、可验证奖励样本、SFT 负样本。 |
| `stats`    | 用单侧置换检验 + Holm 校正给报告重新算显著性(attack 报告和 stop-axis 报告都能算)。 |
| `verify`   | 离线重算报告里的确定性字段(哈希、准确率、带种子的置信区间),核对是否自洽。 |

让它不止是"又一个测评"的三个命令:

- **`fix`** 把诊断变成控制器。改名是模型给的**建议**;而证明它有效的复测是严格确定性的——这一点是"用大模型当裁判"的测评在结构上做不到的。
- **`matrix`** 把 harness 当成自变量。在 GLM-5.1 上,加一个 self-check 节点让受攻击准确率**回升 +6.9pp**(置信区间不含 0);而同样的节点却**拖累了** deepseek-chat。一个循环改动到底帮不帮忙,是"模型 + harness"这一对的属性,不是 harness 单方面的。
- **`flywheel`** 把"模型↔harness"这个闭环完整跑一遍,测出留出集上的提分——协同进化不是嘴上说,是跑给你看。它始终是演示(注入再复测),永远不是训练器。

## 天生诚实

判分靠固定的标准答案 oracle,绝不用大模型当裁判。每次运行都带一份溯源清单(seed、工具 schema 哈希、oracle 版本、模型 id、git sha)。`loopward verify` 能离线复核;`npm run regenerate-all` 用逐字节相等证明 mock 流水线可复现;`stats` 上 Holm 校正,让"显著"这个标签经得起六次同时比较。还有一个运行时护栏:任何扰动如果会悄悄改掉正确答案,就直接报错中止,而不是默默算错。

## 模型与密钥

任何 OpenAI 兼容的接口都能接。第一方预设(`openai`、`deepseek`、`moonshot`、`dashscope`、`groq`、`together`、`siliconflow`)已内置 base URL;其它的用 `--provider openai --base-url <url>` 即可。密钥一律从环境变量读,每家一个变量,仓库里不留任何机密。完整清单和示例见 [`docs/providers.md`](./docs/providers.md)。

## 从 MCP server 拉工具

把 loopward 指向一个在跑的 MCP server,它会把这台 server 实际发出的工具目录原样拉过来(JSON-RPC over stdio,零依赖),这样你审计的是真东西,而不是手抄的一份 schema:

```bash
npx loopward mcp-tools --server "npx -y @modelcontextprotocol/server-everything" --out tools.json
npx loopward audit --tools tools.json
```

`--server` 会在本地执行你给的命令,所以只从你信得过的 server 导入。已存下来的 `tools/list` 响应也能完全离线用,加 `--from saved.json` 即可。写出的文件带一个 `_source` 溯源块(server、协议版本、工具数量、哈希)——一份 MCP 目录是某个时间点的快照,文件里也这么写明。

## 接入 CI 关卡

```bash
npx loopward audit  --tools ./tools.json --fail-on-high                                       # fast, no key
npx loopward attack --tools ./tools.json --provider openai --model gpt-5.5 --fail-under 70 --out cur.json
npx loopward gate   --baseline baseline.json --report cur.json                                # regressed vs baseline?
```

`--fail-under` 是一条绝对下限;`gate` 是它的相对版——只有当这次运行**显著**差于已存的基线时才失败(用例配对自助法,Holm 校正过),所以温度为 0 时抖动翻掉一条用例并不会误报。还能用 `audit --sarif out.sarif` 输出 SARIF 供 GitHub code scanning 用,再把现成的 [`loopward-pr`](.github/workflows/loopward-pr.yml) workflow 放进去,每个 PR 上都会有一条常驻的鲁棒性评论。完整配置见 [`docs/ci.md`](./docs/ci.md)。

## 发现

覆盖 13 个模型的可复现结果见 [`docs/findings.md`](./docs/findings.md)。一句话版:路由鲁棒性取决于具体型号,和能力强弱不挂钩;真正奏效的攻击是那些平平无奇的(话太短、名字相近),而不是看起来最像攻击的;一个朴素的 self-check 循环,可能帮了一个模型、却害了另一个;而在多步循环里把工具返回结果喂回去,同一个模型的任务成功率就从 10% 提到了 60%。结果由 harness 决定的程度,不亚于模型本身。

## 它不是什么

不是排行榜,不是安全审计,也不是能上生产的循环**运行器**。它是一个针对循环内"路由 + 停止"决策的诊断与修复工具。它也不声称自己是第一个评估工具选择的项目。与 CATS/ToolCert、MetaTool、Harness-Bench 的老实对比见 [`RELATED-WORK.md`](./RELATED-WORK.md)。

## 目录结构

```
packages/core       loop runner + strategies, routing oracle, providers, multi-step, tool audit, manifest, MCP + SARIF
packages/redteam    6 attack classes, robustness metrics + bootstrap CI, fix, meaning guard, stop-axis probe
packages/eval       harness-matrix, stats (Holm), verify (report linter), gate (regression), seed-sweep (multi-seed)
packages/coevo      export failures as training signal; micro-loop flywheel experiment
packages/cli        audit / attack / fix / matrix / flywheel / multi / gate / multiseed / mcp-tools / coevo / stats / verify
packages/ci         pure PR-comment + shields-badge renderer (formats reports; never scores)
packages/dashboard  self-contained bilingual findings dashboard (deployed to GitHub Pages)
harnesses           the 4 loop strategies as "specimens under test" (matrix's independent variable) + when each helps/hurts
datasets            routing, multistep, tool-schema, and gold-label suites
```

用 `npm test` 跑自检(离线,不用密钥)。设计说明在 [`docs/`](./docs)。

## 溯源与许可

独立的洁净室实现,无任何前雇主或第三方的代码、数据、命名。见 [`PROVENANCE.md`](./PROVENANCE.md)。Apache-2.0。
