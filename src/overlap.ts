/**
 * L3 关键词层：陈述与来源的词汇重叠度。
 *
 * 用**覆盖率**（陈述词元被来源覆盖的比例）而不是对称相似度：
 * 来源通常比一句陈述长得多，Jaccard 会被来源长度稀释，
 * 导致“高度相关的整页文档”反而得分很低（ProofRAG 的结论）。
 *
 * 这一层是唯一需要阈值的检查，因此也是假阳性的主要来源：
 * 阈值必须可配，且未通过时优先只标记（`mode: mark`）。
 */
import type { Failure } from './types.ts'
import type { ResolvedConfig } from './config.ts'
import type { Coverage } from './text.ts'

/**
 * 根据覆盖率生成失败信号。
 *
 * @param coverage - `coverageOf()` 的结果。
 * @param config - 提供 `coverageThreshold`。
 * @returns 覆盖率达标时返回 undefined。
 */
export function checkOverlap(coverage: Coverage, config: ResolvedConfig): Failure | undefined {
  if (coverage.coverage >= config.coverageThreshold) return undefined
  return {
    kind: 'keyword-overlap-low',
    severity: 'major',
    detail: `关键词覆盖率 ${(coverage.coverage * 100).toFixed(0)}% 低于阈值 ${(config.coverageThreshold * 100).toFixed(0)}%`,
    missing: coverage.missing.slice(0, 8),
  }
}
