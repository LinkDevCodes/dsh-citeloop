/**
 * L3 验证器的编排层：把锚定、覆盖率、指向性三种检查合成为单元结论。
 *
 * 设计取舍：
 * - **一个单元的多条引用合并判定**：正文常把一句话同时挂在多个来源上，
 *   锚定检查在合并后的正文里找，覆盖率取最高分——只要任一来源能支撑，
 *   就算这条陈述被支撑。
 * - **失败按严重度分级**：`critical`（数字缺失、来源不可达）判定“无支撑”；
 *   `major`（专名缺失、覆盖率不足、作者错配）同样是“无支撑”，
 *   但在 `mark` 模式下 L4 只标记不重写；`minor` 让单元落到 `partial`。
 * - **关键词不足以判定的单元被跳过**：一句只有两三个实词的短句，
 *   覆盖率天然容易达标或天然不达标，两边都没有信息量。
 */
import type {
  ClaimUnit,
  Failure,
  UnitStatus,
  UnitVerdict,
  VerificationReport,
  VerificationStats,
} from './types.ts'
import type { ResolvedConfig } from './config.ts'
import { checkAnchors } from './anchors.ts'
import { checkOverlap } from './overlap.ts'
import { checkPointing } from './pointing.ts'
import { coverageOf, tokenize, uniqueTokens } from './text.ts'

/** major 及以上视为“阻断”：minor 只把单元降级为 partial。 */
function isBlocking(failure: Failure): boolean {
  return failure.severity !== 'minor'
}

/**
 * 验证单个单元。
 *
 * @param unit - 已解析出来源的单元。
 * @param config - 阈值与严格度配置。
 */
export function verifyUnit(unit: ClaimUnit, config: ResolvedConfig): UnitVerdict {
  const claimTokens = tokenize(unit.prose)
  // 词元太少的陈述没有可验证内容（“如上所述。”），跳过而不是判失败。
  if (claimTokens.length < config.minUnitTokens) {
    return { unit, status: 'skipped', failures: [], coverage: 1, evidence: [] }
  }
  if (unit.sources.length === 0) {
    const failure: Failure = {
      kind: 'no-source',
      severity: config.requireCitations ? 'critical' : 'major',
      detail: '该陈述带引用标记，但找不到对应的来源（既无链接，也无参考条目）',
    }
    return { unit, status: 'unsupported', failures: [failure], coverage: 0, evidence: [] }
  }
  const failures: Failure[] = []
  for (const source of unit.sources) {
    if (source.status === 'unreachable') {
      failures.push({
        kind: 'source-unreachable',
        severity: 'critical',
        detail: `来源 ${source.label} 无法访问${source.error === undefined ? '' : `（${source.error}）`}`,
      })
    } else if (source.status === 'empty') {
      failures.push({
        kind: 'source-empty',
        severity: 'major',
        detail: `来源 ${source.label} 抓到了页面但没有正文`,
      })
    }
  }
  const available = unit.sources.filter((source) => source.status === 'available' && source.text.trim().length > 0)
  // 所有来源都不可读：这是“无法验证”，与“无支撑”不同，反馈路径也不同。
  if (available.length === 0) {
    return {
      unit,
      status: failures.length > 0 ? 'unreachable' : 'unsupported',
      failures,
      coverage: 0,
      evidence: [],
    }
  }
  let bestCoverage = 0
  for (const source of available) {
    const coverage = coverageOf(unit.prose, source.text)
    bestCoverage = Math.max(bestCoverage, coverage.coverage)
    const overlap = checkOverlap(coverage, config)
    if (overlap !== undefined) {
      failures.push({ ...overlap, detail: `${overlap.detail}（来源：${source.label}）` })
    }
  }
  // 锚定检查在合并正文里做：多来源共同支撑时，数字可以分散在不同来源中。
  const mergedText = available.map((source) => source.text).join('\n')
  const anchorSource = { ...available[0]!, text: mergedText }
  failures.push(...checkAnchors(unit.prose, anchorSource, config))
  for (const source of available) {
    failures.push(...checkPointing(unit.citations, source))
  }
  const deduped = dedupeFailures(failures)
  const status: UnitStatus = deduped.some(isBlocking)
    ? 'unsupported'
    : deduped.length > 0
      ? 'partial'
      : 'supported'
  return { unit, status, failures: deduped, coverage: bestCoverage, evidence: available }
}

/** 同一个失败可能在多个来源上重复出现，按 kind + detail 去重。 */
function dedupeFailures(failures: readonly Failure[]): Failure[] {
  const seen = new Set<string>()
  const result: Failure[] = []
  for (const failure of failures) {
    const key = `${failure.kind}:${failure.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(failure)
  }
  return result
}

/**
 * 验证整份草稿。
 *
 * @param draft - 完整草稿文本（用于统计引用密度）。
 * @param units - 已完成来源解析的单元。
 * @param citations - 草稿中引用标记总数。
 * @param resolvedCitations - 至少解析出一份来源的引用数。
 * @param config - 配置。
 */
export function verifyDraft(
  draft: string,
  units: readonly ClaimUnit[],
  citations: number,
  resolvedCitations: number,
  config: ResolvedConfig,
): VerificationReport {
  const verdicts = units.map((unit) => verifyUnit(unit, config))
  const byKind: Record<string, number> = {}
  const stats = {
    sentences: verdicts.length,
    units: verdicts.length,
    supported: 0,
    partial: 0,
    unsupported: 0,
    unreachable: 0,
    skipped: 0,
    citations,
    resolvedCitations,
    byKind,
  }
  for (const verdict of verdicts) {
    if (verdict.status === 'supported') stats.supported += 1
    else if (verdict.status === 'partial') stats.partial += 1
    else if (verdict.status === 'skipped') stats.skipped += 1
    else if (verdict.status === 'unreachable') stats.unreachable += 1
    else stats.unsupported += 1
    for (const failure of verdict.failures) {
      byKind[failure.kind] = (byKind[failure.kind] ?? 0) + 1
    }
  }
  const words = tokenize(draft).length
  const citationDensity = words === 0 ? 0 : (citations * 1000) / words
  const allSupported = verdicts.every(
    (verdict) => verdict.status === 'supported' || verdict.status === 'skipped',
  )
  const frozenStats: VerificationStats = Object.freeze(stats)
  return { draft, units: verdicts, stats: frozenStats, citationDensity, allSupported }
}

/** 取失败单元的词元集合，用于跨轮次的「原地打转」检测。 */
export function failureTokens(report: VerificationReport): string[] {
  const tokens = new Set<string>()
  for (const verdict of report.units) {
    if (verdict.status === 'supported' || verdict.status === 'skipped') continue
    for (const token of uniqueTokens(tokenize(verdict.unit.prose)).slice(0, 16)) tokens.add(token)
  }
  return [...tokens]
}

/** 判定为“需要修复”的单元（供反馈包使用）。 */
export function failingVerdicts(report: VerificationReport): UnitVerdict[] {
  return report.units.filter(
    (verdict) => verdict.status === 'unsupported' || verdict.status === 'partial' || verdict.status === 'unreachable',
  )
}
