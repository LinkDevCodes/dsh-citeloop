/**
 * CiteLoop —— 引用校验钩子插件（L1 触发层 + L4 决策落地）。
 *
 * 工作方式：
 * 1. `tools/post-execute` 顺手把检索类工具的输出存成本回合的证据（不拦工具，只旁路记录）；
 * 2. `agent/turn-stopping` 在模型想把回合交给用户时，读取本轮最后一条 assistant 消息作为草稿，
 *    走完 L2 解析 → L3 验证 → L4 决策；
 * 3. 决策为 `rewrite` 时用 `agent.steer()` 把结构化失败信号塞回模型，
 *    让它只重写失败的那几句；决策为 `abort` 时停止重试并让模型向用户说明原因。
 *
 * 为什么挂在 turn-stopping 上：这是“内容即将离开机器、但还没到用户手里”的唯一时机，
 * 且 steer 会让 agent 机器重读 inbox 再跑一步 —— 正好是“退回重写”需要的语义。
 * 详见 `dsh-citeloop/proposal.md`。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, MessageSource } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveConfig } from './config.ts'
import type { Config as CiteLoopConfig } from './config.ts'
import { decide } from './decide.ts'
import type { AttemptMemory } from './decide.ts'
import {
  formatMs,
  logAbort,
  logAnnotate,
  logDebug,
  logError,
  logEvidence,
  logPass,
  logReady,
  logRewrite,
  logStage,
  logSteer,
  logTurn,
  logVerdicts,
  logWarn,
  setVerbose,
} from './log.ts'
import { summarizeReport, verifyText } from './pipeline.ts'
import { EvidenceRegistry, evidenceFromTool } from './sources.ts'
import { TurnState } from './state.ts'
import type { SessionState } from './state.ts'
import { registerCiteLoopCommand } from './command.ts'
import { lastAssistantText } from './messages.ts'
import { registerCiteLoopTools } from './tools.ts'
import { failureTokens, failingVerdicts } from './verify.ts'
import type { AbortCause } from './types.ts'

// 把 CiteLoop 注入的消息来源注册进类型系统。
// 没有这段 `declare module`，`{ kind: 'citeloop' }` 不是合法的 `MessageSource`
// （`MessageSourceMap` 是 merge-extensible 的接口，官方插件也这么做）。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    citeloop: { kind: 'citeloop' } & ContextFormed
  }
}

/** 插件的注册名（cordis.yml 里 `id` 之外的名字）。 */
export const name = 'citeloop'

/** 配置 schema 的再导出：cordis 加载器用它校验并补全 `config`。 */
export { Config } from './config.ts'

/** 依赖的服务：没有 tools 服务就不激活，避免 `ctx.tools` 为 undefined。 */
export const inject = ['tools']

/** 校验指令的消息来源标记，便于在会话记录里区分“用户说的”和“插件说的”。 */
const CONTEXT_SOURCE: MessageSource = { kind: 'citeloop' }

/**
 * 插件入口：把所有入口一次性装配好。
 *
 * 装配的顺序即依赖顺序：先归一化配置（日志详细程度由它决定），再注册工具与命令
 * （这两个是 effect，插件卸载时自动撤销），最后挂两个事件钩子
 * （`tools/post-execute` 收证据、`agent/turn-stopping` 做校验）。
 *
 * 所有失败都必须被吞掉并降级为“放行”——校验器是给回答加保险的，
 * 不能因为自己抛异常而把用户的回答卡死。
 *
 * @param ctx - 宿主上下文；`tools` 服务由 `inject` 保证存在，`commands` 服务则
 *   用 `ctx.inject` 等待（没有命令层的精简组合下插件仍然可用，只是没有 `/citeloop`）。
 * @param config - cordis 按 `Config` schema 校验后的原始配置，这里再走一遍
 *   `resolveConfig` 做区间钳制与默认值补齐。
 * @returns 无返回值；所有注册都挂在这个 ctx 的 effect 上，随插件卸载自动清理。
 * @example
 * // cordis.yml 里由加载器调用，不需要手写：
 * // - insert:
 * //     - id: citeloop
 * //       name: 'E:/Projects/dsh-plugs/dsh-citeloop/src/index.ts'
 * //       config: { mode: rewrite, maxAttempts: 2 }
 * @example
 * // 单元测试里直接调（需要一个带 tools 服务的 ctx）
 * apply(ctx, { mode: 'mark' })
 */
export function apply(ctx: Context, config: CiteLoopConfig): void {
  const options = resolveConfig(config, (message) => {
    logWarn(message)
    ctx.logger.warn(`[citeloop] ${message}`)
  })
  // 日志详细程度由配置决定：关掉后每回合只留一行结论，避免长回答刷屏。
  setVerbose(options.verbose)

  const evidence = new EvidenceRegistry()
  const turns = new TurnState()

  // 独立可调用的校验工具（用户/模型都可以主动跑一次，便于排查与回归）。
  registerCiteLoopTools(ctx, options)

  // 用户入口：输入框里的 `/citeloop`（简版结论）与 `/citeloop-report`（Markdown 报告）。
  // `commands` 是可选依赖：没有命令层的组合（比如只跑 headless）照样能校验，
  // 所以用 ctx.inject 等它就绪，而不是写进 `inject` 数组——
  // 写进去的话，缺这个服务的部署里整个插件会一直停在 PENDING。
  ctx.inject(['commands'], (scope) => {
    registerCiteLoopCommand(scope.commands, options)
  })

  // ---- 证据旁路：检索类工具的结果留一份，供“检索不足 vs 生成不忠实”的判断 --------
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.agent !== undefined && !result.isError && options.retrievalTools.includes(exec.name)) {
      const doc = evidenceFromTool(exec.name, exec.arguments, result.content)
      if (doc !== undefined) {
        evidence.record(exec.agent.session, doc)
        logEvidence(exec.name, doc.label)
      }
    }
    // waterfall 监听者必须调用 next()，否则工具调用被静默吞掉。
    return next()
  })

  // ---- 主钩子：回合即将结束 → 校验草稿 ------------------------------------------
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (options.mode === 'off') return
    const started = Date.now()
    try {
      await checkBeforeStopping(agent, turn, options, evidence, turns, signal, ctx, started)
    } catch (error) {
      // 自己出问题就当“没有校验器”，放行。日志留给排查。
      logError(`校验过程出错，本轮放行：${errorText(error)}`)
      ctx.logger.warn(`[citeloop] 校验过程出错，本轮放行：${errorText(error)}`)
    }
  })

  // 会话被回收时释放证据，避免 WeakMap 之外的引用泄漏。
  ctx.on('session/disposed', (session) => {
    evidence.clear(session)
    turns.reset(session)
    logDebug('会话结束，已清空证据缓存与重试记忆')
  })

  // 装配日志：这行是“插件到底有没有被 --patch 装上”的唯一可见证据。
  // `plugin-loaded` 这个英文标记同时被 dshRunner.py 识别，用来打印成功横幅。
  logReady(
    `mode=${options.mode} · 覆盖率阈值=${options.coverageThreshold.toFixed(2)} · `
    + `最多重写=${String(options.maxAttempts)} 次 · 工具=citeloop_check · `
    + `命令=/citeloop, /citeloop-report · `
    + `详细日志=${options.verbose ? '开' : '关'}`,
  )
  ctx.logger.warn('[citeloop] The plugin has been successfully loaded and the verification closed loop is ready.')
}

/**
 * 一次 `agent/turn-stopping` 的完整处理流程（L1 触发 → L2/L3 → L4 决策 → 反馈或放行）。
 *
 * 这是插件的核心闭环，调用顺序即流水线顺序：
 * 1. `turns.beginTurn` 拿本回合状态（回合号变化即丢弃上一回合的重试额度）；
 * 2. 三道守卫：本回合已熔断 / 没有正文草稿 / 草稿与上次校验完全相同 —— 都直接返回；
 * 3. `verifyText` 跑“解析 → 取证 → 验证”，`logStage` 把每层耗时与计数打到控制台；
 * 4. `decide` 结合本回合记忆（失败单元词元、引用密度、已重写次数）给出四选一决策；
 * 5. 放行 / 标记 → 只记状态与日志；重写 → `agent.steer` 注入反馈包，让机器再跑一个 step；
 *    熔断 → 记下原因，`rewrite` 模式再额外注入一段“向用户说明为什么写不了”的指令。
 *
 * 为什么这里全程吞异常、只返回 void：钩子是“回答即将交付”的最后一关，
 * 校验器自己坏掉时正确行为是**放行**，而不是让用户永远等不到回答
 * （异常由调用处的 try/catch 兜住并记日志）。
 *
 * @param agent - 正在结束回合的 agent；`agent.session` 提供有效历史，`agent.steer` 用于注入反馈。
 * @param turn - 当前回合号（从 1 开始）；用作“按回合发放重试额度”的键。
 * @param options - 解析后的配置（阈值、模式、抓取预算、重试上限等）。
 * @param evidence - 本会话已回收的检索证据仓库（来自 `tools/post-execute`）。
 * @param turns - 跨回合记忆：上次校验的草稿、失败单元词元、引用密度、已重写次数。
 * @param signal - 本回合的取消信号；用户点停止后不再 steer。
 * @param ctx - 宿主上下文，仅用于 `ctx.logger`（终端可见日志走 `log.ts`）。
 * @param started - 本轮校验的起始时间戳（`Date.now()`），用于在结论行里打印耗时。
 * @returns 无返回值；副作用是：可能的 `agent.steer(...)`、状态更新与日志输出。
 * @example
 * // 由钩子调用（见 apply 里的 ctx.on('agent/turn-stopping', ...)）
 * await checkBeforeStopping(agent, turn, options, evidence, turns, signal, ctx, Date.now())
 */
async function checkBeforeStopping(
  agent: Agent,
  turn: number,
  options: ReturnType<typeof resolveConfig>,
  evidence: EvidenceRegistry,
  turns: TurnState,
  signal: AbortSignal,
  ctx: Context,
  started: number,
): Promise<void> {
  const session = agent.session
  const state = turns.beginTurn(session, turn)

  // 本回合已经熔断：不再校验、不再 steer，让回答直接落地。
  if (state.aborted) {
    logDebug(`turn=${String(turn)} 本回合已熔断，跳过校验`)
    return
  }

  const draft = lastAssistantText(agent.session.deriveMessages())
  // 空草稿（例如只有工具调用没有正文）无需校验。
  if (draft.trim().length === 0) {
    logDebug(`turn=${String(turn)} 本轮无正文草稿，跳过校验`)
    return
  }
  // 与上次校验的草稿完全一致：说明重写没有产生新内容，再校验只会得到同一个决策。
  if (draft === state.lastDraft) {
    logDebug(`turn=${String(turn)} 草稿与上次校验完全相同，跳过重复校验`)
    return
  }

  logTurn(turn, draft.length)

  const { report } = await verifyText(draft, options, undefined, logStage)
  logVerdicts(report)

  const previous: AttemptMemory = {
    tokens: state.tokens,
    density: state.density,
    rewrites: state.rewrites,
  }
  const decision = decide({ report, config: options, evidence: evidence.get(session), previous })
  const failing = failingVerdicts(report).map((verdict) => verdict.unit.id)

  if (decision.kind === 'pass') {
    recall(turns, session, state, draft, report.citationDensity, [])
    logPass(summarizeReport(report), Date.now() - started)
    ctx.logger.info(`[citeloop] 通过 · ${summarizeReport(report)}`)
    return
  }

  if (decision.kind === 'annotate') {
    recall(turns, session, state, draft, report.citationDensity, failureTokens(report))
    logAnnotate(decision.reason, failing)
    ctx.logger.warn(`[citeloop] 标记（未阻断）· ${decision.reason} · ${summarizeReport(report)}`)
    return
  }

  if (decision.kind === 'rewrite') {
    const rewrites = state.rewrites + 1
    recall(turns, session, state, draft, report.citationDensity, failureTokens(report))
    turns.countRewrite(session)
    logRewrite(rewrites, options.maxAttempts, failing)
    ctx.logger.warn(`[citeloop] 退回重写（第 ${String(rewrites)} 次）· ${decision.reason}`)
    if (signal.aborted) {
      logDebug('回合已被取消，放弃本次 steer')
      return
    }
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: decision.feedback }],
      source: CONTEXT_SOURCE,
    }))
    logSteer(decision.feedback.length)
    return
  }

  // abort：停止自动重写。
  turns.markAborted(session, decision.reason)
  logAbort(decision.cause, decision.reason)
  ctx.logger.warn(`[citeloop] 熔断（${decision.cause}）· ${decision.reason}`)
  if (options.mode !== 'rewrite' || signal.aborted) return
  // 只有“允许重写”的模式才会去提示模型；mark 模式下熔断只记日志，用户看到的仍是原文。
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: abortInstruction(decision.cause, decision.reason) }],
    source: CONTEXT_SOURCE,
  }))
  logDebug(`已把熔断说明注入模型（${formatMs(Date.now() - started)}）`)
}

/**
 * 记录本次校验结果，供下一次（重写后的）校验做收敛与规避检测。
 *
 * 写入三样东西：失败单元的词元集合（`unstable-iteration` 靠它算 Jaccard）、
 * 本轮引用密度（`citation-collapse` 靠它发现“删引用过关”）、以及本次草稿原文
 * （草稿一字未变时跳过重复校验）。
 *
 * @param turns - 跨回合记忆仓库。
 * @param session - 会话对象，作为 `WeakMap` 的键（会话销毁即自动释放）。
 * @param state - 本回合状态；只读取其中的 `rewrites` 计数，不在这里自增。
 * @param draft - 本次校验的草稿全文，用于“草稿是否变化”的判定。
 * @param density - 本次报告的引用密度（每千词元引用数）。
 * @param tokens - 失败单元的（去重）词元；全部通过时传空数组。
 * @returns 无返回值；结果写入 `turns` 内部的 `WeakMap`。
 * @example
 * recall(turns, session, state, draft, report.citationDensity, failureTokens(report))
 */
function recall(
  turns: TurnState,
  session: object,
  state: SessionState,
  draft: string,
  density: number,
  tokens: readonly string[],
): void {
  turns.remember(session, { tokens, density, rewrites: state.rewrites }, draft)
}

/**
 * 熔断时发给模型的指令：不是“再写一遍”，而是“向用户说明为什么写不了”。
 *
 * 与重写反馈包的区别：反馈包要模型**改稿**，这里要模型**交代**。
 * 两者都不允许“把引用标记删掉”这种规避手段，所以指令里显式禁止。
 *
 * @param cause - 熔断类型（检索不足 / 迭代不收敛 / 重试用尽 / 引用坍缩 / 生成不忠实）。
 * @param reason - 人类可读的熔断理由，原样写进给模型的说明里。
 * @returns 一段可直接作为 user 消息发送的中文指令。
 * @example
 * agent.steer(createUserMessage({ content: [{ type: 'text', text: abortInstruction('insufficient-retrieval', reason) }], source: CONTEXT_SOURCE }))
 */
function abortInstruction(cause: AbortCause, reason: string): string {
  return [
    '【CiteLoop 熔断】本轮回答中的引用陈述无法依据现有来源验证，自动重写已停止。',
    `原因：${reason}`,
    `请直接向用户说明：哪些结论缺少证据、${causeHint(cause)}。`,
    '不要重复整篇回答，也不要用删除引用标记的方式绕过校验。',
  ].join('\n')
}

/**
 * 不同熔断原因对应给用户的补救建议，用来把“为什么失败”变成“下一步该做什么”。
 *
 * @param cause - 熔断类型。
 * @returns 一段接在“请说明……”后面的中文短语；未知类型退回“需要哪类一手材料”。
 * @example
 * causeHint('insufficient-retrieval') // '以及需要补充检索哪些资料才能核实'
 */
function causeHint(cause: AbortCause): string {
  switch (cause) {
    case 'insufficient-retrieval':
      return '以及需要补充检索哪些资料才能核实'
    case 'unstable-iteration':
      return '以及为什么多次重写仍未收敛（请用户确认口径后重新提问）'
    case 'attempts-exhausted':
      return '以及哪些句子仍未被来源支持'
    case 'citation-collapse':
      return '并说明为什么不能靠删掉引用让数字变好看'
    case 'unfaithful':
    default:
      return '以及需要哪类一手材料（论文、官方文档、数据集）才能支撑'
  }
}

/**
 * 把任意抛出的值压成一行文本。
 *
 * 钩子里的异常只用于日志（然后放行），不需要堆栈；`Error.message` 足够，
 * 非 `Error` 的抛出值（字符串、对象）用 `String()` 兜底。
 *
 * @param error - 捕获到的任意异常值（`unknown`）。
 * @returns 一行可读的错误描述。
 * @example
 * try { await verify() } catch (error) { logError(`校验失败：${errorText(error)}`) }
 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
