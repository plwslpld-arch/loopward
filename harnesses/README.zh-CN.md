<!--
  Field guide to the four loop strategies Loopward sweeps. Each is framed as a "specimen under test":
  its exact node sequence, one mechanism sentence, and a helps/hurts pair stamped with a specific
  model + seed + finding id (never a universal claim). The strategies ARE the independent variable of
  `loopward matrix`; their behavior lives only in packages/core/src/loop.ts, and strategies.json is a
  machine-checked mirror of that file, not a config or plugin loader.
  ponytail: no plugin system and no config loader — adding a fifth harness means editing loop.ts, not
  dropping a file here.
-->

# 受测的 harness

简体中文 | [English](./README.md)

Loopward 把**模型固定住**，只变它外面那圈**循环**。这四种循环策略就是 `loopward matrix` 扫描的自变量：同一批用例、同一个确定性 oracle（`route-exact-v1`，`scoreRoute`/`norm`），变的只有 harness。所以鲁棒性上的任何差异，都能归到循环头上，而不是模型。这条轴，模型对模型的排行榜是看不见的。

**行为定义在哪里。** 真正的 node 序列和分支**只**活在 [`packages/core/src/loop.ts`](../packages/core/src/loop.ts)（`type Variant`、`runCase`）里。这个目录是文档：[`strategies.json`](./strategies.json) 是 `loop.ts` 的**机器校验镜像**，既不是配置文件，也不是插件注册表。运行时没有任何东西加载它，也没有插件系统。想加第五个 harness，是去改 `loop.ts`，而不是往这里丢一个文件。

id 的集合恰好是 `{single, self-check, react, observe}`，也就是 `matrix` 会跑的 `DEFAULT_STRATEGIES`。

每种策略都收在同一条尾巴上，`act → verify → stop`，`verify` 用确定性 oracle 打分。没有哪种策略会调 LLM 来当裁判，oracle 是唯一的评分者。

---

## 标本：`single`

**Node 序列：** `perceive → route → act → verify → stop`
**反馈轮数：** 0  ·  **是否反思：** 否

**机制。** 一锤子买卖：感知意图和候选，`route()` 一次，act，verify，stop，不复查、无反馈。

- **帮上忙 —** `deepseek-chat`，seed 42（**F1**）：作为基线对照。在 `tools.json` 上干净路由准确率 100%（n=42）；只要第一次就选对，它就很强。
- **帮倒忙 —** `deepseek-chat`，seed 42（**F1**）：没有挽回的路子。同一个模型，在那些平平无奇、根本不改变正确答案的意图侧扰动下掉了 **12–43pp**（最惨的 `minimal_context` +42.9pp；反倒是那个对抗性的 `negation_trap` *最弱*，+2.4pp，不显著）。

---

## 标本：`self-check`

**Node 序列：** `perceive → route → reflect → act → verify → stop`
**反馈轮数：** 1  ·  **是否反思：** 是

**机制。** 第一次 `route()` 之后，一个 `reflect` node 把模型自己的选择摆给它看，让它在落定前复核一遍、或改选更好的候选（多一次 `route()` 调用，oracle 不变）。

- **帮上忙 —** `GLM-5.1`，seed 42（**F5**，`sample.json` n=12）：reflect node **挽回**了 +6.9pp 的被攻击准确率，CI [+2.8, +11.1] 不含 0。
- **帮倒忙 —** `deepseek-chat`，seed 42（**F2**，`tools.json` n=42）：同一个 reflect node 把本来选对的路由往那个令人混淆的近似重名工具上带偏，`boundary_blur` 和 `cross_skill_confusion` 上 **−11.9pp**，连干净准确率都掉了 **−7.1pp**。

> 把 F5 和 F2 **放一起**读：同一个 node，符号相反，由模型来定。`self-check` 不是一个被背书的升级，它最清楚地说明了：一个 harness 改动到底帮不帮忙，是*模型-harness 这一对*的属性，这也正是你要去 `matrix` 它、而不是想当然的原因。

---

## 标本：`react`

**Node 序列：** `perceive → think → route → act → verify → stop`
**反馈轮数：** 1  ·  **是否反思：** 否

**机制。** 先跑一个 `think` node（用 `generate()` 自由文本推理哪个候选合适），再把意图连同这段推理喂给 `route()`。当 provider 没有 `generate()` 时，回退成一次朴素的 `route()`。

- **帮上忙 —** `GLM-5.1`，seed 42（**F5**）：一个中性、无害的循环选项，夹在一锤子和复查之间；在路由器动手之前，先给它一段明确的推理上下文。
- **帮倒忙 —** `GLM-5.1`，seed 42（**F5**，`sample.json` n=12）：多出来的这轮推理什么也没换来，对比 `single` 是 **+0.0pp**，所以在这个模型/套件上，它就是多花一次 `generate()` 调用、鲁棒性上颗粒无收。

---

## 标本：`observe`

**Node 序列：** `perceive → route → observe → act → verify → stop`
**反馈轮数：** 2（至多）  ·  **是否反思：** 否

**机制。** `route()` 一次，然后至多 2 轮 `observe` 反馈：每一轮把模型当前的选择连同一条**桩**观测（"it returned: ok"）摆给它，让它保留或改选工具，一旦选择稳定就提前停下。这是多步观测循环在路由上的对应物。

- **帮上忙 —** `deepseek-chat`，seed 42（**F4**，`tasks.json` n=10）：把观测回喂，是测到的所有 harness 改动里最见效的一个，每次调用后加一行桩观测，就把多步任务成功率从 **10% → 60%** 抬了上去，把过冲从 **80% → 20%** 压了下来，模型和任务都没变。在 `GLM-5.1` 上，路由版的 `observe` 变体同样**挽回**了 **+6.9pp** 的被攻击准确率（**F5**）。
- **帮倒忙 —** `GLM-5.1` / `deepseek-chat`，seed 42（**F5**、**F2**）：这条观测是个桩，不是真的工具结果，所以救不回一条已经落定到错误工具上的路由；在那些"把先前选择回喂就会引发犹疑"的模型上，它会像 `self-check` 一样漂移（这两个层级并非完全独立，都在回喂先前的选择）。

---

*上面每一条论断都盖着具体的 model + seed + finding id，没有一条是关于"模型"或"循环"的普适说法。完整设置、注意事项和 CI 都在 [`docs/findings.md`](../docs/findings.md)。*
