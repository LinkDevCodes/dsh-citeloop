/**
 * Markdown 报告渲染器：把 L3 的 `VerificationReport` 排成一份可直接粘贴、存档的报告。
 *
 * 四层流水线位置：L4（决策层）的输出侧附属模块。它不改判定、不抓取来源，
 * 只负责“把已经算出来的结论写成可读文档”，因此纯函数、可离线测试。
 *
 * 与 `pipeline.ts` 的 `formatReport()` 的分工：
 * - `formatReport()` 是**屏幕摘要**：单行统计 + 最多 8 个失败单元，给工具输出与终端看；
 * - `renderMarkdownReport()` 是**文档**：结论、统计表、逐单元表格、失败明细、来源清单齐全，
 *   适合贴进 issue、PR、周报，或作为一次评审的证据附件。
 *
 * 报告里的每个数字都来自报告对象本身（不重新采样、不重新抓取），
 * 所以同一份 `VerificationReport` 无论渲染多少次，内容都一致。
 */
import type { SourceDoc, UnitStatus, UnitVerdict, VerificationReport } from './types.ts'
import { describeFailure } from './feedback.ts'
import { truncate } from './text.ts'

/** 报告默认标题。 */
const DEFAULT_TITLE = 'CiteLoop 引用校验报告'

/** 草稿默认最多展示多少字（超出截断，防止报告被长文淹没）。 */
const DEFAULT_DRAFT_CHARS = 4000

/**
 * 渲染选项。
 *
 * 全部可选：不带参数时渲染一份“标准报告”（不含草稿原文）。
 */
export interface MarkdownReportOptions {
  /** 报告标题，默认 `CiteLoop 引用校验报告`。 */
  readonly title?: string
  /** 运行模式（`off` / `mark` / `rewrite`），只影响报告抬头的展示文案。 */
  readonly mode?: string
  /** 关键词覆盖率阈值（0~1），写进抬头与失败说明，便于读者判断宽松程度。 */
  readonly coverageThreshold?: number
  /** 是否在末尾附上被校验的草稿原文（默认 `false`，因为草稿可能很长）。 */
  readonly includeDraft?: boolean
  /** 草稿最多保留多少字（默认 4000）。 */
  readonly draftChars?: number
  /** 生成时间；缺省用当前时间（测试可传固定值以获得稳定输出）。 */
  readonly now?: Date
}

/**
 * 单元结论 → 一个图标，用于表格与标题。
 *
 * 图标只做视觉分级，含义由紧随其后的中文标签保证（图标在纯文本环境里不总是可见）。
 *
 * @param status - 单元结论。
 * @returns 一个 emoji 图标，例如 `unsupported` → `❌`。
 * @example
 * statusBadge('supported') // '✅'
 */
function statusBadge(status: UnitStatus): string {
  switch (status) {
    case 'supported':
      return '✅'
    case 'partial':
      return '⚠️'
    case 'unsupported':
      return '❌'
    case 'unreachable':
      return '🔌'
    case 'skipped':
      return '➖'
  }
}

/**
 * 单元结论 → 中文标签（与 `statusBadge()` 一一对应）。
 *
 * @param status - 单元结论。
 * @returns 中文短语，例如 `partial` → `部分支撑`。
 * @example
 * statusLabel('unreachable') // '来源不可达'
 */
function statusLabel(status: UnitStatus): string {
  switch (status) {
    case 'supported':
      return '有支撑'
    case 'partial':
      return '部分支撑'
    case 'unsupported':
      return '无支撑'
    case 'unreachable':
      return '来源不可达'
    case 'skipped':
      return '跳过'
  }
}

/**
 * 来源状态 → 一个图标。
 *
 * @param status - 来源可用性（`SourceDoc.status`）。
 * @returns `✅`（可读）/ `🔌`（抓不到）/ `⚪`（抓到但没正文）。
 * @example
 * sourceBadge('empty') // '⚪'
 */
function sourceBadge(status: SourceDoc['status']): string {
  switch (status) {
    case 'available':
      return '✅'
    case 'unreachable':
      return '🔌'
    case 'empty':
      return '⚪'
  }
}

/** 两位补零，供 `formatTimestamp()` 使用。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 把时间排成 `YYYY-MM-DD HH:mm:ss`（本地时区）。
 *
 * 不用 `toISOString()`：报告是给人读的，读的人关心自己的本地时间；
 * 需要机器解析的场景另有 JSON 报告（三期）。
 *
 * @param date - 生成时间。
 * @returns 本地时区的时间串。
 * @example
 * formatTimestamp(new Date(2026, 10, 26, 16, 30, 0)) // '2026-11-26 16:30:00'
 */
function formatTimestamp(date: Date): string {
  return `${String(date.getFullYear())}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/**
 * 转义 Markdown 表格单元格里的 `|` 与换行。
 *
 * 原句里出现竖线（例如代码片段 `a || b`）会把表格撑坏，
 * 所以单元格一律先压平、再转义。
 *
 * @param text - 原始单元格文本。
 * @returns 单行、`|` 已转义的文本。
 * @example
 * escapeCell('a || b') // 'a \\|\\| b'
 */
function escapeCell(text: string): string {
  return text.replace(/\r?\n/gu, ' ').replace(/\|/gu, '\\|').trim()
}

/**
 * 收集报告里出现过的全部来源，按 `id` 去重并保持首次出现的顺序。
 *
 * 同一份来源可能被多个单元引用（同一篇文档支撑多句陈述），
 * 来源清单只该出现一次；顺序保持“先出现的先列”，与正文阅读顺序一致。
 *
 * @param units - 报告的逐单元结论。
 * @returns 去重后的来源列表（可能为空）。
 * @example
 * uniqueSources(report.units).map((doc) => doc.label) // ['[1] docs', '[2] report']
 */
function uniqueSources(units: readonly UnitVerdict[]): readonly SourceDoc[] {
  const seen = new Map<string, SourceDoc>()
  for (const verdict of units) {
    for (const doc of verdict.unit.sources) {
      if (!seen.has(doc.id)) seen.set(doc.id, doc)
    }
  }
  return [...seen.values()]
}

/**
 * 把单元里的引用标记排成 `[1]、[2]` 形式。
 *
 * @param verdict - 单元结论。
 * @returns 用顿号连接的引用原文；没有引用时返回 `—`。
 * @example
 * citationCell(verdict) // '[1]、[2,3]'
 */
function citationCell(verdict: UnitVerdict): string {
  if (verdict.unit.citations.length === 0) return '—'
  return verdict.unit.citations.map((citation) => `\`${citation.raw}\``).join(' ')
}

/**
 * 把单元失败排成一行中文短语（表格里用）。
 *
 * @param verdict - 单元结论。
 * @returns 形如 `数字在来源中找不到 · 关键词覆盖率不足`；无失败时返回 `—`。
 * @example
 * failureCell(verdict) // '数字在来源中找不到'
 */
function failureCell(verdict: UnitVerdict): string {
  if (verdict.failures.length === 0) return '—'
  return verdict.failures.map((failure) => describeFailure(failure)).join(' · ')
}

/**
 * 渲染“结论”一段：一句话说清过没过、哪几类问题各几个。
 *
 * @param report - 验证报告。
 * @returns Markdown 段落（可能出现 `## 结论` 标题）。
 * @example
 * renderConclusion(report)
 * // ## 结论
 * // **✘ 未通过**：4 个单元中 1 个无支撑、1 个来源不可达。
 */
function renderConclusion(report: VerificationReport): string {
  const { stats } = report
  const lines: string[] = ['## 结论', '']
  if (stats.units === 0) {
    lines.push('**➖ 无可校验单元**：草稿中没有检测到带引用的陈述。')
    return lines.join('\n')
  }
  if (report.allSupported) {
    lines.push(`**✅ 通过**：${String(stats.units)} 个单元全部有来源支撑。`)
    return lines.join('\n')
  }
  const parts: string[] = []
  if (stats.partial > 0) parts.push(`${String(stats.partial)} 个部分支撑`)
  if (stats.unsupported > 0) parts.push(`${String(stats.unsupported)} 个无支撑`)
  if (stats.unreachable > 0) parts.push(`${String(stats.unreachable)} 个来源不可达`)
  lines.push(`**❌ 未通过**：${String(stats.units)} 个单元中 ${parts.join('、')}。`)
  // 引用一条都没解析出来时，问题在“找不到来源”而不是“写歪了”，单独点一句避免误判。
  if (stats.citations > 0 && stats.resolvedCitations === 0) {
    lines.push('')
    lines.push('> 所有引用都没有解析出可读来源：更可能是检索不足，而不是生成不忠实。')
  }
  return lines.join('\n')
}

/**
 * 渲染“统计”表格。
 *
 * 表格而不是列表：读者常拿两份报告对比，对齐的列比散落的句子快得多。
 *
 * @param report - 验证报告。
 * @returns Markdown 表格（含 `## 统计` 标题）。
 * @example
 * renderStatsTable(report)
 * // | 指标 | 数值 |
 * // | --- | --- |
 * // | 句子 / 单元 | 6 / 4 |
 */
function renderStatsTable(report: VerificationReport): string {
  const { stats } = report
  const kinds = Object.entries(stats.byKind)
    .map(([kind, count]) => `\`${kind}\` ×${String(count)}`)
    .join(' · ')
  const lines: string[] = [
    '## 统计',
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    `| 句子 / 单元 | ${String(stats.sentences)} / ${String(stats.units)} |`,
    `| ✅ 有支撑 | ${String(stats.supported)} |`,
    `| ⚠️ 部分支撑 | ${String(stats.partial)} |`,
    `| ❌ 无支撑 | ${String(stats.unsupported)} |`,
    `| 🔌 来源不可达 | ${String(stats.unreachable)} |`,
    `| ➖ 跳过 | ${String(stats.skipped)} |`,
    `| 引用（已解析） | ${String(stats.citations)}（${String(stats.resolvedCitations)}） |`,
    `| 引用密度 | ${report.citationDensity.toFixed(2)} / 千词 |`,
    `| 失败类型 | ${kinds.length === 0 ? '—' : kinds} |`,
  ]
  return lines.join('\n')
}

/**
 * 渲染“单元明细”表格：每个单元一行，覆盖结论、覆盖率、引用与失败类型。
 *
 * 与失败明细的区别：这张表是**全量索引**（含通过的单元），
 * 明细段只展开失败的单元——先看全貌，再看要改的地方。
 *
 * @param report - 验证报告。
 * @returns Markdown 表格（含 `## 单元明细` 标题）。
 * @example
 * renderUnitTable(report)
 * // | 单元 | 结论 | 覆盖率 | 引用 | 失败 |
 * // | --- | --- | --- | --- | --- |
 * // | `u1` | ✅ 有支撑 | 78% | `[1]` | — |
 */
function renderUnitTable(report: VerificationReport): string {
  const lines: string[] = [
    '## 单元明细',
    '',
  ]
  if (report.units.length === 0) {
    lines.push('> 未检测到带引用的陈述，没有可列的单元。')
    return lines.join('\n')
  }
  lines.push('| 单元 | 结论 | 覆盖率 | 引用 | 失败 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const verdict of report.units) {
    const coverage = `${(verdict.coverage * 100).toFixed(0)}%`
    lines.push(
      `| \`${verdict.unit.id}\` | ${statusBadge(verdict.status)} ${statusLabel(verdict.status)} `
      + `| ${coverage} | ${citationCell(verdict)} | ${escapeCell(failureCell(verdict))} |`,
    )
  }
  return lines.join('\n')
}

/**
 * 渲染失败单元明细：原句 + 逐条失败 + 缺失项 + 来源状态。
 *
 * 只展开 `unsupported` / `partial` / `unreachable` 三类：
 * `supported` 没有待修内容，`skipped` 是“内容太少不判定”，都不需要读者关注。
 *
 * @param report - 验证报告。
 * @returns Markdown 段落；没有失败单元时返回“无失败单元”的提示。
 * @example
 * renderFailures(report)
 * // ### `u2` · ❌ 无支撑（覆盖率 21%）
 * // > 原句…
 */
function renderFailures(report: VerificationReport): string {
  const failing = report.units.filter((verdict) => verdict.status === 'unsupported'
    || verdict.status === 'partial'
    || verdict.status === 'unreachable')
  const lines: string[] = ['## 失败明细', '']
  if (failing.length === 0) {
    lines.push('无失败单元。')
    return lines.join('\n')
  }
  for (const verdict of failing) {
    lines.push(`### \`${verdict.unit.id}\` · ${statusBadge(verdict.status)} ${statusLabel(verdict.status)}`
      + `（覆盖率 ${(verdict.coverage * 100).toFixed(0)}%）`)
    lines.push('')
    lines.push(`> ${truncate(verdict.unit.sentence, 400)}`)
    lines.push('')
    for (const failure of verdict.failures) {
      lines.push(`- **${describeFailure(failure)}**（${failure.severity}）：${failure.detail}`)
      if (failure.missing !== undefined && failure.missing.length > 0) {
        const missing = failure.missing.slice(0, 8).map((item) => `\`${item}\``).join('、')
        lines.push(`  - 缺失项：${missing}`)
      }
    }
    if (verdict.unit.sources.length > 0) {
      lines.push('')
      lines.push('引用来源：')
      for (const doc of verdict.unit.sources) {
        const url = doc.url === undefined ? '' : ` · ${doc.url}`
        const error = doc.error === undefined ? '' : `（${doc.error}）`
        lines.push(`- ${sourceBadge(doc.status)} \`${doc.label}\`${url}${error}`)
      }
    }
    if (verdict.evidence.length > 0) {
      lines.push('')
      lines.push('检索期可用证据：')
      for (const doc of verdict.evidence) {
        const url = doc.url === undefined ? '' : ` · ${doc.url}`
        lines.push(`- \`${doc.label}\`${url}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * 渲染来源清单：报告里出现过的每份来源一行，标注可用性与渠道。
 *
 * @param report - 验证报告。
 * @returns Markdown 表格（含 `## 来源清单` 标题）；没有来源时给一句说明。
 * @example
 * renderSources(report)
 * // | 来源 | 状态 | 渠道 | 链接 |
 * // | --- | --- | --- | --- |
 * // | `[1] docs` | ✅ 可用 | reference | https://… |
 */
function renderSources(report: VerificationReport): string {
  const sources = uniqueSources(report.units)
  const lines: string[] = ['## 来源清单', '']
  if (sources.length === 0) {
    lines.push('没有解析出任何来源。')
    return lines.join('\n')
  }
  lines.push('| 来源 | 状态 | 渠道 | 链接 |')
  lines.push('| --- | --- | --- | --- |')
  for (const doc of sources) {
    const status = `${sourceBadge(doc.status)} ${doc.status}`
    const url = doc.url === undefined ? '—' : doc.url
    lines.push(`| \`${escapeCell(doc.label)}\` | ${status} | ${doc.origin} | ${escapeCell(url)} |`)
  }
  return lines.join('\n')
}

/**
 * 渲染草稿附录（折叠块）。
 *
 * 用 `<details>` 折叠：报告的主线是“结论与失败”，原文只作为复核材料，
 * 展开与否交给读者；四反引号围栏避免正文自身的 ``` 提前闭合代码块。
 *
 * @param report - 验证报告。
 * @param chars - 最多保留多少字（超出截断并注明）。
 * @returns Markdown 折叠块（含 `## 附：被校验的草稿` 标题）。
 * @example
 * renderDraft(report, 2000)
 * // <details><summary>展开原文（412 字）</summary>
 * // ````markdown
 * // …
 * // ````
 * // </details>
 */
function renderDraft(report: VerificationReport, chars: number): string {
  const draft = report.draft
  const body = draft.length > chars ? `${truncate(draft, chars)}\n\n…（已截断，原文 ${String(draft.length)} 字）` : draft
  return [
    '## 附：被校验的草稿',
    '',
    `<details><summary>展开原文（${String(draft.length)} 字）</summary>`,
    '',
    '````markdown',
    body,
    '````',
    '',
    '</details>',
  ].join('\n')
}

/**
 * 渲染一份完整的 Markdown 报告。
 *
 * 段落顺序固定：抬头 → 结论 → 统计 → 单元明细 → 失败明细 → 来源清单 →（可选）草稿附录。
 * 前四段回答“过没过、差多少”，中间两段回答“差在哪”，最后一段留给复核。
 *
 * @param report - L3 的验证报告（`verifyText()` 的返回值里的 `report`）。
 * @param options - 渲染选项；全部可选，缺省渲染标准报告（不含草稿）。
 * @returns 一整份 Markdown 文本（含标题行），可直接作为消息正文或写入 `.md` 文件。
 * @example
 * ```ts
 * const { report } = await verifyText(draft, config)
 * const markdown = renderMarkdownReport(report, {
 *   mode: config.mode,
 *   coverageThreshold: config.coverageThreshold,
 *   includeDraft: config.reportIncludeDraft,
 * })
 * // markdown 以 '# CiteLoop 引用校验报告' 开头，之后是结论 / 统计 / 明细 / 来源
 * ```
 */
export function renderMarkdownReport(report: VerificationReport, options: MarkdownReportOptions = {}): string {
  const title = options.title ?? DEFAULT_TITLE
  const draftChars = options.draftChars ?? DEFAULT_DRAFT_CHARS
  const now = options.now ?? new Date()
  const meta: string[] = [`- 生成时间：${formatTimestamp(now)}`]
  if (options.mode !== undefined) {
    const threshold = options.coverageThreshold === undefined
      ? ''
      : `（覆盖率阈值 ${options.coverageThreshold.toFixed(2)}）`
    meta.push(`- 运行模式：\`${options.mode}\`${threshold}`)
  }
  meta.push(`- 被校验草稿：${String(report.draft.length)} 字 · 句子 ${String(report.stats.sentences)} 句`)

  const lines: string[] = [
    `# ${title}`,
    '',
    ...meta,
    '',
    renderConclusion(report),
    '',
    renderStatsTable(report),
    '',
    renderUnitTable(report),
    '',
    renderFailures(report),
    '',
    renderSources(report),
  ]
  if (options.includeDraft === true) {
    lines.push('', renderDraft(report, draftChars))
  }
  lines.push('', '---', '', '> 由 CiteLoop 本地确定性生成（数字 / 专名 / 关键词覆盖率 / 引用指向性四类检查），未调用任何外部模型。')
  return lines.join('\n')
}
