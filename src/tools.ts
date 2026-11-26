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
 * 工具注册是 effect：调用一次即生效，插件卸载时由 cordis 自动撤销，
 * 所以这里不需要也不应该返回清理函数。
 *
 * 超时按“最坏情况”给足：每份来源最多 `fetchTimeoutMs`，一轮最多抓
 * `maxFetchPerTurn` 份，再加一点处理余量；给少了会让整批抓取被工具层中断。
 *
 * @param ctx - 宿主上下文；必须已有 `tools` 服务（由 index.ts 的 `inject` 保证）。
 * @param config - 解析后的配置；阈值、抓取预算与超时都取自它。
 * @returns 无返回值。
 * @example
 * // 在 apply() 里装配（`options` 为 resolveConfig 的结果）
 * registerCiteLoopTools(ctx, options)
 * @example
 * // 模型侧调用（工具名 + 唯一参数 text）
 * // citeloop_check({ text: "据 [1]，P99 为 1200ms。\n\n[1] ... https://example.com/report" })
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
    /**
     * 跑一次完整校验并返回结构化结果。
     *
     * 不做“是否放行”的判断、不改回合状态——工具是只读探针：
     * 决策留给调用它的模型（看完 `details` 自己决定改不改）。
     *
     * @param args - 工具参数，只有 `text`（待校验草稿，可含末尾的参考资料列表）。
     * @returns `summary` 一行统计、`details` 逐失败单元明细、`verdict` 为
     *   `'pass'`（全部单元达标）或 `'needs-rewrite'`（存在无支撑/部分支撑单元）。
     * @example
     * const { verdict, details } = await run('citeloop_check', { text: draft })
     */
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
