/**
 * 可选工具：`citeloop_check`。
 *
 * 钩子是“被动校验”（回合结束时自动跑一次），工具是“主动预检”——
 * 模型可以在写出长文档之前先把草稿丢进来验一遍，避免走完一整轮再被打回。
 * 两者共用 `pipeline.ts` 的同一条流水线，口径完全一致。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'
import { formatMs, logDebug, logStage, logVerdicts } from './log.ts'
import { formatReport, summarizeReport, verifyText } from './pipeline.ts'

/** 工具输出结构：一句话摘要 + 逐单元明细 + 结论。 */
interface CheckOutput {
  readonly summary: string
  readonly details: string
  readonly verdict: 'pass' | 'needs-rewrite'
}

/**
 * 注册 `citeloop_check` 工具。
 *
 * @param ctx - 宿主上下文；`tools` 注册表是 effect 作用域，插件卸载时自动注销。
 * @param config - 解析后的配置（阈值与抓取预算都来自它）。
 */
export function registerCiteLoopTools(ctx: Context, config: ResolvedConfig): void {
  ctx.tools.register(defineTool({
    name: 'citeloop_check',
    description: 'Verify that every citation in a draft is supported by its source (numbers, entities, keyword overlap, author match). Returns per-claim failures; use it before answering with citations.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'Draft text to verify (Markdown supported; reference list at the end is parsed too).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          details: { type: 'string', required: true },
          verdict: { type: 'string', required: true },
        },
      },
      render: (_args, value: CheckOutput) => [{
        type: 'text',
        text: [value.summary, '', value.details].join('\n'),
      }],
    },
    timeoutMs: Math.max(60_000, config.fetchTimeoutMs * (config.maxFetchPerTurn + 1)),
    isConcurrencySafe: () => true,
    async execute(args: { text: string }) {
      const started = Date.now()
      logDebug(`citeloop_check 被调用（草稿 ${String(args.text.length)} 字）`)
      const result = await verifyText(args.text, config, undefined, logStage)
      logVerdicts(result.report)
      const output: CheckOutput = {
        summary: summarizeReport(result.report),
        details: formatReport(result.report),
        verdict: result.report.allSupported ? 'pass' : 'needs-rewrite',
      }
      logDebug(`citeloop_check 结论 ${output.verdict}（耗时 ${formatMs(Date.now() - started)}）`)
      return output
    },
  }))
}
