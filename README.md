# CiteLoop

在**模型输出到达用户之前**，对回答里的引用做一次确定性校验；不通过时不是“再问一遍”，
而是把**结构化失败信号**（哪一句、缺什么、有哪些可用证据）塞回模型，让它只重写失败的那几句。

> 现状：一期（最小可用验证器）+ 二期（重试闭环、四级决策、阈值配置、反馈包、收敛熔断）已落地；
> 三期（二维诊断、DOI/arXiv 元数据校验、JSON 报告）尚未实现。方案书见 [proposal.md](./proposal.md)。

## 它解决什么问题

检索增强问答里最常见的一类坏输出不是“找不到资料”，而是**资料找到了、回答却写歪了**：

| 症状 | 例子 | CiteLoop 的处理 |
| --- | --- | --- |
| 数字对不上 | 来源写 1200 毫秒，回答写 900 毫秒 | `numeric-missing` → 退回该句重写 |
| 专名凭空出现 | 来源没有 `BERT`，回答里却有 | `entity-missing` |
| 引用指向错误 | `[2]` 指向一篇讲部署的文档，却在说性能 | `citation-mismatch` |
| 陈述与来源无关 | 整句和引用文献没有任何共同话题 | `keyword-overlap-low` |
| 引用打不开 | URL 404 / 超时 | `source-unreachable`（不重试，直接报“检索不足”） |
| 没有引用 | 关键结论压根没标来源 | `no-source`（需 `requireCitations`） |

## 流水线

```
agent/turn-stopping ──► 取最后一条 assistant 消息作为草稿
        │
        ├─ L2 解析  extract.ts     引用抽取（[1] / (Smith, 2020) / URL / DOI / arXiv）+ 参考资料解析 + 句子绑定
        │
        ├─ L3 验证  anchors.ts     数字锚定、专名锚定
        │            overlap.ts    关键词覆盖率（词元重叠，中文按二元词）
        │            pointing.ts   引用指向性
        │            verify.ts     合成单元结论（supported / partial / unsupported / unreachable / skipped）
        │
        └─ L4 决策  decide.ts      pass / annotate / rewrite（带反馈包）/ abort（带原因）
                     feedback.ts   反馈包文本
```

**证据回收**：`tools/post-execute` 会顺手把检索类工具（`web_search`、`web_fetch` 等）的输出留一份，
L4 用它区分“生成不忠实”（材料在手没写对 → 值得重写）和“检索不足”（材料压根没有 → 直接报告）。

**熔断**：最多重写 `maxAttempts` 次；连续两次失败单元的词元 Jaccard > `unitJaccardStop` 视为原地打转；
引用密度跌到首轮的 `citationCollapseRatio` 以下视为“靠删引用过关”，三种都直接停止。

## 控制台观测

插件把每一步判定直接写到 stdout（`src/log.ts`），由启动它的 `dshRunner.py` 透传到终端。
一次“失败 → 退回重写 → 通过”的完整回合长这样：

```
[citeloop] ✔ plugin-loaded · CiteLoop 引用校验已装配 · mode=rewrite · 覆盖率阈值=0.35 · 最多重写=2 次 · 工具=citeloop_check · 详细日志=开
[citeloop]    evidence ← web_fetch · https://example.com/report-2024
[citeloop] ── L1 触发 ── turn=3 · 草稿 412 字
[citeloop]    L2 解析 · 引用 5 条 · 陈述单元 4 个 · 参考条目 3 条 3ms
[citeloop]    L2 取证 · 可读来源 2 个 · 不可达 1 个 812ms
[citeloop]    L3 验证 · 达标 1 · 部分 1 · 无支撑 1 · 不可达 1 · 跳过 0 1ms
[citeloop]       ✘ u2 覆盖率 21% · numeric-missing · 来源中没有出现 1200 人
[citeloop] ↻ 退回重写 · 第 1/2 次 · 失败单元 u2
[citeloop]    → steer(next-step) 已注入反馈包 812 字
[citeloop] ✔ 放行 · 单元 4（supported 4 / partial 0 / …）；引用 5 条；密度 11.20/千词；无失败 （校验 640ms）
```

- 颜色开关：默认开；`NO_COLOR=1` 或 `CITELOOP_COLOR=0` 关闭，`CITELOOP_COLOR=1` 强制开启
  （`dshRunner.py` 在终端里会自动设成 `1`，避免 DSH 子进程环境里的 `NO_COLOR` 把颜色吃掉）。
- 详细程度：`verbose: false` 时只保留每回合一行结论（`✔ 放行` / `! 标记` / `↻ 退回重写` / `⛔ 熔断`）。
- 为什么不用 `ctx.logger.info`：DSH 在 web 模式下不把 info 级日志转发到 stdout，`ctx.logger.warn`
  那行只在会话日志里可见，**终端判断“插件装没装上”要看 `plugin-loaded` 这行**。

配套的 `dshRunner.py` 会额外做三件事：识别 `plugin-loaded` 打印绿色成功横幅（含启动耗时）；
对 `Cannot find module` / `EADDRINUSE` / `ERR_REQUIRE_ESM` / `error TS####` / `EPERM` 等常见故障
自动补一段「现象 / 原因 / 建议」的彩色诊断（同类只提示一次）；退出时打印退出码。

## 启用

1. 安装依赖（link 到本机的 DSH 源码，`lib/` 已构建即可）：

   ```powershell
   cd E:\Projects\dsh-plugs\dsh-citeloop
   pnpm install
   ```

2. 在仓库根写一份 patch：

   ```yaml
   # E:\Projects\dsh-plugs\citeloop.patch.yml
   - insert:
       - id: citeloop
         name: 'E:/Projects/dsh-plugs/dsh-citeloop/src/index.ts'
         config:
           mode: rewrite
           maxAttempts: 2
   ```

3. 启动（端口按需调整）：

   ```powershell
   cd E:\Projects\dsh-plugs\deepseek-harness
   pnpm dsh web --patch E:\Projects\dsh-plugs\dsh-citeloop\cordis.yml --port 3080
   ```

`cordis.yml` 已在仓库里给出最小示例，路径必须写成**绝对路径**。

> 换机器时注意两点：`node_modules` 不入库（`devDependencies` 用 `link:` 指向本机 DSH 源码），
> 克隆后要改 `package.json` 里的 `link:` 路径再 `pnpm install`；`cordis.yml` 与上面命令里的路径
> 是本机示例，按自己的目录改。

## 配置项

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `mark` | `off` 关闭 / `mark` 只记日志 / `rewrite` 退回重写 |
| `verbose` | `true` | 是否输出逐层控制台日志（false 只留每回合结论一行） |
| `maxAttempts` | `2` | `rewrite` 模式下最多重写几次（0 表示只校验不重写） |
| `coverageThreshold` | `0.35` | 关键词覆盖率阈值，越低越宽松 |
| `strictNumbers` | `false` | true 时无单位数字也要逐位一致 |
| `requireCitations` | `false` | true 时“有结论的句子必须带引用” |
| `minUnitTokens` | `4` | 词元数少于此的短句不判定，避免假阳性 |
| `maxSourceChars` | `60000` | 单份来源正文的最大字符数 |
| `fetchTimeoutMs` | `12000` | 抓取单份来源的超时 |
| `maxFetchPerTurn` | `12` | 每回合最多抓多少份来源（延迟/成本护栏） |
| `retrievalTools` | `web_search, web_fetch, search, fetch, browse` | 哪些工具的输出可回收为证据 |
| `unitJaccardStop` | `0.85` | 失败单元相似度熔断阈值 |
| `citationCollapseRatio` | `0.5` | 引用密度坍缩熔断阈值 |

## 在输入框里调用（`/citeloop`）

DSH 的输入框有两个触发器：`/` 是**命令**（候选来自服务端的 `ctx.commands`，插件可以注册），
`@` 是**引用菜单**（文件 / 目录 / 会话，由浏览器端的 `ui-reference` 插件注册）。
服务端 cordis 插件够不到 `@` 的注册面，所以这里注册的是斜杠命令：

| 输入 | 行为 |
| --- | --- |
| `/citeloop` | 校验本轮最后一条回答 |
| `/citeloop last` | 同上，显式写法 |
| `/citeloop <文本>` | 校验你粘进去的文本（末尾可带参考资料列表） |

结果直接回到对话里（`✔ 引用校验通过` / `✘ 引用校验未通过` + 逐单元明细），
**不修改回合状态、不 steer 模型**——想走自动重写闭环请用 `mode: rewrite` 的钩子。
`commands` 是可选依赖：没有命令层的组合里插件照常工作，只是输入框里没有这条命令
（用 `ctx.inject` 等待服务，而不是写进 `inject`，否则缺命令层时整个插件会停在 PENDING）。

> 想让 `@` 菜单里出现插件条目，需要另写**客户端插件**（浏览器 bundle + `dsh.client` 清单，
> 在 DSH 的 `cordis.patch.yml` 里注册），属于改宿主安装本身，不在本仓库范围内。

## 校验工具（`citeloop_check`）


插件同时注册了 `citeloop_check`，可以对任意草稿**主动**跑一次校验（不改回合、不重写），
适合在排查“为什么这句话被判无支撑”时用：

```json
{ "text": "DSH 的插件在启动时通过 cordis.yml 注册 [1]。\n\n## 参考资料\n[1] ... https://example.com/docs" }
```

返回 `summary` / `details` / `verdict`（`pass` | `needs-rewrite`）。

## 开发

```powershell
pnpm typecheck   # 用 harness 自带的 tsc，对 lib/types 的 d.ts 做类型检查
pnpm selftest    # 离线自测：解析 → 验证 → 决策全链路，不需要联网
```

目录：

```
src/
  index.ts      插件入口：turn-stopping 钩子、证据旁路、steer 重写/熔断
  config.ts     schemastery 配置与归一化
  types.ts      纯类型层
  text.ts       断句、分词、覆盖率、数字/专名抽取
  extract.ts    引用抽取、参考资料解析、句子绑定
  sources.ts    抓取 + 证据仓库
  anchors.ts    数字/专名锚定
  overlap.ts    关键词覆盖率
  pointing.ts   引用指向性
  verify.ts     单元结论合成
  decide.ts     L4 决策
  feedback.ts   反馈包文本
  log.ts        彩色控制台日志（直接写 stdout，DSH web 不转发 logger.info）
  state.ts      跨轮次状态（按回合发放重试额度）
  pipeline.ts   编排
  tools.ts      citeloop_check 工具
  command.ts    /citeloop 斜杠命令（输入框入口）
  messages.ts   取最后一条 assistant 文本（钩子与命令共用）
scripts/
  selftest.ts   离线自测
```

## 已知限制

- **只校验“带引用的句子”**：没有引用标记的普通陈述默认不进入校验（`requireCitations: true` 时才算 `no-source`）。
- **抓取直接走 `fetch`**：不处理 JS 渲染页面、不跟随带凭证的重定向，403/CAPTCHA 会被判为 `unreachable`。
- **不做语义蕴含判定**：一期/二期是确定性的锚定 + 词元覆盖率，阈值边缘存在假阳性；
  设置偏保守（`mark` 模式）是推荐的起步姿势。
- **中文分词是二元词**：对长句足够，对极短句（< `minUnitTokens`）会直接跳过。
- **重写只针对失败句子**：反馈包要求“只输出被点名的句子”，但它仍然是提示而非强约束。
