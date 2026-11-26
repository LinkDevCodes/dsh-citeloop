/**
 * L3 关键词层：陈述与来源的词汇重叠度。
 *
 * 四层流水线中的位置：L3 验证层的中间一道检查，由 `verify.ts` 的 `verifyUnit()`
 * 对每份可读来源调用一次；它在锚定之前跑，用于先回答“这段来源和这句陈述是不是同一件事”。
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
 * 判为 `major` 而不是 `critical`：覆盖率低说明“来源与陈述大概不是一回事”，
 * 但分词的粒度（尤其中文 bigram）和表述改写都可能压低分数，误判代价是让模型白改一遍；
 * 因此和专名缺失同级——阻断通过但不强制重写，`mark` 模式下只提示。
 * `missing` 只截前 8 个词元，反馈包要能逐项点名，但不能让一条失败淹没整份反馈。
 *
 * @param coverage - `coverageOf()` 的结果，`coverage` 取值 0~1。
 * @param config - 提供 `coverageThreshold`（默认 0.35，即陈述词元至少三成五出现在来源里）。
 * @returns 覆盖率达标时返回 `undefined`；否则返回 `keyword-overlap-low` 失败（severity 为 major）。
 * @example
 * import { DEFAULT_CONFIG } from './config.ts'
 * import { checkOverlap } from './overlap.ts'
 *
 * const coverage = { coverage: 0.2, shared: ['bert'], missing: ['预训练', '微调'], claimTokens: 4 }
 * checkOverlap(coverage, DEFAULT_CONFIG)
 * // 预期：{ kind: 'keyword-overlap-low', severity: 'major',
 * //         detail: '关键词覆盖率 20% 低于阈值 35%', missing: ['预训练', '微调'] }
 * checkOverlap({ ...coverage, coverage: 0.8 }, DEFAULT_CONFIG) // 预期：undefined
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
