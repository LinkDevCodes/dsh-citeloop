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
import type { ContextFormed, Message, MessageSource } from '@deepseek-ai/dsh-llm'
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
import { blocksToText } from './text.ts'
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
 * 插件入口。
 *
 * 所有失败都必须被吞掉并降级为“放行”——校验器是给回答加保险的，
 * 不能因为自己抛异常而把用户的回答卡死。
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
    + `详细日志=${options.verbose ? '开' : '关'}`,
  )
  ctx.logger.warn('[citeloop] The plugin has been successfully loaded and the verification closed loop is ready.')
}

/** 一次 turn-stopping 的完整处理流程。 */
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

/** 记录本次校验结果，供下一次（重写后的）校验做收敛与规避检测。 */
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
 * 取最后一条 assistant 消息的文本。
 *
 * `deriveMessages()` 返回的是按 surface 折叠后的**有效**历史，
 * 所以这里拿到的就是模型本轮真正想问用户的那段话（不含被折叠掉的中间步骤）。
 */
function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'assistant') {
      return blocksToText(message.content)
    }
  }
  return ''
}

/** 熔断时发给模型的指令：不是“再写一遍”，而是“向用户说明为什么写不了”。 */
function abortInstruction(cause: AbortCause, reason: string): string {
  return [
    '【CiteLoop 熔断】本轮回答中的引用陈述无法依据现有来源验证，自动重写已停止。',
    `原因：${reason}`,
    `请直接向用户说明：哪些结论缺少证据、${causeHint(cause)}。`,
    '不要重复整篇回答，也不要用删除引用标记的方式绕过校验。',
  ].join('\n')
}

/** 不同熔断原因对应给用户的补救建议。 */
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

/** 把异常压成一行，避免日志里出现整段堆栈。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
