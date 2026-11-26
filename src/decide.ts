/**
 * L4 决策层：把验证报告翻译成**一个动作**。
 *
 * 四个动作与方案书的表一一对应：
 *   - `pass`      全部通过（或没有可验证内容）
 *   - `annotate`  只标记：有问题，但不值得（或不被允许）打断用户
 *   - `rewrite`   退回重生成：返回具体失败单元 + 可用证据，要求定点重写
 *   - `abort`     熔断：带原因终止，并区分“生成不忠实”与“检索不足”
 *
 * 之所以把“上次失败的词元”“上次引用密度”作为输入，是因为
 * 熔断判据天然是跨轮次的：单次报告看不出模型是不是在原地打转，
 * 也看不出它是不是靠删引用规避检查。
 */
import type { Decision, SourceDoc, VerificationReport } from './types.ts'
import type { ResolvedConfig } from './config.ts'
import { failingVerdicts, failureTokens } from './verify.ts'
import { coverageOf, jaccard } from './text.ts'
import { buildFeedback } from './feedback.ts'

/** 上一次尝试留下的记忆，用于收敛与规避检测。 */
export interface AttemptMemory {
  /** 上次失败单元的词元集合。 */
  readonly tokens: readonly string[]
  /** 上次报告的引用密度（每千词引用数）。 */
  readonly density: number
  /** 已经发起过几次重写。 */
  readonly rewrites: number
}

/** 决策所需的全部输入。 */
export interface DecideInput {
  readonly report: VerificationReport
  readonly config: ResolvedConfig
  /** 检索期捕获的证据，用于判断“是生成不忠实还是检索不足”。 */
  readonly evidence: readonly SourceDoc[]
  readonly previous?: AttemptMemory | undefined
}

/**
 * 判断一个失败单元是否“有希望被重写修好”。
 *
 * 判据：检索上下文里存在一份材料，其与陈述的覆盖率已达到阈值。
 * 满足 → 模型其实拿得到材料，只是没写对（生成不忠实，值得重写）；
 * 不满足 → 材料本身就没有，重写只会让它编（检索不足，应直接报告）。
 */
function hasUsableEvidence(report: VerificationReport, evidence: readonly SourceDoc[], config: ResolvedConfig): boolean {
  const failing = failingVerdicts(report)
  if (failing.length === 0) return false
  for (const verdict of failing) {
    if (verdict.status === 'unreachable') continue
    const candidates = [...evidence, ...verdict.evidence]
    for (const doc of candidates) {
      if (doc.text.trim().length === 0) continue
      if (coverageOf(verdict.unit.prose, doc.text).coverage >= config.coverageThreshold) return true
    }
  }
  return false
}

/**
 * 做出决策。
 *
 * 判断顺序是有意安排的：先处理“根本没坏”的情况，再处理规避与不收敛，
 * 最后才决定是否重写——避免在不该重试的时候重试。
 */
export function decide(input: DecideInput): Decision {
  const { report, config, evidence, previous } = input
  if (config.mode === 'off') {
    return { kind: 'pass', reason: 'mode=off，未启用校验' }
  }
  // 没有任何带引用的陈述：要么这篇回答不需要引用，要么作者一个引用都没写。
  if (report.units.length === 0) {
    if (config.requireCitations && report.stats.citations === 0) {
      return {
        kind: 'abort',
        cause: 'citation-collapse',
        reason: 'requireCitations 已开启，但草稿里没有任何引用标记',
      }
    }
    return { kind: 'pass', reason: '草稿不含带引用的陈述，无需校验' }
  }
  if (report.allSupported) {
    return { kind: 'pass', reason: `全部 ${String(report.stats.supported)} 条陈述均通过确定性校验` }
  }
  // 规避检测：引用密度相比上一轮腰斩，说明它是靠“删引用”而不是“修内容”通过的。
  if (previous !== undefined && previous.density > 0.05) {
    const collapsed = report.citationDensity < previous.density * config.citationCollapseRatio
    if (collapsed) {
      return {
        kind: 'abort',
        cause: 'citation-collapse',
        reason: `引用密度从 ${previous.density.toFixed(2)} 骤降到 ${report.citationDensity.toFixed(2)}（每千词），疑似删除引用规避校验`,
      }
    }
  }
  const tokens = failureTokens(report)
  if (previous !== undefined) {
    // 收敛检测：失败单元几乎没变，再重写也是重复劳动。
    const similarity = jaccard(previous.tokens, tokens)
    if (similarity > config.unitJaccardStop) {
      return {
        kind: 'abort',
        cause: 'unstable-iteration',
        reason: `连续两次失败单元相似度 ${(similarity * 100).toFixed(0)}%，超过熔断阈值 ${(config.unitJaccardStop * 100).toFixed(0)}%`,
      }
    }
    if (previous.rewrites >= config.maxAttempts) {
      return {
        kind: 'abort',
        cause: 'attempts-exhausted',
        reason: `已重写 ${String(previous.rewrites)} 次仍未通过（上限 ${String(config.maxAttempts)} 次）`,
      }
    }
  }
  if (!hasUsableEvidence(report, evidence, config)) {
    return {
      kind: 'abort',
      cause: 'insufficient-retrieval',
      reason: '失败陈述在检索上下文与已引用来源中都找不到足够材料，重写只会产生无依据内容',
    }
  }
  if (config.mode === 'mark') {
    return { kind: 'annotate', reason: 'mode=mark，仅标记不拦截' }
  }
  if (config.maxAttempts === 0) {
    return { kind: 'abort', cause: 'unfaithful', reason: 'maxAttempts=0，禁止重写；草稿存在无支撑陈述' }
  }
  return {
    kind: 'rewrite',
    reason: `存在 ${String(report.stats.unsupported + report.stats.unreachable)} 条无支撑陈述，退回定点重写`,
    feedback: buildFeedback(report, evidence, config),
  }
}
