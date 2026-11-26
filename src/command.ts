/**
 * 斜杠命令：`/citeloop`（简版结论）与 `/citeloop-report`（Markdown 报告）。
 *
 * 插件对外有五个入口，分工不同：
 * - `agent/turn-stopping` 钩子：回合结束时**自动**校验，会 steer 重写（index.ts）；
 * - `citeloop_check` 工具：**模型主动**预检自己的草稿（tools.ts）；
 * - `/citeloop` 命令：**用户主动**点名校验，结果直接回到输入框所在的对话里；
 * - `/citeloop-report` 命令：同上，但输出一份可粘贴、可存档的 Markdown 报告（report.ts）；
 * - `cancellation`（回合取消）等边界：一律放行，不阻断用户。
 *
 * 为什么做成“斜杠命令”而不是“@ 引用”：DSH 的输入框只有两种触发器——
 * `/` 是命令源（候选来自服务端的 `ctx.commands`，插件可以注册），
 * `@` 是引用菜单（文件 / 目录 / 会话，由浏览器端的 `ui-reference` 插件注册）。
 * `@` 源的注册面是客户端（`ctx.inputTriggers.registerSource`），
 * 服务端 cordis 插件碰不到，所以服务端插件能被用户“叫出来”的唯一入口就是 `/`。
 *
 * 两条命令共享“取文本”这一段（`readDraft()`），差别只在取材之后的呈现：
 * 一条走屏幕摘要（`formatReport`），一条走完整文档（`renderMarkdownReport`）。
 * 校验本身完全一致，所以两份输出永远不会互相矛盾。
 */
import type { CommandInvocation, CommandResult, CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { ResolvedConfig } from './config.ts'
import { formatMs, logDebug, logReport, logStage, logVerdicts } from './log.ts'
import { lastAssistantText } from './messages.ts'
import { formatReport, summarizeReport, verifyText } from './pipeline.ts'
import { renderMarkdownReport } from './report.ts'

/** 命令名（不带前导斜杠）；用户在输入框里输入 `/citeloop` 触发简版结论。 */
export const COMMAND_NAME = 'citeloop'

/** 命令名（不带前导斜杠）；输入 `/citeloop-report` 触发 Markdown 报告。 */
export const REPORT_COMMAND_NAME = 'citeloop-report'

/** 不带参数时校验上一条回答的关键字，写成 `last` 更利于发现（也可直接回车）。 */
const LAST_KEYWORD = 'last'

/** 取文本的结果：草稿正文 + 它是不是“上一条回答”。 */
interface DraftSelection {
  /** 待校验的文本（已 trim；可能为空串，由调用方决定怎么提示）。 */
  readonly text: string
  /** true 表示走的是“上一条回答”；false 表示用户直接粘了文本。 */
  readonly useLast: boolean
}

/**
 * 从命令调用里取出待校验文本。
 *
 * 两种输入形态：
 * - 空输入或 `last`：取会话里最后一条 assistant 消息的纯文本；
 * - 其他：把用户输入原样当草稿（支持多行、支持 Markdown 与末尾参考列表）。
 *
 * 取最后一条 assistant 消息而不是“整个会话”：用户想校验的通常是刚刚那段回答，
 * 把整段历史拼起来会让引用密度与覆盖率都失真。
 *
 * @param invocation - 命令调用上下文；用到 `rawInput` 与 `agent.session`。
 * @param keyword - 表示“校验上一条回答”的关键字，默认 `last`（大小写不敏感）。
 * @returns 草稿文本与来源标记；文本可能为空串（例如新会话里还没回答过）。
 * @example
 * ```ts
 * // 本文件内可直接调用（未导出）
 * readDraft(invocationWithEmptyInput) // { text: '上一条回答…', useLast: true }
 * readDraft(invocationWith('last'))   // { text: '上一条回答…', useLast: true }
 * readDraft(invocationWith('据 [1]，P99 为 1200ms。')) // { text: '据 [1]，…', useLast: false }
 * ```
 */
function readDraft(invocation: CommandInvocation, keyword: string = LAST_KEYWORD): DraftSelection {
  const raw = invocation.rawInput.trim()
  const useLast = raw.length === 0 || raw.toLowerCase() === keyword
  const text = useLast ? lastAssistantText(invocation.agent.session.deriveMessages()) : raw
  return { text, useLast }
}

/**
 * 生成“没有可校验内容”的提示文案。
 *
 * 文案里带上命令名：用户常常忘了自己敲的是哪一条命令，
 * 尤其是 `/citeloop` 与 `/citeloop-report` 只差一个后缀。
 *
 * @param commandName - 当前命令名（不带斜杠），用于拼提示。
 * @param useLast - true 表示用户没给文本、走的是“上一条回答”的路径。
 * @returns 一句可直接展示给用户的中文提示。
 * @example
 * emptyDraftMessage('citeloop-report', true)
 * // '还没有可校验的回答：先让模型回答一段，或把待校验文本跟在 /citeloop-report 后面。'
 */
function emptyDraftMessage(commandName: string, useLast: boolean): string {
  return useLast
    ? `还没有可校验的回答：先让模型回答一段，或把待校验文本跟在 /${commandName} 后面。`
    : '待校验文本为空。'
}

/**
 * `/citeloop` 的执行体：取文本 → 跑 `verifyText` → 把屏幕摘要回填给输入框。
 *
 * 失败一律以 `kind: 'error'` 返回而不是抛异常：`error` 会作为一条提示显示给用户，
 * 抛异常则会在会话里留下一段无人解释的报错。
 *
 * @param invocation - 命令调用上下文，提供 agent、原始输入与取消信号。
 * @param config - 解析后的配置；阈值、抓取预算、超时都取自它。
 * @returns `success` 携带单行摘要 + 逐单元明细；`error` 携带一句可读的原因。
 * @example
 * // 直接回车：校验上一条回答
 * // /citeloop
 * @example
 * // 粘贴草稿：只校验这段文本
 * // /citeloop 据 [1]，该服务 P99 为 1200ms。\n\n[1] ... https://example.com/report
 */
async function executeCheckCommand(invocation: CommandInvocation, config: ResolvedConfig): Promise<CommandResult> {
  const draft = readDraft(invocation)
  if (draft.text.trim().length === 0) {
    return { kind: 'error', text: emptyDraftMessage(COMMAND_NAME, draft.useLast) }
  }

  // 用户在命令执行期间可能点了停止；命令本身不产生副作用，直接结束即可。
  if (invocation.signal.aborted) {
    return { kind: 'error', text: '已取消。' }
  }

  const started = Date.now()
  logDebug(`/citeloop 被调用（${draft.useLast ? '校验上一条回答' : '校验给定文本'}，${String(draft.text.length)} 字）`)
  const { report } = await verifyText(draft.text, config, undefined, logStage)
  logVerdicts(report)

  const head = report.allSupported ? '✔ 引用校验通过' : '✘ 引用校验未通过'
  const elapsed = formatMs(Date.now() - started)
  logDebug(`/citeloop 结论 ${report.allSupported ? 'pass' : 'needs-rewrite'}（耗时 ${elapsed}）`)

  return {
    kind: 'success',
    text: [head, summarizeReport(report), '', formatReport(report)].join('\n'),
  }
}

/**
 * `/citeloop-report` 的执行体：取文本 → 跑 `verifyText` → 输出完整 Markdown 报告。
 *
 * 与 `/citeloop` 共用同一次校验逻辑，只是把结果交给 `renderMarkdownReport()` 排版：
 * 结论、统计表、单元明细表、失败明细、来源清单齐全，附录可选。
 * 报告是纯文本，用户可以直接复制到 issue / PR / 文档里存档。
 *
 * 报告内容不受 `verbose` 影响：它就是命令的返回值本身，不是旁路日志。
 *
 * @param invocation - 命令调用上下文，提供 agent、原始输入与取消信号。
 * @param config - 解析后的配置；`reportIncludeDraft` 决定是否附上草稿原文。
 * @returns `success` 携带整份 Markdown（以 `# CiteLoop 引用校验报告` 开头）；
 * `error` 携带一句可读的原因（无文本 / 已取消 / 校验异常）。
 * @example
 * // 直接回车：为上一条回答生成报告
 * // /citeloop-report
 * @example
 * // 指定文本：为这段草稿生成报告
 * // /citeloop-report 据 [1]，2024 年该指标为 37%。\n\n[1] ... https://example.com/a
 */
async function executeReportCommand(invocation: CommandInvocation, config: ResolvedConfig): Promise<CommandResult> {
  const draft = readDraft(invocation)
  if (draft.text.trim().length === 0) {
    return { kind: 'error', text: emptyDraftMessage(REPORT_COMMAND_NAME, draft.useLast) }
  }

  if (invocation.signal.aborted) {
    return { kind: 'error', text: '已取消。' }
  }

  const started = Date.now()
  logDebug(`/${REPORT_COMMAND_NAME} 被调用（${draft.useLast ? '校验上一条回答' : '校验给定文本'}，${String(draft.text.length)} 字）`)

  let report: Awaited<ReturnType<typeof verifyText>>['report']
  try {
    const result = await verifyText(draft.text, config, undefined, logStage)
    report = result.report
  } catch (error) {
    // 抓取超时之类的异常不应把命令变成一段无人解释的报错，转成 error 结果展示。
    logDebug(`/${REPORT_COMMAND_NAME} 校验异常：${error instanceof Error ? error.message : String(error)}`)
    return { kind: 'error', text: `校验失败：${error instanceof Error ? error.message : String(error)}` }
  }
  logVerdicts(report)

  const renderStarted = Date.now()
  const markdown = renderMarkdownReport(report, {
    mode: config.mode,
    coverageThreshold: config.coverageThreshold,
    includeDraft: config.reportIncludeDraft,
  })
  logReport(markdown.length, Date.now() - renderStarted)
  logDebug(`/${REPORT_COMMAND_NAME} 结论 ${report.allSupported ? 'pass' : 'needs-rewrite'}（总耗时 ${formatMs(Date.now() - started)}）`)

  return { kind: 'success', text: markdown }
}

/**
 * 注册 `/citeloop` 与 `/citeloop-report` 两条命令。
 *
 * 只做“校验 + 呈现”，**不**修改回合状态、**不** steer 模型：
 * 用户明确点了名，就应当立刻看到一份确定性的检查结果，而不是被悄悄卷进重写循环。
 * 想走自动重写闭环，用钩子（`mode: rewrite`）或工具 `citeloop_check`。
 *
 * 注册本身是 effect：插件卸载时 cordis 会自动注销这两条命令，
 * 因此调用方不需要（也无法）手动反注册。
 *
 * @param commands - 命令注册表（`ctx.inject(['commands'], (scope) => scope.commands)` 拿到的实例）。
 * @param config - 解析后的配置；两条命令共用同一份。
 * @returns 无返回值。
 * @example
 * ```ts
 * // 在插件的 apply() 里，等 commands 服务就绪后注册
 * ctx.inject(['commands'], (scope) => {
 *   registerCiteLoopCommand(scope.commands, options)
 * })
 * ```
 * @example
 * // 用户输入（两种命令，两种输出）
 * // /citeloop            → 屏幕摘要
 * // /citeloop-report     → Markdown 报告
 */
export function registerCiteLoopCommand(commands: CommandRuntime, config: ResolvedConfig): void {
  commands.register({
    name: COMMAND_NAME,
    description: '校验草稿中的引用是否被来源支撑（CiteLoop）；不带参数时校验上一条回答',
    input: {
      // 提示语会显示在输入框里，告诉用户这里既能粘一段文本，也能敲 last。
      hint: '[<待校验文本>|last]',
    },
    handler: (invocation: CommandInvocation): Promise<CommandResult> => executeCheckCommand(invocation, config),
  })
  commands.register({
    name: REPORT_COMMAND_NAME,
    description: '校验引用并输出一份 Markdown 格式的报告（CiteLoop）；不带参数时校验上一条回答',
    input: {
      hint: '[<待校验文本>|last]',
    },
    handler: (invocation: CommandInvocation): Promise<CommandResult> => executeReportCommand(invocation, config),
  })
  logDebug(`已注册命令 /${COMMAND_NAME} 与 /${REPORT_COMMAND_NAME}`
    + `（/${COMMAND_NAME} 校验上一条回答，/${COMMAND_NAME} <文本> 校验给定文本，`
    + `/${REPORT_COMMAND_NAME} 输出 Markdown 报告）`)
}
