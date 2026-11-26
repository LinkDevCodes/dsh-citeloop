/**
 * 斜杠命令：`/citeloop`（L1 触发层的人类入口）。
 *
 * 插件对外有四个入口，分工不同：
 * - `agent/turn-stopping` 钩子：回合结束时**自动**校验，会 steer 重写（index.ts）；
 * - `citeloop_check` 工具：**模型主动**预检自己的草稿（tools.ts）；
 * - `/citeloop` 命令：**用户主动**点名校验，结果直接回到输入框所在的对话里；
 * - `cancellation`（回合取消）等边界：一律放行，不阻断用户。
 *
 * 为什么做成“斜杠命令”而不是“@ 引用”：DSH 的输入框只有两种触发器——
 * `/` 是命令源（候选来自服务端的 `ctx.commands`，插件可以注册），
 * `@` 是引用菜单（文件 / 目录 / 会话，由浏览器端的 `ui-reference` 插件注册）。
 * `@` 源的注册面是客户端（`ctx.inputTriggers.registerSource`），
 * 服务端 cordis 插件碰不到，所以服务端插件能被用户“叫出来”的唯一入口就是 `/`。
 */
import type { CommandInvocation, CommandResult, CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { ResolvedConfig } from './config.ts'
import { formatMs, logDebug, logStage, logVerdicts } from './log.ts'
import { lastAssistantText } from './messages.ts'
import { formatReport, summarizeReport, verifyText } from './pipeline.ts'

/** 命令名（不带前导斜杠）；用户在输入框里输入 `/citeloop` 触发。 */
export const COMMAND_NAME = 'citeloop'

/** 不带参数时校验上一条回答的关键字，写成 `last` 更利于发现（也可直接回车）。 */
const LAST_KEYWORD = 'last'

/**
 * 注册 `/citeloop` 命令。
 *
 * 只做“校验 + 报告”，**不**修改回合状态、**不** steer 模型：
 * 用户明确点了名，就应当立刻看到一份确定性的检查结果，而不是被悄悄卷进重写循环。
 * 想走自动重写闭环，用钩子（`mode: rewrite`）或工具 `citeloop_check`。
 *
 * @param commands - 命令注册表（`ctx.commands` 或 `ctx.inject(['commands'], ...)` 拿到的 scoped ctx）。
 * @param config - 解析后的配置；阈值、抓取预算、超时都取自它。
 * @returns 无返回值；注册本身是 effect，插件卸载时命令会自动注销。
 * @example
 * // 在插件的 apply() 里，等 commands 服务就绪后注册
 * ctx.inject(['commands'], (scope) => {
 *   registerCiteLoopCommand(scope.commands, options)
 * })
 * @example
 * // 用户输入
 * // /citeloop
 * // /citeloop 据 [1]，该服务 P99 为 1200ms。\n\n[1] ... https://example.com/report
 */
export function registerCiteLoopCommand(commands: CommandRuntime, config: ResolvedConfig): void {
  commands.register({
    name: COMMAND_NAME,
    description: '校验草稿中的引用是否被来源支撑（CiteLoop）；不带参数时校验上一条回答',
    input: {
      // 提示语会显示在输入框里，告诉用户这里既能粘一段文本，也能敲 last。
      hint: '[<待校验文本>|last]',
    },
    handler: (invocation: CommandInvocation): Promise<CommandResult> => executeCommand(invocation, config),
  })
  logDebug(`已注册命令 /${COMMAND_NAME}（/citeloop 校验上一条回答，/citeloop <文本> 校验给定文本）`)
}

/**
 * 命令的实际执行体：取文本 → 跑 `verifyText` → 把报告回填给输入框。
 *
 * 输入有两种形态：
 * - `/citeloop`（或 `/citeloop last`）：校验本轮最后一条 assistant 消息；
 * - `/citeloop <任意文本>`：直接校验这段文本（不会写进会话日志的模型可见部分，
 *   因为命令的 `rawInput` 由会话日志的 `command/run` 事件承载，不发生成用户消息）。
 *
 * 失败一律以 `kind: 'error'` 返回而不是抛异常：`error` 会作为一条提示显示给用户，
 * 抛异常则会在会话里留下一段无人解释的报错。
 *
 * @param invocation - 命令调用上下文，提供 agent、原始输入与取消信号。
 * @param config - 解析后的配置。
 * @returns `success` 携带摘要 + 逐单元明细；`error` 携带一句可读的原因。
 * @example
 * // 直接回车：校验上一条回答
 * // /citeloop
 * @example
 * // 粘贴草稿：只校验这段文本
 * // /citeloop 据 [1]，该服务 P99 为 1200ms。\n\n[1] ... https://example.com/report
 */
async function executeCommand(invocation: CommandInvocation, config: ResolvedConfig): Promise<CommandResult> {
  const raw = invocation.rawInput.trim()
  const useLast = raw.length === 0 || raw.toLowerCase() === LAST_KEYWORD
  const draft = useLast ? lastAssistantText(invocation.agent.session.deriveMessages()) : raw

  if (draft.trim().length === 0) {
    return {
      kind: 'error',
      text: useLast
        ? '还没有可校验的回答：先让模型回答一段，或把待校验文本跟在 /citeloop 后面。'
        : '待校验文本为空。',
    }
  }

  // 用户在命令执行期间可能点了停止；命令本身不产生副作用，直接结束即可。
  if (invocation.signal.aborted) {
    return { kind: 'error', text: '已取消。' }
  }

  const started = Date.now()
  logDebug(`/citeloop 被调用（${useLast ? '校验上一条回答' : '校验给定文本'}，${String(draft.length)} 字）`)
  const { report } = await verifyText(draft, config, undefined, logStage)
  logVerdicts(report)

  const head = report.allSupported ? '✔ 引用校验通过' : '✘ 引用校验未通过'
  const elapsed = formatMs(Date.now() - started)
  logDebug(`/citeloop 结论 ${report.allSupported ? 'pass' : 'needs-rewrite'}（耗时 ${elapsed}）`)

  return {
    kind: 'success',
    text: [head, summarizeReport(report), '', formatReport(report)].join('\n'),
  }
}
