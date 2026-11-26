/**
 * CiteLoop 的核心数据契约。
 *
 * 这一层刻意只放**类型和常量**，不引入任何宿主（cordis / DSH）运行期依赖，
 * 于是 L2 解析层、L3 验证层、L4 决策层都可以脱离 harness 单独加载与测试
 * （见 scripts/selftest.ts）。
 *
 * 四层流水线对应的结构：
 *   L1 触发层：从会话里取到“草稿文本” + 检索期捕获的来源片段
 *   L2 解析层：Draft → Citation[] / SourceDoc[] / ClaimUnit[]
 *   L3 验证层：ClaimUnit[] → UnitVerdict[]（每条 verdict 带一组结构化 Failure）
 *   L4 决策层：VerificationReport + 重试记忆 → Decision（放行/标记/重写/熔断）
 *
 * 本文件在流水线中的位置：它不属于任何单层，而是 L2 → L3 → L4 之间传递的公共语言——
 * 解析层按这里的形状产出，验证层按这里的形状判定，决策层按这里的形状决策。
 */

/**
 * 引用的形态。
 * - `numeric`       编号引用：`[1]`、`[2,3]`、`[4-6]`
 * - `author-year`   作者-年份引用：`(Smith, 2020)`、`Smith (2020)`
 * - `url`           正文内联 URL：`https://example.com/a`
 * - `doi`           DOI：`10.1145/3290605.3300233`
 * - `arxiv`         arXiv 标识：`arXiv:2101.00001`
 */
export type CitationKind = 'numeric' | 'author-year' | 'url' | 'doi' | 'arxiv'

/**
 * 来源从哪儿来（决定取正文的方式）。
 * - `reference`    文末参考列表里的一条 `[n] ...`
 * - `inline-url`   正文里出现的内联链接
 * - `doi` / `arxiv` DOI、arXiv 标识推导出的规范 URL
 * - `retrieval`    本轮对话中检索类工具（web_search / web_fetch 等）返回的片段
 */
export type SourceOrigin = 'reference' | 'inline-url' | 'doi' | 'arxiv' | 'retrieval'

/**
 * 来源可用性。注意：**“取不到”本身就是一个可报告的失败信号**，
 * 而不是“无法验证所以跳过”——这是本插件与多数“引用检查器”的关键区别之一。
 */
export type SourceStatus = 'available' | 'unreachable' | 'empty'

/** 一份可用于比对陈述的来源。 */
export interface SourceDoc {
  /** 稳定标识：`#1`（编号引用）、原始 URL、`doi:...`、`arxiv:...`、`tool:<callId>`。 */
  readonly id: string
  /** 展示用短标签（标题 / 引用条目 / 工具名 + 摘要）。 */
  readonly label: string
  /** 可抓取的 URL；纯文本片段（检索结果）没有。 */
  readonly url?: string
  /** 来源正文（已清洗 HTML、已截断）；抓取失败时为空串。 */
  readonly text: string
  /** 来源渠道：决定“正文从哪来”，见 {@link SourceOrigin}。 */
  readonly origin: SourceOrigin
  /** 获取时间戳（毫秒），用于 TTL/去重与调试。 */
  readonly retrievedAt: number
  /** 可用性：正文是否真的拿到了。 */
  readonly status: SourceStatus
  /** 失败原因（HTTP 状态码、超时、空正文等）。 */
  readonly error?: string
}

/** 正文中的一处引用标记。 */
export interface Citation {
  /** 原文命中片段，例如 `[1]`、`(Smith, 2020)`。 */
  readonly raw: string
  /** 引用形态，决定 `marker` 怎么归一化。 */
  readonly kind: CitationKind
  /**
   * 归一化后的解析标识：
   * - numeric → 数字字符串 `1`
   * - author-year → `smith2020`
   * - url → 原始 URL
   * - doi → DOI 字符串
   * - arxiv → arXiv 编号
   */
  readonly marker: string
  /** 在草稿全文中的字符偏移（含头不含尾），用于绑定到句子。 */
  readonly start: number
  /** 在草稿全文中的结束偏移（不含），`raw` 对应 `draft.slice(start, end)`。 */
  readonly end: number
}

/**
 * 失败类型。L4 的反馈包会按类型生成不同的修复指令，
 * 所以类型必须是稳定、可枚举的，不能只写一句自然语言原因。
 */
export type FailKind =
  /** 引用了编号/作者，但文末参考列表或检索片段里找不到对应来源 */
  | 'no-source'
  /** 来源存在，但网络抓取失败（DNS/超时/HTTP 4xx-5xx） */
  | 'source-unreachable'
  /** 抓取成功，但正文为空（付费墙、纯 JS 渲染、反爬页） */
  | 'source-empty'
  /** 数字锚定缺失：年份、百分比、样本量、页码等未出现在来源中 */
  | 'numeric-missing'
  /** 实体锚定缺失：缩写、专名、数据集名等未出现在来源中 */
  | 'entity-missing'
  /** 关键词覆盖率低于阈值（来源与陈述“大概不是一回事”） */
  | 'keyword-overlap-low'
  /** 引用错配：来源主题与陈述完全不同，或来源中根本没有被引用的作者 */
  | 'citation-mismatch'

/** 失败严重程度：critical 直接判定“无支撑”，major 判定“部分支撑”，minor 只用于提示。 */
export type Severity = 'critical' | 'major' | 'minor'

/** 一条可回传给模型的结构化失败信号。 */
export interface Failure {
  /** 失败类型，决定反馈包里生成哪一条修复指令。 */
  readonly kind: FailKind
  /** 严重程度，决定单元最终落到 supported / partial / unsupported。 */
  readonly severity: Severity
  /** 面向模型/用户的确定性描述（不含主观判断词）。 */
  readonly detail: string
  /** 具体缺失的锚点（数字、实体、关键词），用于反馈包逐项点名。 */
  readonly missing?: readonly string[]
}

/**
 * 一个“陈述-引用”单元：句子里出现的所有引用，以及这些引用能解析出的来源。
 *
 * 方案书要求“一条陈述对应多个来源时拆成多个单元”，这里的实现方式是
 * **一个单元持有多份来源**，并在验证时按来源逐一比对、取最好的一份作为结论，
 * 这样既避免了单元爆炸，又能精确定位“是哪个来源不支撑”。
 */
export interface ClaimUnit {
  /** 单元编号 `u1`、`u2`…，出现在反馈包里，方便模型定位句子。 */
  readonly id: string
  /** 单元对应的原句（已 trim）。 */
  readonly sentence: string
  /** 原句去掉引用标记后的正文：关键词覆盖率、锚点都比它，避免引用数字污染判定。 */
  readonly prose: string
  /** 句子在草稿中的偏移区间（含头不含尾）。 */
  readonly start: number
  /** 句子在草稿中的结束偏移（不含）。 */
  readonly end: number
  /** 绑定到该句的引用（可能为空：整段无引用的陈述不进入校验）。 */
  readonly citations: readonly Citation[]
  /** 引用解析出的来源；抓取后回填正文。 */
  readonly sources: readonly SourceDoc[]
}

/** 单元结论。 */
export type UnitStatus =
  /** 所有确定性检查通过 */
  | 'supported'
  /** 只有 minor 级问题，判定“部分支撑” */
  | 'partial'
  /** 存在 critical/major 级问题，判定“无支撑” */
  | 'unsupported'
  /** 引用的来源一个都取不到（不是“无支撑”，而是“无法验证”） */
  | 'unreachable'
  /** 可验证内容太少（短句、纯过渡句），不参与判定 */
  | 'skipped'

/** 单个单元的验证结果。 */
export interface UnitVerdict {
  /** 被验证的单元本身（含句子、引用与来源）。 */
  readonly unit: ClaimUnit
  /** 该单元的最终结论。 */
  readonly status: UnitStatus
  /** 导致该结论的结构化失败；`supported` 时为空数组。 */
  readonly failures: readonly Failure[]
  /** 最好的那份来源的关键词覆盖率（0~1），用于排序与灰区判断。 */
  readonly coverage: number
  /** 失败时从检索上下文里找到的可用证据（供重写使用），可能为空。 */
  readonly evidence: readonly SourceDoc[]
}

/** 整篇草稿的统计量。 */
export interface VerificationStats {
  /** 参与判定的句子总数（含被跳过的单元）。 */
  readonly sentences: number
  /** 携带引用的单元数。 */
  readonly units: number
  /** 判定为“有支撑”的单元数。 */
  readonly supported: number
  /** 判定为“部分支撑”的单元数。 */
  readonly partial: number
  /** 判定为“无支撑”的单元数。 */
  readonly unsupported: number
  /** 判定为“无法验证”（来源全部不可达）的单元数。 */
  readonly unreachable: number
  /** 判定为“跳过”（有效词元太少）的单元数。 */
  readonly skipped: number
  /** 草稿中的引用标记总数。 */
  readonly citations: number
  /** 至少解析出一份来源的引用数。 */
  readonly resolvedCitations: number
  /** 按失败类型聚合的计数，反馈包用它决定修复指令。 */
  readonly byKind: Readonly<Record<string, number>>
}

/** L3 的完整输出。 */
export interface VerificationReport {
  /** 被验证的草稿全文（L4 重写时以它为基准比对）。 */
  readonly draft: string
  /** 逐单元的验证结论，按草稿出现顺序排列。 */
  readonly units: readonly UnitVerdict[]
  /** 整篇统计量，供决策层做阈值判断与日志输出。 */
  readonly stats: VerificationStats
  /** 每千字引用数，用于检测“被要求重写后把引用删光”的规避行为。 */
  readonly citationDensity: number
  /** 是否全部单元都 supported（便于决策层快速短路）。 */
  readonly allSupported: boolean
}

/** 熔断原因。区分“生成不忠实”和“检索不足”是本方案的核心增量。 */
export type AbortCause =
  /** 多次重写后失败单元几乎不变：生成侧不忠实 */
  | 'unfaithful'
  /** 证据本身不足，再重试也没意义 */
  | 'insufficient-retrieval'
  /** 两次失败的单元高度相似，迭代无法收敛 */
  | 'unstable-iteration'
  /** 重试次数用尽 */
  | 'attempts-exhausted'
  /** 引用密度骤降：用删引用替代修复 */
  | 'citation-collapse'

/**
 * L4 的四种动作（放行 / 标记 / 重写 / 熔断）。
 * 可穷举的联合类型让决策层用 `switch (decision.kind)` 就能分支，
 * 且每种动作都带 `reason`，保证日志与用户提示里始终有可解释的说明。
 */
export type Decision =
  /** 放行：全部单元有支撑，或问题轻微到不值得打扰用户 */
  | { readonly kind: 'pass'; readonly reason: string }
  /** 标注：输出照常放行，但把验证结论写进日志/附注，供用户自行判断 */
  | { readonly kind: 'annotate'; readonly reason: string }
  /** 重写：把草稿退回模型，`feedback` 是面向模型的结构化修复指令 */
  | { readonly kind: 'rewrite'; readonly reason: string; readonly feedback: string }
  /** 熔断：停止重试，`cause` 区分“生成不忠实”“检索不足”等具体原因 */
  | { readonly kind: 'abort'; readonly cause: AbortCause; readonly reason: string }
