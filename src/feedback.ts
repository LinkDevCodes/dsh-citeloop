/**
 * 反馈包构造器：把结构化的 `Failure[]` 翻译成模型能执行的重写指令。
 *
 * 四层流水线位置：L4（决策层）的配套模块。`decide()` 判定 `rewrite` 时调用它
 * 生成注入模型的反馈正文；本身不改判定，只负责“把失败说清楚”。
 *
 * 方案书对这一层的要求是「**结构化失败信号**」而不是一句“请核对引用”：
 * 每个失败单元要写清是哪一句、哪类失败、缺了哪个数字/专名/关键词，
 * 并把检索期真正可用的证据片段贴出来，让重写有据可依。
 *
 * 这不是“再问一次模型”，而是一次带约束的定点修复。
 */
import type { Failure, SourceDoc, VerificationReport } from './types.ts'
import type { ResolvedConfig } from './config.ts'
import { coverageOf, truncate } from './text.ts'
import { failingVerdicts } from './verify.ts'

/**
 * 把失败类型枚举翻译成面向模型/用户的中文短语。
 *
 * `switch` 覆盖 `FailKind` 的全部取值：增删失败类型时这里会一起暴露，
 * 保证反馈与日志不会出现“未知失败”这种最难排查的输出。
 *
 * @param failure - 结构化失败信号；只用 `kind` 字段。
 * @returns 对应的中文短语，例如 `numeric-missing` → “数字在来源中找不到”。
 * @example
 * describeFailure({ kind: 'entity-missing', severity: 'critical', detail: '未找到“PaLM”' })
 * // '专名在来源中找不到'
 */
export function describeFailure(failure: Failure): string {
  switch (failure.kind) {
    case 'no-source':
      return '找不到来源'
    case 'source-unreachable':
      return '来源无法访问'
    case 'source-empty':
      return '来源没有正文'
    case 'numeric-missing':
      return '数字在来源中找不到'
    case 'entity-missing':
      return '专名在来源中找不到'
    case 'keyword-overlap-low':
      return '关键词覆盖率不足'
    case 'citation-mismatch':
      return '引用指向错配'
  }
}


/**
 * 从候选来源里挑出与陈述最匹配的一份。
 *
 * 只接受覆盖率 ≥ `coverageThreshold` 的材料：把弱相关片段贴给模型，
 * 等于暗示“这段可以当依据”，反而会诱发新的编造。
 *
 * @param prose - 陈述正文（已去掉引用标记），用于计算关键词覆盖率。
 * @param evidence - 候选来源；`text` 为空的条目跳过，避免贴出空证据。
 * @param config - 配置；用 `coverageThreshold`（0~1）过滤不合格片段。
 * @returns 覆盖率最高且达标的来源；没有达标项时为 `undefined`。
 * @example
 * const doc = bestEvidence(verdict.unit.prose, evidence, config)
 * // 命中时 doc.label 形如 'web_search'；未命中时为 undefined
 */
function bestEvidence(prose: string, evidence: readonly SourceDoc[], config: ResolvedConfig): SourceDoc | undefined {
  let best: SourceDoc | undefined
  let bestCoverage = 0
  for (const doc of evidence) {
    if (doc.text.trim().length === 0) continue
    const coverage = coverageOf(prose, doc.text).coverage
    if (coverage > bestCoverage && coverage >= config.coverageThreshold) {
      best = doc
      bestCoverage = coverage
    }
  }
  return best
}

/**
 * 构造重写反馈包。
 *
 * 输出是一段可直接作为消息正文的 Markdown：逐单元给出原句、失败类型与缺失项，
 * 再贴一份达标证据；最后用“硬性要求”把重写边界钉死（只改指定句、禁止删引用换笼统说法）。
 * 之所以逐条点名而不是给总结：模型对“具体哪句、缺什么”的修复成功率远高于泛泛的“请核对”。
 *
 * @param report - 本次验证报告；失败单元由 `failingVerdicts()` 过滤。
 * @param evidence - 检索期捕获的证据；与单元自身证据合并后择优。
 * @param config - 配置（用于证据筛选阈值与片段长度）。
 * @returns 可直接作为消息正文的指令文本，以“【引用校验未通过】”开头。
 * @example
 * const feedback = buildFeedback(report, evidence, config)
 * // feedback 首行为“【引用校验未通过】…”，随后逐单元列出原句、失败项与可用证据；
 * // 直接作为下一条消息正文喂回模型即可触发定点重写
 */
export function buildFeedback(
  report: VerificationReport,
  evidence: readonly SourceDoc[],
  config: ResolvedConfig,
): string {
  const failing = failingVerdicts(report)
  const lines: string[] = []
  lines.push('【引用校验未通过】上一版回答中有陈述无法被其引用来源支撑。请**只重写下列句子**，不要改动其余内容。')
  lines.push('')
  for (const verdict of failing) {
    lines.push(`### ${verdict.unit.id}（原句）`)
    lines.push(`> ${truncate(verdict.unit.sentence, 400)}`)
    for (const failure of verdict.failures) {
      const missing = failure.missing === undefined || failure.missing.length === 0
        ? ''
        : `；缺失项：${failure.missing.slice(0, 8).join('、')}`
      lines.push(`- ${describeFailure(failure)}（${failure.severity}）：${failure.detail}${missing}`)
    }
    if (verdict.status === 'unreachable') {
      lines.push('- 处理要求：该来源本轮确实取不到。请把它替换成检索上下文里可用的来源，或删除这条陈述。')
    }
    const doc = bestEvidence(verdict.unit.prose, [...evidence, ...verdict.evidence], config)
    if (doc !== undefined) {
      lines.push(`- 可用证据（${doc.label}）：`)
      lines.push(`  ${truncate(doc.text, 600)}`)
    } else {
      lines.push('- 可用证据：无。请删除这条陈述，不要凭记忆补全。')
    }
    lines.push('')
  }
  lines.push('### 硬性要求')
  lines.push('1. 只重写上面列出的句子；其余段落原样保留，不要重新组织全文。')
  lines.push('2. 改写后的每个事实性表述都必须能在「可用证据」或原有引用来源中逐字找到依据。')
  lines.push('3. 证据不足时删除该陈述，**禁止**用更笼统的说法掩盖，也禁止新增未经验证的引用标记。')
  lines.push('4. 数字（年份、百分比、样本量、页码）与专名必须与来源一致，不得四舍五入或改写。')
  lines.push('5. 不要解释这次修改，直接输出修订后的完整回答。')
  return lines.join('\n')
}
