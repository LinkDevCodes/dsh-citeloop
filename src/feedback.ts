/**
 * 反馈包构造器：把结构化的 `Failure[]` 翻译成模型能执行的重写指令。
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

/** 可读的失败类型名，用于反馈与日志。 */
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
 * @param report - 本次验证报告。
 * @param evidence - 检索期捕获的证据。
 * @param config - 配置（用于证据筛选阈值与片段长度）。
 * @returns 可直接作为消息正文的指令文本。
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
