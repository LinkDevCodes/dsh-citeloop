/**
 * 流水线装配：把 L2 解析 → 来源获取 → L3 验证串成一次调用。
 *
 * 钩子（`index.ts`）与工具（`tools.ts`）都走这里，保证
 * “模型自己调工具预检”和“回合结束时自动校验”用的是同一套口径。
 */
import type { SourceDoc, SourceOrigin, VerificationReport } from './types.ts'
import type { ResolvedConfig } from './config.ts'
import { buildUnits, extract } from './extract.ts'
import { resolveUnits } from './sources.ts'
import { describeFailure } from './feedback.ts'
import { verifyDraft } from './verify.ts'
import { truncate } from './text.ts'

/** 可注入的抓取实现类型（与 `fetchSource` 同签名）。 */
export type FetchImpl = (url: string, config: ResolvedConfig, origin: SourceOrigin) => Promise<SourceDoc>

/**
 * 单个流水线阶段的观测事件。
 *
 * 只带数字，不带文案：怎么措辞是 `log.ts` 的事，
 * 这样纯逻辑层（本文件）依然可以离线测试，也不会被日志格式牵着走。
 */
export interface PipelineStage {
  /** `extract`（解析）| `sources`（取证）| `verify`（验证）。 */
  readonly stage: 'extract' | 'sources' | 'verify'
  /** 该阶段耗时（毫秒）。 */
  readonly ms: number
  /** 该阶段的计数：字段随阶段不同。 */
  readonly detail: Readonly<Record<string, number>>
}

/** 阶段回调：每完成一层调用一次。 */
export type StageListener = (stage: PipelineStage) => void

/** 一次完整校验的产物。 */
export interface PipelineResult {
  readonly report: VerificationReport
  /** 草稿中的引用标记数（含未被任何单元捕获的）。 */
  readonly citations: number
}

/**
 * 校验一段文本。
 *
 * @param text - 待校验的草稿。
 * @param config - 解析后的配置。
 * @param fetchImpl - 可替换的抓取实现（离线测试用）。
 * @param onStage - 可选的阶段回调，用于把每层的耗时/计数打到控制台。
 */
export async function verifyText(
  text: string,
  config: ResolvedConfig,
  fetchImpl?: FetchImpl,
  onStage?: StageListener,
): Promise<PipelineResult> {
  let started = Date.now()
  const extraction = extract(text)
  const rawUnits = buildUnits(text, extraction)
  onStage?.({
    stage: 'extract',
    ms: Date.now() - started,
    detail: {
      citations: extraction.citations.length,
      units: rawUnits.length,
      references: extraction.references.length,
    },
  })

  started = Date.now()
  const units = fetchImpl === undefined
    ? await resolveUnits(rawUnits, extraction.references, config)
    : await resolveUnits(rawUnits, extraction.references, config, fetchImpl)
  // 不可达来源要单独计数：它是“检索不足”与“生成不忠实”的分界证据。
  let available = 0
  let unreachable = 0
  for (const unit of units) {
    for (const source of unit.sources) {
      if (source.status === 'available') available += 1
      else unreachable += 1
    }
  }
  onStage?.({
    stage: 'sources',
    ms: Date.now() - started,
    detail: { available, unreachable, units: units.length },
  })

  started = Date.now()
  const resolved = units.reduce((sum, unit) => sum + (unit.sources.length > 0 ? unit.citations.length : 0), 0)
  const report = verifyDraft(text, units, extraction.citations.length, resolved, config)
  onStage?.({
    stage: 'verify',
    ms: Date.now() - started,
    detail: {
      units: report.stats.units,
      supported: report.stats.supported,
      partial: report.stats.partial,
      unsupported: report.stats.unsupported,
      unreachable: report.stats.unreachable,
      skipped: report.stats.skipped,
    },
  })
  return { report, citations: extraction.citations.length }
}

/** 单行摘要，用于日志与工具输出。 */
export function summarizeReport(report: VerificationReport): string {
  const { stats } = report
  const kinds = Object.entries(stats.byKind)
    .map(([kind, count]) => `${kind}:${String(count)}`)
    .join(', ')
  return [
    `单元 ${String(stats.units)}（supported ${String(stats.supported)} / partial ${String(stats.partial)} / unsupported ${String(stats.unsupported)} / unreachable ${String(stats.unreachable)} / skipped ${String(stats.skipped)}）`,
    `引用 ${String(stats.citations)} 条，已解析 ${String(stats.resolvedCitations)} 条`,
    `密度 ${report.citationDensity.toFixed(2)}/千词`,
    kinds.length === 0 ? '无失败' : `失败类型 { ${kinds} }`,
  ].join('；')
}

/**
 * 人类可读的逐单元报告（工具输出用）。
 *
 * @param report - 验证报告。
 * @param limit - 最多列出多少个失败单元。
 */
export function formatReport(report: VerificationReport, limit = 8): string {
  if (report.units.length === 0) {
    return `${summarizeReport(report)}\n未检测到带引用的陈述：没有可校验的引用-陈述对。`
  }
  const lines: string[] = [summarizeReport(report), '']
  let shown = 0
  for (const verdict of report.units) {
    if (verdict.status === 'supported' || verdict.status === 'skipped') continue
    if (shown >= limit) {
      lines.push(`…另有 ${String(report.units.length - shown)} 个单元未列出`)
      break
    }
    shown += 1
    lines.push(`[${verdict.unit.id}] ${verdict.status}（覆盖率 ${(verdict.coverage * 100).toFixed(0)}%）`)
    lines.push(`  原句：${truncate(verdict.unit.sentence, 200)}`)
    for (const failure of verdict.failures) {
      lines.push(`  - ${describeFailure(failure)}：${failure.detail}`)
    }
    if (verdict.evidence.length > 0) {
      const labels = verdict.evidence.map((doc: SourceDoc) => doc.label).slice(0, 3).join('、')
      lines.push(`  来源：${labels}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
