# dsh-eval-infra

给 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 组件做**配对 A/B 评测**的基础设施:插件、系统提示、loop 与上下文设计、工具集、记忆后端、安全防护。两套配置在真实的 dsh SDK 运行时里背靠背跑同一批场景;工具在第一次试验之前先验卷子,拒绝一次改两处的对照,先看正确性再谈成本,按 DeepSeek 的真实计费方式(缓存命中/未命中、峰谷)给每次调用定价,所有数字都能从磁盘上的账本重算。

[English](README.md) · [设计文档](docs/design.md) · [竞品调研](docs/landscape.md) · [方法论](docs/methodology.md)

## 能做什么

- **臂(arm)** 就是 dsh 的 patch 覆盖层(`bench/arms/*.yml`),与 `dsh --patch` 接受的行完全一样:插入你的插件、禁用某一行、改某个配置字段、换模型或思考档位。
- **只差一处检查**:每个臂都经 `dsh --dump-config` 合成后逐行 diff;差异超过一行会被拒绝,除非显式允许(报告会标"多变量")。
- **场景**自带确定性判卷器和标准答案;**selfcheck** 证明每个判卷器"空工作区不过、标准答案能过"。`bench/scenarios` 内置 26 个场景(context、tools、coding、prompt、memory、safety、cost、verification)。
- **配对、交替、重复**:场景 → 重复 → 臂,奇数次 A 后 B、偶数次 B 后 A,每次试验独立工作区、独立运行时进程、隔离的 `DSH_HOME`。A/A 模式测噪声地板。
- **账本**:每步的缓存命中/未命中/输出/推理 token,按当时分钟的峰或谷价计费并同时给出两个固定档位的重算价,工具直方图,会话事件,带推理原文的逐步 trace。
- **报告**:退化优先;成本只在两臂都通过的重复对上比较;按场景 bootstrap 置信区间;pass^k;每解一题的 token 与美元;缓存命中占比;一句话结论,区间跨零就写"不确定"。Markdown 与 JSON。
- **Web 界面**(`dsh-eval ui`,或装进 dsh web 后的 `/eval`):建运行向导(实时显示合成 diff)、实时试验矩阵、结论横幅、带筛选的配对表、trace 查看器(每步 prompt 体量条、与配对试验并排对比、首次分叉标记)、ATIF 导出。
- **CI 退出码**:0 无退化,1 有退化,2 未完成或出错。

## 快速开始

```bash
npm install
npm run link:dsh        # 从 ~/.dsh/source/current 链接 dsh peer 包
npm run build

cd /path/to/your-plugin
dsh-eval init --plugin .            # 建 .dsh-eval/home 与 eval profile(dsh-base + dsh-sdk-app),装入你的插件,写入起始臂文件
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

```
bench/scenarios/<name>/
  meta.json     {"name": "...", "turns": 2, "category": "tools", "stressor": "...", "oracle": "required",
                 "network": false, "new_session_before_turns": [3]}   # 后两项可选
  prompts.json  ["第 1 轮 …", "第 2 轮 …"]
  setup.py      def setup(root): …            # 确定性生成工作区;标准答案可放 root/.truth(对 agent 隐藏)
  verify.py     def verify(root): return ok, detail   # 只判最终状态
  oracle.py     def solve(root): …            # 参考答案
```

`new_session_before_turns` 让运行时在指定轮之前退出并在同一工作区上重新启动,这就是测记忆插件"到底存了什么"的方法。

## 怎么读报告

1. **闸门**。基线多数通过而候选多数不过的场景是退化;候选有退化就不给成本结论。
2. **成本对**。只算两臂都通过的重复对;Δ$ 与 Δ% 是各场景在这些对上的均值。
3. **区间**。各场景的 Δ% 按场景做 bootstrap(B=2000,固定种子)。"更便宜/更贵"要求区间不含零;"等价"要求区间落在 ±10% 内;其他都写"不确定",场景少时这是诚实的默认。
4. **档位**。跨越峰谷边界的运行会有提示,看固定档位列。
5. **重复次数**。3 次是下限,二值结果建议 5 次;先跑 `--aa` 看看你这套环境里"没变化"长什么样。

## 装进 dsh

装到 web profile(`dsh plugin --profile web add @dsh-external/dsh-eval-infra`)并插入一行:

```yaml
- insert:
    - id: dsh-eval-infra
      name: '@dsh-external/dsh-eval-infra'
      config:
        projectRoot: /path/to/your-plugin   # 放 .dsh-eval/ 与 bench/ 的目录
```

界面在 `<host>/eval/`,聊天里 `/eval runs` 可用。

## 命令

| 命令 | 作用 |
|---|---|
| `init [--plugin <path\|pkg>]…` | 建 `.dsh-eval/home` 与 `eval` profile,装插件,写起始臂 |
| `add <path\|pkg>` | 往 eval profile 装插件(底层是 `dsh plugin … add`) |
| `scenarios [globs] [--category c]` | 列场景 |
| `selfcheck [globs]` | 标准答案必须过,空工作区必须不过 |
| `diff <baseline> <candidate>…` | 合成树 diff 与变量计数 |
| `run --baseline a --arm b [--arm c] [globs] [--repeats N] [--concurrency N] [--label L] [--aa] [--allow-multi] [--resume id] [--turn-timeout S] [--keep-workdirs]` | 配对运行并打印报告 |
| `report <id> [--json]` | 从账本重建报告 |
| `runs` | 列运行 |
| `ui [--port 4177] [--open]` | 本地界面 |
| `export <id> [--out dir]` | 每次试验导出 ATIF v1.8 轨迹 |

## 和现有工具的关系

Harbor 在容器里跑整个 agent 的任务集;promptfoo、Braintrust、LangSmith、Langfuse、Weave、Phoenix 事后比较实验;Inspect 有 epoch 和单份日志的 bootstrap 误差;Claude Code 的 `plugin eval`(早期访问)对自己的插件做装/不装消融。它们都不在一次运行里配对交替地跑两套配置、不强制单变量、不验卷子、不按退化设闸门、不按缓存和时段计价。细节与出处见 [docs/landscape.md](docs/landscape.md)。

## 开发

```bash
npm test                 # 不需要 key 的引擎测试(脚本化 driver)
npm run typecheck        # host + UI
npm run build            # lib/(tsc)+ lib/ui(esbuild)
```

许可证:BSD-3-Clause。
