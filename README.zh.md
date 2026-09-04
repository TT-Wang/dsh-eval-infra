# dsh-eval-infra

给 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 组件做**配对 A/B 评测**的基础设施:插件、系统提示、loop 与上下文设计、工具集、记忆后端、安全防护。

两套配置在真实的 dsh SDK 运行时里背靠背跑同一批场景。工具在第一次试验之前先验卷子,拒绝一次改两处的对照,先看正确性再谈成本,按 DeepSeek 的真实计费方式给每次调用定价,在网络层独立计量用量,所有数字都能从磁盘上的账本重算。证据不足以支撑结论时,它会直说,而不是硬给一个数。

[English](README.md) · [设计文档](docs/design.md) · [场景库](docs/scenarios.md) · [能力记分卡](docs/sota-scorecard.md) · [结果记录](docs/results.md)

## 典型用法

**我的插件真的省钱吗?** 基线是原生 dsh,候选只多插一行插件。报告告诉你通过率有没有守住,以及成本差异是真的,还是落在你这套环境自己的噪声地板里。

```bash
dsh-eval run --baseline baseline --arm fold --repeats 3
```

**我的安全护栏到底有没有用?** 唯一的变量是一句 persona,负载是注入类场景。通过率那几列还会告诉你,你的注入池到底有没有区分力,还是基线本来就扛住了池子里的所有攻击。

```bash
dsh-eval run --baseline baseline --arm guard-persona 'x*' --repeats 5
```

**更大的模型值不值?** 在臂文件顶上写 `model: deepseek-v4-pro`,其余一律不动。质量上去、成本也上去时,评级会给成 tradeoff,并同时给出两边"每解一题"的美元和 token。

```bash
dsh-eval run --baseline baseline --arm pro --repeats 3
```

**这个参数调到多少最好?** 多个候选共用一个基线和同一批试验,区间按 α/m 读取,整族错误率仍然守在 5%。

```bash
dsh-eval run --baseline baseline --arm compact-60 --arm compact-75 --arm compact-90
```

**我的记忆插件真的记住了吗?** 场景可以在中途结束运行时进程,再在同一个工作区上重启一个。断点之后 agent 还答得出来的,才是插件真正存下来的,而不是还留在上下文里的。

```bash
dsh-eval run --baseline baseline --arm memory 'm*' --repeats 5
```

**给 PR 加一道门禁。** 有退化退出码 1,运行不完整退出码 2,再配一个预算上限,卡死的试验烧不光额度。GitHub workflow 见 [docs/ci](docs/ci/github-workflow.yml)。

```bash
dsh-eval run --baseline main --arm pr --repeats 3 --max-usd 5
```

**评测一个不是你写的插件。** 有 Docker 时,第三方插件默认每次试验一个容器;`--docker-keep-sandbox` 会让 dsh 自己的沙箱在容器内继续生效,两层叠加。

```bash
dsh-eval init --plugin ./third-party-plugin
dsh-eval run --baseline baseline --arm third-party --docker-keep-sandbox
```

**供应商是不是悄悄换了模型?** 先给这条路由登记一次指纹,之后每次运行前核对。答案分布对不上的路由会直接卡住读数,而不是让结论悄悄漂移。

```bash
dsh-eval probe --enroll
dsh-eval run --baseline baseline --arm candidate --probe
```

**那次失败是原因还是运气?** 重跑会把一切重新采样;分叉则回放完全相同的前缀,在两臂分道扬镳的那一次调用上转为实时。只在分叉后复现、普通重跑不复现的失败,才是那个点造成的。

```bash
dsh-eval rerun <runId> f9_docs_research --repeats 3 --fork
```

**发布一个别人能复核的结论。** 证据包里有报告、全部证据哈希、分析契约和签名,`verify` 在任何机器上都会回答 PASS、INVALID 或 INCONCLUSIVE。想零成本重新检查某轮运行,直接用录制回放,连 API key 都不需要。

```bash
dsh-eval publish <runId> --out ./bundle
dsh-eval run --replay <runId>
```

## 它提供什么

**公平性写在结构里。** 臂就是 dsh 的 patch 覆盖层,与 `dsh --patch` 接受的行完全一样。每个臂都经 `dsh --dump-config` 合成后逐行 diff,差异超过一行会被拒绝,除非你显式允许。试验按场景、重复、臂交替进行,奇数次 A 后 B、偶数次 B 后 A,每次独立工作区、独立运行时进程、隔离的 `DSH_HOME`。A/A 运行测出"没变化"在你这套环境里长什么样,`--perturb` 再把这条地板扩展到提示措辞的敏感度,用的是每个臂都一模一样的同义改写。

**判卷器本身要先过关。** 场景自带确定性判卷器和参考答案。`selfcheck` 证明空工作区不过、标准答案能过;`--strict` 逐个删除或清空标准答案产出的文件,要求判卷器必须察觉,这才抓得住"永远给过"的假判卷器。标准答案存在工作区之外,agent 读不到。内置 35 个场景,覆盖上下文、工具、编码、提示、记忆、安全、成本、验证八类,其中四个封存为确认池。

**用量不由被测者自报。** 每一次模型调用都经过一个本地代理,把供应商自己返回的用量、实际服务的模型、系统指纹和客户端标识记进带哈希链的账本。运行时自报的数字要和它对账,对不上就扣住成本结论。账本还记录每步的缓存命中/未命中/输出/推理 token,按当时分钟的价格计费并同时给出两个固定档位的重算价,以及工具直方图、行为计数和逐步 trace。

**统计上拒绝过度声称。** 退化先卡门,过了才谈成本,而成本只在两臂都通过的重复对上比。区间以场景为簇,并报告重复间的组内相关与设计效应。要给方向,需要至少五个可比场景、区间不含零、且区间避开实测的 A/A 地板;要给等价,需要区间落在 ±10% 内;其余一律写"不确定"。报告会给出本次设计的最小可检出效应和观测效应的分辨率,用 McNemar mid-p 和后验检验配对结果,档案足够时用 CUPED 降方差。序贯模式一旦有限样本置信序列作出判定就停止,并且在这种提前停止下依然有效。

**判卷模型带护栏。** 代码判不了的场景交给盲评:判卷模型看不到臂名和模型名,按两种顺序各判一次,顺序不一致算平局。多个模型组成评审团按绝对多数决,并报告全票一致率、判卷者之间的一致度和有效独立票数。与被测两臂同厂家族的判卷模型默认拒绝。不确定的判断在保形风险控制下被扣住,一组冻结的锚点样本负责抓判卷模型自己在两次运行之间的漂移,长度效应同时给出分层结果和"等长时"的结果。绝对模式逐次打分,并用人工标注做 PPI++ 校正。

**证据可以交给别人。** 运行结束后全部证据被哈希封存,并签发一份带分析契约和 Ed25519 签名的回执。`verify` 重算每个哈希、从账本重新推导报告、校验签名与结论,回答 PASS、INVALID 或 INCONCLUSIVE。`regrade` 在保留的工作区上重跑判卷器,完全不重跑 agent。录制下来的模型响应让整轮运行可以无密钥、零花费地回放,并在任意一步分叉。

**执行与安全。** 第三方插件默认每次试验一个容器,可选 gVisor 或 Kata 运行时,也可以让 dsh 自己的进程内沙箱在容器内继续生效。除非场景声明需要,网络工具默认关闭。预算上限分运行级和单次试验级,都基于实际观测到的用量。同一个计量代理还能按比例注入限流和卡顿等供应商故障。

**为"读结果"设计的界面。** 运行页默认是一句人话的概要:有没有东西坏掉、成本差多少、这个结论能不能用,以及要让它变成能用的结论下一步该跑哪条命令。表头的开关一键展开完整统计、区间、备注、环境和日志。建运行向导带实时配置 diff 和按历史估算的成本。实时试验矩阵。结论横幅配森林图,画出区间、等价带、最小可检出效应和噪声地板。退化优先、可筛选的配对表。trace 查看器支持折叠工具结果、键盘导航、两臂并排对比、首次分叉标记以及从该步分叉的动作。跨运行历史带成本迷你柱、每个场景的信噪比,并自动挖掘反复出现的失败签名与行为模式。自包含 HTML 与 ATIF 导出。

## 快速开始

```bash
npm install
npm run link:dsh        # 从 ~/.dsh/source/current 链接 dsh peer 包
npm run build

cd /path/to/your-plugin
dsh-eval init --plugin .            # 建 .dsh-eval/home 与 eval profile,装入你的插件,写入起始臂文件
$EDITOR bench/arms/candidate.yml    # candidate 插入你的插件行;baseline 是原生 dsh
dsh-eval selfcheck                  # 每个场景:空工作区→不过,标准答案→过
dsh-eval diff baseline candidate    # 合成树 diff;必须恰好一处不同
dsh-eval run --baseline baseline --arm candidate --repeats 3
dsh-eval ui --open                  # 浏览运行、trace、对比
```

`dsh-eval` 即 `lib/cli.js`;开发期用 `node_modules/.bin/tsx src/cli.ts …`。API key 依次从 `DEEPSEEK_API_KEY`、`$DSH_HOME/.env`、`~/.dsh/.env` 读取,只传给运行时子进程,不打印。

### 臂文件

```yaml
name: fold
description: baseline + 轮内工具结果折叠
# model: deepseek-v4-flash
# effort: high
patches:
  - insert:
      - id: tool-result-fold
        name: '@dsh-external/dsh-tool-result-fold'
        config: { pinSteps: 2 }
```

其他单变量臂:`- id: system-prompt` 换 `persona`;`- id: compaction-basic` 改 `thresholdRatio`;`- id: tool-web` 加 `disabled: true`;顶层 `model: deepseek-v4-pro`。

### 场景

一个场景就是一个目录,五个文件。`root` 是工作区路径,字符串。

```
bench/scenarios/<name>/
  meta.json     {"name": "...", "title": "一句话的中文/英文标题", "turns": 2, "category": "tools",
                 "stressor": "这个场景在压什么", "oracle": "required",
                 "network": false, "new_session_before_turns": [3]}   # 后两项可选
  prompts.json  ["第 1 轮 …", "第 2 轮 …"]
  setup.py      def setup(root): …            # 确定性生成工作区;标准答案可放 <root>/.truth
  verify.py     def verify(root): return ok, detail   # 只判最终状态
  oracle.py     def solve(root): …            # 参考答案
```

`dsh-eval scenarios new <name>` 会把五个文件的可运行范例写进项目自己的场景库并立刻自检;网页端在选场景那一步的 **Add your own**
里可以直接选一个已有目录上传。两条路都会在写入后马上自检:空工作区必须判失败、参考答案必须判通过,因为一个"永远给过"的判卷器
会让之后每一次对照都变成噪声。你自己的场景是**叠加**在内置库之上的,除非你在 `.dsh-eval/config.json` 里显式指定了 `scenarioRoot`。

`new_session_before_turns` 让运行时在指定轮之前退出并在同一工作区上重新启动,这就是测记忆插件"到底存了什么"的方法。`meta.judge` 声明评分标准和交给判卷模型看的产出文件,`meta.holdout` 把场景封进确认池,`prompts.variants.json` 提供 `--perturb` 用的同义改写。

## 怎么读报告

1. **闸门**。基线多数通过而候选多数不过的场景是退化;候选有退化就不给成本结论。
2. **成本对**。只算两臂都通过的重复对;Δ$ 与 Δ% 是各场景在这些对上的均值。
3. **区间**。各场景的 Δ% 以场景为簇做 bootstrap,每个簇带上它全部的重复对。"更便宜/更贵"要求至少五个可比场景、区间不含零、且区间避开实测的 A/A 噪声带;"等价"要求区间落在 ±10% 内;场景少于十个时用 t 区间而不是 bootstrap;其余都写"不确定"。备注里给出本次设计的最小可检出效应和观测效应的分辨率。
4. **来源**。线上计量与运行时自报对不上、两臂被服务了不同模型、或路由探针判定服务模型已变,成本读数都会被扣住。
5. **档位**。跨越峰谷边界的运行会有提示,看固定档位列。
6. **重复次数**。3 次是下限,二值结果建议 5 次;先跑 `--aa` 看看你这套环境里"没变化"长什么样。

## 装进 dsh

两种形态,同一套 API。装到 web profile(`dsh plugin --profile web add @dsh-external/dsh-eval-infra`)并插入一行:

```yaml
- insert:
    - id: dsh-eval-infra
      name: '@dsh-external/dsh-eval-infra'
      config:
        projectRoot: /path/to/your-plugin   # 放 .dsh-eval/ 与 bench/ 的目录
```

完整界面在 `<host>/eval/`,聊天里 `/eval runs` 可用,同时 dsh 侧边栏底部会出现一个席位,显示最近一次对照的状态和一句话结论,并提供"新建对照"和"看上次结果"两个入口。侧边栏读的是标准网页端同一套 HTTP API,两边不会走偏;想单独用就跑 `dsh-eval ui`。

## 命令

| 命令 | 作用 |
|---|---|
| `init [--plugin <path\|pkg>]…` | 建 `.dsh-eval/home` 与 `eval` profile,装插件,写起始臂 |
| `add <path\|pkg>` | 往 eval profile 装插件 |
| `scenarios [globs] [--category c]` | 列场景 |
| `selfcheck [globs] [--strict]` | 标准答案必须过,空工作区必须不过;`--strict` 还会逐个变异标准答案产出 |
| `diff <baseline> <candidate>…` | 合成树 diff 与变量计数 |
| `run --baseline a --arm b [--arm c] [globs]` | 配对运行并打印报告 |
| ↳ 预算 | `[--max-usd N] [--max-usd-per-trial X]` |
| ↳ 统计 | `[--sequential [--seed N]] [--order signal] [--perturb] [--aa] [--include-holdout]` |
| ↳ 来源 | `[--probe] [--no-meter] [--fault-rate P]` |
| ↳ 隔离 | `[--sandbox host\|docker] [--docker-runtime runsc\|kata] [--docker-keep-sandbox]` |
| ↳ 回放 | `[--replay <id> [--fork-at N]]` |
| `report <id> [--json] [--rebuild-ledgers]` | 从账本重建报告 |
| `judge <id> [--model M]… [--mode pairwise\|absolute\|both]` | 对声明了 `meta.judge` 的场景做盲评判卷 |
| `probe [--model M] [--samples N] [--enroll]` | 给路由的服务模型做指纹核对,不一致时退出码 1 |
| `verify <id \| dir> [--json]` | 校验封存哈希、重新推导报告、核对签名回执:PASS(0)、INVALID(1)、INCONCLUSIVE(2) |
| `regrade <id>` | 在保留的工作区上重跑判卷器,重建报告并重新封存 |
| `rerun <id> <scenario> [--repeats N] [--fork]` | 复核一次失败;`--fork` 回放相同前缀并在分叉点转实时 |
| `publish <id> [--out dir]` | 把封存的运行连同 `report.html` 和 `VERIFY.md` 打成可交付的证据包 |
| `perturb <globs> [--n N]` | 为 `--perturb` 起草场景提示的同义改写 |
| `runs` | 列运行 |
| `ui [--port 4177] [--open]` | 本地界面 |
| `export <id> [--out dir] [--html]` | 导出 ATIF v1.8 轨迹,或自包含 HTML 报告 |

## 和现有工具的关系

Harbor 在容器里跑整个 agent 的任务集。promptfoo、Braintrust、LangSmith、Langfuse、Weave、Phoenix 事后比较实验。Inspect 有 epoch、单份日志的 bootstrap 误差和判卷评审团。Claude Code 的 `plugin eval` 对自己的插件做装与不装的消融。dsh 生态内,muou000/dsh-eval 用固定种子的 AB/BA 顺序做配对交替并对产物做内容寻址,hccccc01333/dsh-eval 可以无密钥回放录制的响应,BiBoyang/dsh-eval-harness 用真阳性率与真阴性率验证过的判卷器设门禁,dsheval.ai 发布公开的插件评测榜。

它们都没有把这几件事凑在一起:配对交替加上对合成配置的单变量检查、带变异的判卷器自检、退化优先且只对两臂都通过的配对计价的门控、能否决方向结论的 A/A 地板、有限样本的序贯停止、在网络层计量并在给出任何成本结论前完成对账的用量,以及外部人可以自行重新推导的签名证据。[docs/sota-scorecard.md](docs/sota-scorecard.md) 按能力逐行打分,并写明它们各自在哪一行领先。

## 明说的边界

- 只内置 DeepSeek 价目;其他厂商价格按项目配置,未配置时记为 0 并标注。
- 跨厂商家族的判卷模型需要你自己配置端点。保形弃权需要人工标注的配对来标定,漂移锚点需要档案里已有标注的试验。
- gVisor 和 Kata 运行时是透传给 Docker 的,需要宿主机本身提供。
- 回放会重跑场景的 setup,而不是恢复逐轮的工作区快照,因此只对 setup 确定的场景成立。
- 可比场景少于五个时,工具按设计拒绝给出方向。序贯模式用的是有限样本序列,因此比固定样本区间需要更多场景,这是"每次查看都仍然有效"的代价。
- 有三件事是刻意不做的,各有理由:轮内自适应选场景会改变置信序列所覆盖的估计量,除非做逆概率加权;预测式提前终止是在该放测量值的位置放了一个预测;模拟用户会破坏"两臂输入必须完全相同"这一配对前提。

## 开发

```bash
npm test                 # 不需要 key 的引擎测试(脚本化 driver)
npm run typecheck        # host + UI
npm run build            # lib/(tsc)+ lib/ui(esbuild)
```

许可证:BSD-3-Clause。
