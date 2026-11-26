/**
 * L3 验证器的编排层：把锚定、覆盖率、指向性三种检查合成为单元结论。
 *
 * 四层流水线中的位置：上游 L2 解析层交出 `ClaimUnit[]`（原句 + 绑定的引用 + 抓回来的来源），
 * 本文件把它们压成 `UnitVerdict[]` 与整篇 `VerificationReport`，下游交给 L4 决策层决定
 * 放行 / 标记 / 重写 / 熔断。本层不发起网络请求、不做决策，只做可复现的确定性判定。
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

/**
 * 判断一条失败是否足以把单元判为“无支撑”。
 *
 * 这里刻意只看严重度、不看失败类型：critical（数字缺失、来源不可达、无来源）与
 * major（专名缺失、覆盖率不足、作者错配）都意味着陈述的硬事实在来源里兑现不了，
 * 对“这句话能否被引用支撑”是同一个结论，因此统一阻断；
 * minor 只表示“有瑕疵但仍可支撑”，是否提示交给 L4 的 `mode` 决定。
 *
 * @param failure - L3 各检查产出的一条失败信号。
 * @returns `true` 表示该失败足以把单元降级为 `unsupported`，`false` 表示只到 `partial`。
 * @example
 * isBlocking({ kind: 'numeric-missing', severity: 'critical', detail: '来源中找不到数字 2019' })
 * // 预期：true
 * isBlocking({ kind: 'keyword-overlap-low', severity: 'minor', detail: '覆盖率 20%' })
 * // 预期：false
 */
function isBlocking(failure: Failure): boolean {
  return failure.severity !== 'minor'
}

/**
 * 验证单个单元。
 *
 * 判定顺序即“证据强度”顺序：先看有没有可读来源（无来源 / 不可达先短路，
 * 这两类是“无法验证”，反馈路径与“无支撑”不同），再算覆盖率与锚点。
 *
 * @param unit - 已解析出来源的单元；`unit.sources` 为空时会直接判 `unsupported`。
 * @param config - 阈值与严格度配置（`minUnitTokens` 默认 4、`coverageThreshold` 默认 0.35、
 *   `requireCitations` 默认 false、`strictNumbers` 默认 false）。
 * @returns 单元结论：`status` 为 supported / partial / unsupported / unreachable / skipped，
 *   `coverage` 为所有可读来源里的最高覆盖率（0~1，跳过时为 1），`evidence` 为可读来源列表。
 * @example
 * import type { ClaimUnit } from './types.ts'
 * import { DEFAULT_CONFIG } from './config.ts'
 * import { verifyUnit } from './verify.ts'
 *
 * const unit: ClaimUnit = {
 *   id: 'u1',
 *   sentence: 'BERT 在 2019 年发布。[1]',
 *   prose: 'BERT 在 2019 年发布。',
 *   start: 0,
 *   end: 19,
 *   citations: [{ raw: '[1]', kind: 'numeric', marker: '1', start: 16, end: 19 }],
 *   sources: [{
 *     id: '#1', label: 'BERT 论文', text: 'BERT 于 2019 年发布。',
 *     origin: 'reference', retrievedAt: 0, status: 'available',
 *   }],
 * }
 * const verdict = verifyUnit(unit, DEFAULT_CONFIG)
 * console.log(verdict.status) // 预期：'supported'
 * console.log(verdict.coverage) // 预期：1（来源覆盖了全部关键词）
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

/**
 * 按 `kind + detail` 去重失败列表。
 *
 * 为什么要去重：一个单元可能挂多份来源，同一处数字缺失会在每份来源上各报一次；
 * 反馈包按条点名，重复条目会稀释每条指令的分量，也让 `stats.byKind` 失真。
 * 只保留首次出现，顺序不变。
 *
 * @param failures - 同一单元收集到的全部失败（可能含重复）。
 * @returns 去重后的新数组，不修改入参。
 * @example
 * dedupeFailures([
 *   { kind: 'numeric-missing', severity: 'critical', detail: '来源中找不到数字 2019' },
 *   { kind: 'numeric-missing', severity: 'critical', detail: '来源中找不到数字 2019' },
 * ]) // 预期：只剩 1 条（两条 kind 与 detail 都相同）
 */
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
 * 统计口径说明：`sentences` 与 `units` 都取已解析单元的条数（无引用的句子不进 L3），
 * `citationDensity` 按每千词计数，供 L4 检测“重写后把引用删光”的规避行为。
 *
 * @param draft - 完整草稿文本，仅用于计算词数与引用密度。
 * @param units - 已完成来源解析的单元；空数组表示没有任何可校验句子。
 * @param citations - 草稿中引用标记总数（含未解析出来源的）。
 * @param resolvedCitations - 至少解析出一份来源的引用数；≤ `citations`。
 * @param config - 阈值与严格度配置，会逐单元传给 `verifyUnit`。
 * @returns 整篇报告：逐单元结论 + 冻结的统计量 + 引用密度 + 是否全部通过（`allSupported`）。
 * @example
 * import { DEFAULT_CONFIG } from './config.ts'
 * import { verifyDraft } from './verify.ts'
 *
 * const report = verifyDraft('示例草稿。[1]', [], 1, 0, DEFAULT_CONFIG)
 * console.log(report.allSupported) // 预期：true（没有单元，也就没有失败单元）
 * console.log(report.citationDensity.toFixed(2)) // 预期：'333.33'（1 次引用 / 3 个词元 × 1000）
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

/**
 * 取失败单元的词元集合，用于跨轮次的「原地打转」检测。
 *
 * 每个失败单元只取前 16 个不重复词元：重写会改动措辞，取全量会让相似度虚高，
 * 取前若干个高频词元既够判断“是不是同一批句子”，又不怕小幅改写。
 *
 * @param report - L3 输出的整篇报告。
 * @returns 失败单元词元的去重列表（supported / skipped 单元不参与）。
 * @example
 * import { DEFAULT_CONFIG } from './config.ts'
 * import { failureTokens, verifyDraft } from './verify.ts'
 *
 * const report = verifyDraft('草稿', [], 0, 0, DEFAULT_CONFIG)
 * failureTokens(report) // 预期：[]（没有失败单元）
 */
export function failureTokens(report: VerificationReport): string[] {
  const tokens = new Set<string>()
  for (const verdict of report.units) {
    if (verdict.status === 'supported' || verdict.status === 'skipped') continue
    for (const token of uniqueTokens(tokenize(verdict.unit.prose)).slice(0, 16)) tokens.add(token)
  }
  return [...tokens]
}

/**
 * 判定为“需要修复”的单元（供反馈包使用）。
 *
 * 三种状态都要修但修法不同：`unsupported` 要改内容或换来源，`unreachable` 要先解决取证，
 * `partial` 是可选优化，因此统一交给反馈包逐单元给出原因，而不是在这里过滤掉。
 *
 * @param report - L3 输出的整篇报告。
 * @returns 状态为 unsupported / partial / unreachable 的单元结论（保持原顺序）。
 * @example
 * import { DEFAULT_CONFIG } from './config.ts'
 * import { failingVerdicts, verifyDraft } from './verify.ts'
 *
 * const report = verifyDraft('草稿', [], 0, 0, DEFAULT_CONFIG)
 * failingVerdicts(report) // 预期：[]（没有单元即没有待修复单元）
 */
export function failingVerdicts(report: VerificationReport): UnitVerdict[] {
  return report.units.filter(
    (verdict) => verdict.status === 'unsupported' || verdict.status === 'partial' || verdict.status === 'unreachable',
  )
}
