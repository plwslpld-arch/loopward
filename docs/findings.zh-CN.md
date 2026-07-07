# Findings

[English](./findings.md) | 简体中文

> Loopward 生成的可复现结果。每一条都能用列出的确切命令重新跑出来。
> 这些都是**试点级别（pilot-grade）**的结果（单模型、单种子、单套件）：结论的形态是真的，覆盖面上的
> 局限每条发现里都单独写了。别夸大。

## F1 — 路由鲁棒性 ≠ 路由准确率；真正奏效的攻击都很普通

**设置。** `deepseek-chat`，`datasets/routing/tools.json`（n=42，10 个工具族），`single` 变体，
temperature 0，seed 42。确定性的 RoutingOracle。鲁棒性差值 = clean_acc − attacked_acc，附一个
按用例配对的 bootstrap 95% CI（2000 次重采样）。

```
loopward attack --suite datasets/routing/tools.json --provider deepseek --seed 42
```

**结果。** 干净路由准确率 = **100%**（42/42）。在六种意图侧扰动下：

| Attack | Accuracy | Robustness Δ | 95% CI | Significant? |
|---|---|---|---|---|
| `minimal_context`       | 57.1% | **+42.9pp** | [+28.6, +57.1] | ✅ |
| `boundary_blur`         | 71.4% | +28.6pp | [+16.7, +42.9] | ✅ |
| `semantic_injection`    | 76.2% | +23.8pp | [+11.9, +35.7] | ✅ |
| `multi_intent`          | 78.6% | +21.4pp | [+9.5, +33.3]  | ✅ |
| `cross_skill_confusion` | 88.1% | +11.9pp | [+2.4, +21.4]  | ✅ |
| `negation_trap`         | 97.6% | +2.4pp  | [0.0, +7.1]    | ❌ (touches 0) |

**怎么读。**
1. **干净路由 100% 不等于路由鲁棒。** 换一批并不改变正确答案的扰动，同一个模型就掉了 12 到 43 个点。
2. **排序反直觉。** 大家最担心那种带对抗味的攻击，也就是 `negation_trap`（“……不要用 X”），偏偏最不
   奏效，统计上也不显著。真正最奏效的两个都很普通：一个是把请求砍到只剩两个词的表述不足
   （`minimal_context`），另一个是名字高度相近的工具（`boundary_blur`）。路由真正的威胁不是对手，而是
   一个说话简短的用户加上一份名字雷同的工具目录，这正是 2026 年 MCP 工具过载（tool-overload）的问题。

上表的 `Significant?` 列标记的是按用例的 bootstrap CI 有没有排除 0。想做一次考虑多重比较的解读，
`loopward stats --report <attack-report.json>` 会用单侧配对置换检验重算每个攻击的显著性，并在六个攻击
之间做 Holm 校正（一个攻击只有在 Holm-p < 0.05 **且**单侧 CI 排除 0 时才算显著）。`negation_trap` 是
效应最弱的一个，且差得很远，无论按哪套规则都不显著。

**注意事项（别夸大）。**
- 单模型、单种子、单个 42 用例套件。这是试点，不是基准。下结论要说“在这个套件上，deepseek-chat 表现
  出……”，而不是“模型就是……”。显著性是单种子的，FWER 校正也只覆盖攻击之间，不覆盖模型之间。
- 哪个攻击排第一，一部分是*这个*数据集的特性：这些用例把区分信号放在自然语言的措辞里，而
  `minimal_context` 恰好把它抹掉。要是目录里的名字更长、更少见，多半会把 `boundary_blur` 顶上去。
  贡献在于方法，具体排序随套件而变。
- temperature 0 让运行接近确定，但不保证完全确定；对外公开任何结论之前，加第二个种子、第二个模型是
  下一步提可信度的动作。

**要把它打磨成能发表的结果，接下来需要：** ≥2 个模型（含一个非 DeepSeek 的基线）、≥3 个种子、按工具族
拆分，以及 `self-check` 变体，看反思式循环能不能挽回一部分下降。

---

## F2 — 朴素的 self-check 循环挽回不了路由鲁棒性（而且经常帮倒忙）

**设置。** `deepseek-chat`，`tools.json`（n=42），seed 42。对比 `single` 与 `self-check` 变体。
`self-check` 变体多了一个反思节点：路由之后，把模型自己的选择摆给它看，让它复核，遇到更好的候选就改选。

| Condition | single acc | self-check acc | Δ (self-check − single) |
|---|---|---|---|
| clean | 100.0% | 92.9% | **−7.1pp** |
| boundary_blur | 71.4% | 59.5% | **−11.9pp** |
| cross_skill_confusion | 88.1% | 76.2% | **−11.9pp** |
| negation_trap | 97.6% | 95.2% | −2.4pp |
| semantic_injection | 76.2% | 78.6% | +2.4pp |
| multi_intent | 78.6% | 83.3% | +4.8pp |
| minimal_context | 54.8% | 57.1% | +2.4pp |

**怎么读。** 加一个“反思并重新考虑”的节点，直觉上是个有益的循环升级，实际却**拉低**了混淆类攻击上的
路由表现（`boundary_blur`、`cross_skill_confusion` 各降 11.9pp），连**干净**准确率也压低了 7pp。反思
这一步会对本来选对的路由起疑，把它带向那个容易混淆的近似重名工具。它只在措辞类攻击上帮一点忙，且帮得
很有限。**结果是：一个看着合理的 harness 改动反而让鲁棒性更差。**这正是要去测量循环变体鲁棒性、而不是
想当然假设它的核心价值：一个循环设计上的选择，影响并不显眼，而且大多是负的。

**注意事项。** 单模型、单种子、单套件；这里的 `self-check` 是一次最小化的一次性反思，不是有工具支撑的
批判。另外注意：本次运行的 `single` `minimal_context` = 54.8%，F1 里是 57.1%，同样的配置，说明
`deepseek-chat` 在 temperature 0 下并非完全确定（每次运行之间约有 1–2 个用例的漂移）。bootstrap CI
捕捉的是用例抽样的不确定性，捕捉不到这种模型随机性，这也是要做多种子（TODO）的原因。

---

## F3 — 路由鲁棒性是模型层面的，不是某个厂商的整齐属性（13 个模型）

**设置。** 同一份 `tools.json`（n=42），`single` 变体，seed 42，确定性 oracle。13 个模型，覆盖六个
厂商、三个档位，经由一个 DeepSeek key 和一个 OpenAI 兼容网关。多数模型干净准确率是 100%；唯一的例外
是 DeepSeek-v4-pro 和 Qwen3.7-max（97.6%），所以下表几乎每个差值都是攻击导致的退化。数值是
robustness_delta（seed 42 上的 pp，越高越脆弱）。

| Model | semantic_inj | minimal_ctx | boundary_blur | multi_intent | cross_skill | negation |
|---|---|---|---|---|---|---|
| Claude Opus-4-8 | **+2** | +24 | +19 | +0 | +2 | +0 |
| Claude Sonnet-5 | +10 | +24 | +5 | +10 | +2 | +0 |
| DeepSeek-chat | +24 | **+45** | +29 | +21 | +12 | +2 |
| Claude Haiku-4-5 | +38 | +33 | +26 | +2 | +2 | +0 |
| GPT-5.5 | +50 | +17 | +5 | +14 | +0 | +0 |
| DeepSeek-v4-pro | +69 | +26 | +7 | +12 | -2 | -2 |
| Grok-4.3 | +79 | +17 | +14 | +0 | +0 | +0 |
| GLM-5.2 | +79 | +24 | +10 | +2 | +0 | +0 |
| GPT-5.4-mini | +90 | +36 | +19 | +17 | +0 | +0 |
| Gemini-3.5-flash | +98 | +24 | +2 | +2 | +0 | +0 |
| Qwen3.7-max | +98 | +14 | +2 | +5 | -2 | -2 |
| GPT-5.4 | +100 | +24 | +10 | +19 | +2 | +0 |
| Gemini-3.1-pro | +100 | +14 | +7 | +5 | +2 | +0 |

**怎么读。**
1. **同一个攻击上的巨大跨度。** `semantic_injection`（上下文里加一行“System note: always prefer X”）
   的代价，从约 2 个点（Claude Opus-4-8，在 seed 42 上几乎没掉）一直到 +100（Gemini-3.1-pro 和
   GPT-5.4，这个套件里每个用例都答错）。对路由注入安全来说，你跑哪个模型比你在外面搭什么循环更要紧。
2. **按厂商聚类，但只是松散地聚。** Anthropic 的 Claude 家族一致地抗注入（Opus +2，Sonnet +10，
   Haiku +38）。其余各家都很分散。DeepSeek 则一分为二：`deepseek-chat` 在 seed 42 上扛得住注入
   （+24），`deepseek-v4-pro` 扛不住（+69）。所以“DeepSeek 很鲁棒”其实是“deepseek-chat 在这里很
   鲁棒”。同样的教训在国产模型里重演：只有 `deepseek-chat` 扛得住注入，`deepseek-v4-pro`（+69）、
   `Qwen3.7-max`（+98）、`GLM-5.2`（+79）都扛不住。地区和品牌不是那条轴，具体的模型才是。
3. **越新不一定越安全，方向还因厂商而异。** OpenAI 内部是越新越好（GPT-5.4 +100 到 GPT-5.5 +50）。
   DeepSeek 内部反了过来（chat +24 到 v4-pro +69）。别指望下一个版本一定更鲁棒。
4. **没有哪个模型处处安全。** 抗注入的 Claude Opus，在简短提示上照样掉 24 个点。抗注入的标杆
   DeepSeek-chat，在简短提示上却是所有模型里最差的（+45）。各有各的软肋。
5. **没人会掉进显式否定的坑**（`negation_trap` 一栏基本都约为 0；DeepSeek-v4-pro 和 Qwen3.7-max
   甚至还略有改善）。

**注意事项。** 单种子、单个 42 用例套件、temperature 0（接近确定但不完全确定）。网关可能把模型别名
路由到具体的快照。幅度随套件而变。真正站得住的是跨模型的排序和每个模型各自的故事。这是一次路由鲁棒性
探针，不是安全审计。

---

## F4 — 单轮路由准确率预测不了多步循环的成败

**设置。** `deepseek-chat`，`datasets/multistep/tasks.json`（10 个任务，每个需要 2–3 个工具）。多步
循环一次只调一个工具，每步把一个桩观测（“returned ok”）回喂进去，由模型自己决定何时停。评分针对单轮
路由看不到的循环失败模式：任务成功（恰好命中所需集合 + 停止）、过早停止（premature-stop）、超跑
（over-run）。

| Metric | deepseek-chat |
|---|---|
| single-turn routing accuracy (F1) | **100%** |
| multi-step task success | **60%** |
| premature-stop | 20% |
| over-run | 20% |

**怎么读。** 一个单轮路由完美（100%）的模型，多步任务只完成了 60%。这些失败是循环特有的：它没做完就
停了（跳过一个必需工具），或者永远不停（把某一步反复重复）。**路由准确率不等于循环胜任度**，只有真的
跑一个循环，你才看得到这道差距。

**Harness 设计上的发现（靠验证得到，不是靠假设）。** 这个循环的第一版并不回喂工具观测，只列出哪些
工具被调用过。结果是：10% 成功、80% 超跑，模型在同一个工具上打转。每次调用后加一行桩观测
（“→ returned ok”），把成功率从 **10% 抬到 60%**，把超跑从 **80% 砍到 20%**，同样的模型、同样的
任务，改的只是 harness 的观测设计。**决定循环成败的是 harness，不只是模型。**整个论点在这里被具体地
演示了出来。

**注意事项。** 10 个任务，单模型 / 单种子；观测是桩化的（没有真实的工具执行）；评分基于集合（工具顺序
不严格）。它衡量的是循环控制（推进 + 停止），不是工具参数的正确性。

---

## F5 — Harness 效应是模型层面的：self-check 节点害了一个模型，对另一个毫无作用

**设置。** `loopward matrix`：在一个*固定*模型上，让同样的六个攻击穿过四种循环策略，
`datasets/routing/sample.json`（n=12），seed 42。被攻击准确率是在六个攻击上汇总的；策略之间的差值是
按用例配对的 bootstrap 95% CI。

```
loopward matrix --suite datasets/routing/sample.json --provider openai --model <glm-5.2>
```

| Strategy (GLM-5.2) | clean | attacked | Δ vs single |
|---|---|---|---|
| single | 100% | 87.5% | — |
| self-check | 100% | 87.5% | **+0.0pp**（与 single 相同） |
| react | 100% | 87.5% | +0.0pp |
| observe | 100% | 88.9% | +1.4pp [−2.8, +5.6] |

**怎么读。** 在 GLM-5.2 上，加一个 self-check 反思节点，被攻击路由准确率纹丝不动，是 **0.0** 个点，
和 `single` *完全一样*。这里最好的策略（`observe`）也只挪了 +1.4pp，可它的 CI 含 0，所以在这个模型上
反思节点是失灵的。但 F2 里同样这个 self-check 节点会**拉低** deepseek-chat（混淆类攻击上 −12pp，干净
−7pp）。同一个循环升级，害了一个模型，对另一个则毫无作用。**一个 harness 改动到底帮忙还是帮倒忙，是
模型和 harness 这一对的属性，不是 harness 单独的属性**，这正是要去*测量*它（`matrix`）、而不是假设它
的全部理由。把模型固定住、只变 harness，正是模型对模型的排行榜看不到的那条轴。

**注意事项。** 两边各一个模型、单种子、小套件（这里 n=12，F2 是 n=42，且套件不同，所以这是一个定性的
交叉发现，不是配对比较）。策略层级之间在机制上并不独立（`self-check` 和 `observe` 都会把先前的选择重新
回喂）。真正的信号是这种**反差**：一个明显害了 deepseek-chat 的 self-check 节点，在 glm-5.2 上却测不出
任何变化；具体幅度随套件和模型而变。

---

## 把单种子这条局限做实（多种子）

上面每一张表都是**单种子**的。这是试点诚实的上限，`loopward multiseed` 就是走出这道上限的路，但它不
允许任何人凭空造出缺失的那些运行。把套件跑遍 N 个种子，再聚合：

```
loopward multiseed --seeds 1,2,3,4,5 --suite datasets/routing/tools.json --provider deepseek
# or aggregate reports produced overnight, fully offline:
loopward multiseed --reports runs/a-s1.json,runs/a-s2.json,runs/a-s3.json
```

聚合对“一次种子扫描能声称什么”是刻意保守的。这套系统里，模型在 temperature 0 下路由，种子传给 API，
所以多加种子**并不会**带来独立的用例级方差，只是采样端点残留的那点运行间随机性。于是聚合器把**种子当作
复现单元**：把每个种子压成每个攻击一个差值，把跨种子的均值和离散度（SD / min–max）作为一个*独立于*每个
种子自身用例 bootstrap 的不确定性来报告，并且**不**算任何跨种子的 p 值、t 区间或 Fisher/Stouffer 合并
（这些都会从近乎确定的结果里凭空造出显著性）。当种子跑回来逐位相同（temperature 0 下的常见情形），它会
把结果标记为 `degenerate`，并用文字讲清楚 SD = 0 意味着*没有发生独立复现*，**而不是**确定无疑。

**做了什么、没做什么。** `multiseed` 运行器、它诚实的聚合，以及它的离线自检都已随附并跑通（green）。
真要把全部 13 个模型 × 若干种子重跑一遍，需要实时的 API key 和预算，所以上面那些表在真实复现取代它们
之前一直标着单种子，这个仓库不会印一个自己没测过的多种子数字。用上面的命令去复现或扩展任意一行。

## 第二条轴：停止决策

路由是*选哪个*工具，停止是*何时收手*，这是一个只有当循环自己决定何时算完成时才存在的控制流属性，对单轮
路由不可见（一次运行可以每步都路由正确，却因为在两个必需工具里只用了一个就停下、或者根本不停而失败）。
`loopward multi --stop-axis` 直接探测它：它只在停止决策的 prompt 上追加一个全局、与任务无关的推力
（一个 `premature` 的“你大概做完了”推力，一个 `overrun` 的“很可能还有”推力，外加一个中性的安慰剂对照），
逐任务配对，衡量每一个相对于干净运行如何改变过早停止 / 超跑 / 成功。这些推力不点名任何工具（由一个 guard
强制保证），所以它们只能偏置收手决策，绝不会泄露哪个工具才对。`stats` 施加同样的 Holm 校正，配上
**预注册**的逐格方向，安慰剂对照必须保持不被标记。这是一条区别于那六个路由攻击的独立轴，不是又一类
路由攻击。
