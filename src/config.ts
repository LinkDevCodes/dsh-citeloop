/**
 * 插件配置（schemastery）。
 *
 * DSH 的约定：插件的可调参数必须通过 Config schema 校验，不能散落在代码里当魔法数字。
 * 这里每个字段都带 `.default()`，因此 cordis.yml 里只写关心的几项即可。
 *
 * 注意 `mode`：schema 上声明为 string，真正的取值校验放在 `resolveConfig()`，
 * 这样非法取值会退化成安全的 'mark' 并打一条 warn，而不是让插件装配失败。
 *
 * 流水线位置：本文件是 **L4 决策层** 的入口护栏——所有阈值/开关都在这里归一化，
 * L2 解析层与 L3 验证层只读取解析后的值，不再各自兜底。
 */
import z from '@deepseek-ai/schemastery'

/** 运行模式。 */
export type Mode =
  /** 完全关闭：钩子只记录统计，不做任何判定 */
  | 'off'
  /** 只标记（默认）：把验证结论打进控制台日志，不阻断、不重写 */
  | 'mark'
  /** 重写闭环：不通过的草稿退回给模型，附带结构化反馈 */
  | 'rewrite'

/** 用户可见的配置对象。 */
export interface Config {
  /** `off` | `mark` | `rewrite`；非法值由 `resolveConfig()` 退化为 `mark`。 */
  mode: string
  /** 是否在控制台输出逐层日志（L1 触发 / L2 解析 / L3 验证 / L4 决策）。 */
  verbose: boolean
  /** `rewrite` 模式下最多重写几次（默认 2：多数冲突在 2 轮内收敛）。 */
  maxAttempts: number
  /** 关键词覆盖率阈值（0~1）：低于它判定 `keyword-overlap-low`。 */
  coverageThreshold: number
  /** 数字锚定是否严格：true 时带小数的数值必须逐位一致，false 时允许四舍五入后的近似。 */
  strictNumbers: boolean
  /** 是否要求“有结论的句子必须带引用”；true 时无引用的陈述记为 `no-source`。 */
  requireCitations: boolean
  /** 单元词元数下限：低于它的短句（“是的”“如上所述”）不参与判定，避免假阳性。 */
  minUnitTokens: number
  /** 单个来源正文的最大字符数（超过截断）。 */
  maxSourceChars: number
  /** 抓取单个来源的超时毫秒数。 */
  fetchTimeoutMs: number
  /** 单次回合内最多抓取多少个来源（成本/延迟护栏）。 */
  maxFetchPerTurn: number
  /** 哪些工具的输出可以被当作“检索证据”回收（默认覆盖常见检索类工具）。 */
  retrievalTools: string[]
  /** 连续两次失败单元的 Jaccard 超过它 → `unstable-iteration` 熔断。 */
  unitJaccardStop: number
  /** 引用密度跌到首轮的该比例以下 → `citation-collapse` 熔断（防止靠删引用过关）。 */
  citationCollapseRatio: number
  /**
   * `/citeloop-report` 生成的 Markdown 报告是否在末尾附上“被校验的草稿原文”。
   *
   * 默认 `false`：报告的主线是结论与失败项，草稿只作复核材料；
   * 需要把报告当评审证据存档时打开，原文会放进可折叠的 `<details>` 块里。
   */
  reportIncludeDraft: boolean
}

/** schemastery 配置 schema：cordis.yml 的 `config:` 与它做校验。 */
export const Config: z<Config> = z.object({
  mode: z.string().default('mark').description('运行模式：off / mark / rewrite'),
  verbose: z.boolean().default(true).description('输出逐层控制台日志'),
  maxAttempts: z.natural().default(2).description('rewrite 模式下的最大重写次数'),
  coverageThreshold: z.percent().default(0.35).description('关键词覆盖率阈值'),
  strictNumbers: z.boolean().default(false).description('数字锚定严格模式'),
  requireCitations: z.boolean().default(false).description('是否强制要求引用'),
  minUnitTokens: z.natural().default(4).description('参与判定的最小词元数'),
  maxSourceChars: z.natural().default(60_000).description('单个来源正文最大字符数'),
  fetchTimeoutMs: z.natural().default(12_000).description('抓取超时（毫秒）'),
  maxFetchPerTurn: z.natural().default(12).description('每回合最多抓取来源数'),
  retrievalTools: z
    .array(z.string())
    .default(['web_search', 'web_fetch', 'search', 'fetch', 'browse'])
    .description('可回收为证据的检索类工具名'),
  unitJaccardStop: z.percent().default(0.85).description('失败单元相似度熔断阈值'),
  citationCollapseRatio: z.percent().default(0.5).description('引用密度坍缩比例阈值'),
  reportIncludeDraft: z.boolean().default(false).description('Markdown 报告是否附上草稿原文'),
})

/** 已解析、已归一化的配置（值域被钳制过）。 */
export interface ResolvedConfig extends Omit<Config, 'mode' | 'retrievalTools'> {
  /** 已校验的运行模式，保证只会是 `Mode` 中的值。 */
  readonly mode: Mode
  /** 归一化后冻结的列表（去重、非空）。 */
  readonly retrievalTools: readonly string[]
}

/** 默认值；`resolveConfig()` 在缺省时用它兜底。 */
export const DEFAULT_CONFIG: ResolvedConfig = Object.freeze({
  mode: 'mark',
  verbose: true,
  maxAttempts: 2,
  coverageThreshold: 0.35,
  strictNumbers: false,
  requireCitations: false,
  minUnitTokens: 4,
  maxSourceChars: 60_000,
  fetchTimeoutMs: 12_000,
  maxFetchPerTurn: 12,
  retrievalTools: Object.freeze(['web_search', 'web_fetch', 'search', 'fetch', 'browse']),
  unitJaccardStop: 0.85,
  citationCollapseRatio: 0.5,
  reportIncludeDraft: false,
})

/**
 * 把任意值钳制到闭区间。
 *
 * 非有限数（NaN / Infinity）直接回退到 fallback，而不是抛错——
 * 配置写坏只应让行为退化，不应让插件装配失败。
 *
 * @param value - 待钳制的数值，可能是 `NaN` 或 `Infinity`。
 * @param min - 允许的下界（含）。
 * @param max - 允许的上界（含）。
 * @param fallback - `value` 非有限数时使用的默认值。
 * @returns 落在 `[min, max]` 内的有限数，或 `fallback`。
 * @example
 * ```ts
 * // 本文件内可直接调用（未导出）
 * clamp(99, 0, 5, 2) // => 5
 * clamp(Number.NaN, 0, 5, 2) // => 2
 * ```
 */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

/**
 * 校验并归一化运行模式。
 *
 * 非法取值不抛错，而是退回默认的 `mark`，由 `resolveConfig()` 负责告警。
 *
 * @param value - 用户传入的任意值（`cordis.yml` 里可能是任意字符串）。
 * @returns 合法的 `Mode`；无法识别时返回 `DEFAULT_CONFIG.mode`。
 * @example
 * ```ts
 * // 本文件内可直接调用（未导出）
 * resolveMode('rewrite') // => 'rewrite'
 * resolveMode('strict') // => 'mark'
 * ```
 */
function resolveMode(value: unknown): Mode {
  if (value === 'off' || value === 'mark' || value === 'rewrite') return value
  return DEFAULT_CONFIG.mode
}

/**
 * 允许传进 `resolveConfig()` 的配置形状。
 *
 * `retrievalTools` 放宽成 `readonly string[]`：`DEFAULT_CONFIG` 是冻结的，
 * 调用方（以及测试）会把 `ResolvedConfig` 再传回来做“改一个字段”的派生。
 */
export type ConfigInput = Partial<Omit<Config, 'retrievalTools'>> & {
  /** 可选的检索工具名列表；为空数组时退回默认列表。 */
  readonly retrievalTools?: readonly string[]
}

/**
 * 把（可能不完整的）配置归一化成 `ResolvedConfig`。
 *
 * 归一化而不是抛错：插件装配失败会让整个 DSH 起不来，
 * 而“阈值写错”这种问题应该表现为行为退化为默认值 + 一条 warn。
 *
 * @param raw - cordis 传入的配置（可能缺字段、可能有越界值）；`undefined` 视为全默认。
 * @param onWarn - 可选的告警回调，便于把降级原因报告给用户；缺省时静默。
 * @returns 已钳制、统一为只读形态的 `ResolvedConfig`。
 * @example
 * ```ts
 * import { resolveConfig } from './config'
 * const cfg = resolveConfig({ mode: 'rewrite', maxAttempts: 3 }, (msg) => console.warn(msg))
 * cfg.mode // => 'rewrite'
 * cfg.maxAttempts // => 3
 * resolveConfig({ mode: 'strict' }, (msg) => console.warn(msg)).mode // => 'mark'（并触发告警）
 * resolveConfig({ maxAttempts: 99 }).maxAttempts // => 5（被钳到上界）
 * ```
 */
export function resolveConfig(
  raw: ConfigInput | undefined,
  onWarn?: (message: string) => void,
): ResolvedConfig {
  const warn = onWarn ?? (() => {})
  const source = raw ?? {}
  const mode = resolveMode(source.mode)
  if (source.mode !== undefined && source.mode !== mode) {
    warn(`未知的 mode "${String(source.mode)}"，已退回 mark`)
  }
  return Object.freeze({
    mode,
    verbose: source.verbose ?? DEFAULT_CONFIG.verbose,
    maxAttempts: Math.round(clamp(source.maxAttempts ?? NaN, 0, 5, DEFAULT_CONFIG.maxAttempts)),
    coverageThreshold: clamp(source.coverageThreshold ?? NaN, 0, 1, DEFAULT_CONFIG.coverageThreshold),
    strictNumbers: source.strictNumbers ?? DEFAULT_CONFIG.strictNumbers,
    requireCitations: source.requireCitations ?? DEFAULT_CONFIG.requireCitations,
    // 下限 2：只有一个词元时覆盖率非 0 即 1，判定毫无意义。
    minUnitTokens: Math.round(clamp(source.minUnitTokens ?? NaN, 2, 200, DEFAULT_CONFIG.minUnitTokens)),
    maxSourceChars: Math.round(clamp(source.maxSourceChars ?? NaN, 500, 2_000_000, DEFAULT_CONFIG.maxSourceChars)),
    fetchTimeoutMs: Math.round(clamp(source.fetchTimeoutMs ?? NaN, 500, 120_000, DEFAULT_CONFIG.fetchTimeoutMs)),
    maxFetchPerTurn: Math.round(clamp(source.maxFetchPerTurn ?? NaN, 0, 100, DEFAULT_CONFIG.maxFetchPerTurn)),
    retrievalTools: Array.isArray(source.retrievalTools) && source.retrievalTools.length > 0
      ? Object.freeze([...new Set(source.retrievalTools.map((name) => String(name)))])
      : DEFAULT_CONFIG.retrievalTools,
    unitJaccardStop: clamp(source.unitJaccardStop ?? NaN, 0.1, 1, DEFAULT_CONFIG.unitJaccardStop),
    citationCollapseRatio: clamp(source.citationCollapseRatio ?? NaN, 0, 1, DEFAULT_CONFIG.citationCollapseRatio),
    reportIncludeDraft: source.reportIncludeDraft ?? DEFAULT_CONFIG.reportIncludeDraft,
  })
}
