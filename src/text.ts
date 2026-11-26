/**
 * 纯文本工具集：句子切分、中英文分词、覆盖率/Jaccard、HTML 清洗、数字与实体抽取。
 *
 * 设计约束：
 * 1. 不依赖任何宿主运行期模块（对 `ContentBlock` 只有 type-only 依赖，编译期擦除），
 *    因此 scripts/selftest.ts 可以脱离 harness 直接加载本文件做单测。
 * 2. 全部函数无副作用、不读全局状态，便于在决策层复用同一套口径。
 *
 * 流水线位置：本文件属于 **L2 解析层** 的基础设施（把消息展平、切句、抓取后清洗正文），
 * 同时被 **L3 验证层** 复用（词元覆盖率、数字/实体锚点、Jaccard 熔断判定）。
 * 它只做机械的文本处理，不包含任何“是否可信”的结论。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** 英文停用词：算覆盖率时剔除，避免 "the / with / study" 这类词制造虚假重叠。 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'of', 'in', 'on', 'at', 'to',
  'for', 'from', 'by', 'with', 'without', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we', 'our', 'you', 'your',
  'he', 'she', 'his', 'her', 'i', 'me', 'my', 'not', 'no', 'yes', 'can', 'could', 'should', 'would',
  'may', 'might', 'must', 'will', 'shall', 'do', 'does', 'did', 'has', 'have', 'had', 'also', 'such',
  'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'more',
  'most', 'other', 'some', 'such', 'only', 'own', 'same', 'too', 'very', 'just', 'about', 'after',
  'before', 'during', 'over', 'under', 'between', 'into', 'through', 'there', 'here', 'however',
])

/**
 * 中文单字停用词。
 *
 * 中文没有空格分词，本文件用「汉字二元组（bigram）」近似词元：
 * “检索增强生成” → 检索/索增/增强/强生/生成。
 * 二元组会天然带上大量虚词组合，因此单字停用词只在「长度为 1 的独立汉字片段」上生效，
 * 避免把“的”拆进 bigram 后误判。
 */
const HAN_STOPWORDS = new Set('的了是在和与及或而也有这那其之为对从被把并等中上下个我你他她它不'.split(''))

/** 一句话连同它在原文里的位置。 */
export interface Sentence {
  /** 句子文本（已 trim，不含尾部的断句符）。 */
  readonly text: string
  /** 句子在原文中的起始偏移（含）。 */
  readonly start: number
  /** 句子在原文中的结束偏移（不含）。 */
  readonly end: number
}

/**
 * 把模型输出的 ContentBlock[] 展平成纯文本。
 * 只拼接 text 块：图片/文件块对“引用-来源”比对没有直接价值，
 * 且它们的占位文本会污染关键词覆盖率。
 *
 * @param content - 助手消息的内容块数组，按原顺序处理；非 text 块会被跳过。
 * @returns 以换行连接的纯文本；没有 text 块时返回空串。
 * @example
 * ```ts
 * import type { ContentBlock } from '@deepseek-ai/dsh-llm'
 * import { blocksToText } from './text'
 * const blocks = [
 *   { type: 'text', text: '甲' },
 *   { type: 'text', text: '乙' },
 * ] as unknown as ContentBlock[]
 * blocksToText(blocks) // => '甲\n乙'
 * ```
 */
export function blocksToText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * NFKC 规范化 + 小写，作为所有字符串比对的统一入口。
 *
 * 全角/半角、兼容字符先折叠成同一形态（`ＧＰＴ` → `GPT`），再做大小写归一，
 * 避免“看起来一样”的两段文本在覆盖率里被判成不同词元。
 *
 * @param input - 任意原始文本，允许为空串。
 * @returns 规范化后的小写文本，长度可能与原文不同。
 * @example
 * ```ts
 * import { normalizeText } from './text'
 * normalizeText('ＧＰＴ-4') // => 'gpt-4'
 * normalizeText('BERT') // => 'bert'
 * ```
 */
export function normalizeText(input: string): string {
  return input.normalize('NFKC').toLowerCase()
}

/**
 * 句子切分。
 *
 * 断句符：中文句号/问号/叹号/分号、换行、以及「英文句点 + 空白 + 大写/数字/引号」。
 * 英文句点必须跟空白和大写才断句，避免把 `v1.2`、`e.g.`、`3.5` 切断。
 *
 * @param text - 草稿全文；允许为空串。
 * @returns 非空句子数组，偏移基于原文（断句符本身不计入句子）。
 * @example
 * ```ts
 * import { splitSentences } from './text'
 * splitSentences('第一句。第二句！')
 * // => [{ text: '第一句', start: 0, end: 3 }, { text: '第二句', start: 4, end: 7 }]
 * ```
 */
export function splitSentences(text: string): Sentence[] {
  const pattern = /[。！？；!?;]+|\n+|\.[ \t]+(?=[A-Z0-9“"（(])/g
  const sentences: Sentence[] = []
  let cursor = 0
  /**
   * 把 `[start, end)` 切片裁剪后写入结果，偏移跟随 trim 调整。
   *
   * @param start - 切片在原文中的起始偏移（含）。
   * @param end - 切片在原文中的结束偏移（不含）。
   * @returns 无返回值。
   */
  const push = (start: number, end: number): void => {
    const raw = text.slice(start, end)
    const trimmed = raw.trim()
    if (trimmed.length === 0) return
    // 偏移要跟着 trim 调整，否则引用绑定会错位。
    const leading = raw.length - raw.trimStart().length
    sentences.push({ text: trimmed, start: start + leading, end: start + leading + trimmed.length })
  }
  for (const match of text.matchAll(pattern)) {
    const index = match.index
    push(cursor, index)
    cursor = index + match[0].length
  }
  push(cursor, text.length)
  return sentences
}

/** 英文词元：字母开头，允许内部出现数字、加号、井号、点、连字符（如 `gpt-4`、`c++`、`bert-base`）。 */
const LATIN_WORD = /[a-z][a-z0-9+#._-]*/g
/** 连续汉字片段。 */
const HAN_RUN = /\p{Script=Han}+/gu

/**
 * 分词：英文按词、中文按二元组。
 *
 * 为什么用 bigram 而不是引入分词词典：
 * 验证器必须是**确定性且零依赖**的；bigram 对“检索增强 / 增强生成”这类
 * 中文学术短语有足够召回，且不会因为词典版本变化导致阈值漂移。
 *
 * @param text - 任意文本（草稿句或来源正文）。
 * @returns 词元数组；大小写已归一并含重复，调用方按需用 {@link uniqueTokens} 去重。
 * @example
 * ```ts
 * import { tokenize } from './text'
 * tokenize('the study of BERT') // => ['study', 'bert']
 * tokenize('检索增强') // => ['检索', '索增', '增强']
 * ```
 */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text)
  const tokens: string[] = []
  for (const match of normalized.matchAll(LATIN_WORD)) {
    const word = match[0].replace(/[._-]+$/, '')
    if (word.length < 2 || STOPWORDS.has(word)) continue
    tokens.push(word)
  }
  for (const match of normalized.matchAll(HAN_RUN)) {
    const run = match[0]
    if (run.length === 1) {
      if (!HAN_STOPWORDS.has(run)) tokens.push(run)
      continue
    }
    for (let index = 0; index + 1 < run.length; index += 1) {
      const bigram = run.slice(index, index + 2)
      if (HAN_STOPWORDS.has(bigram[0] ?? '') && HAN_STOPWORDS.has(bigram[1] ?? '')) continue
      tokens.push(bigram)
    }
  }
  return tokens
}

/**
 * 去重（保留首次出现顺序），让覆盖率按“词元种类”而不是“出现次数”计算。
 *
 * @param tokens - 可能含重复的词元列表。
 * @returns 去重后的词元数组，顺序为首次出现顺序。
 * @example
 * ```ts
 * import { uniqueTokens } from './text'
 * uniqueTokens(['b', 'a', 'b']) // => ['b', 'a']
 * ```
 */
export function uniqueTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens)]
}

/** 覆盖率统计结果。 */
export interface Coverage {
  /** 陈述词元中有多少比例出现在来源里（0~1）。 */
  readonly coverage: number
  /** 命中的词元。 */
  readonly shared: readonly string[]
  /** 未命中的词元（反馈包里点名用）。 */
  readonly missing: readonly string[]
  /** 陈述的有效词元数；过少时不应据此下结论。 */
  readonly claimTokens: number
}

/**
 * 关键词覆盖率：`|陈述词元 ∩ 来源词元| / |陈述词元|`。
 *
 * 用覆盖率而不是 Jaccard：来源通常比陈述长得多，Jaccard 会被来源长度稀释，
 * 导致“高度相关的长文档”反而得分很低。
 *
 * @param claim - 陈述句（通常是单元的 `prose`）。
 * @param source - 来源正文（已清洗、已截断）。
 * @returns 覆盖率（0~1）与命中/缺失词元；陈述无有效词元时覆盖率记为 1。
 * @example
 * ```ts
 * import { coverageOf } from './text'
 * const r = coverageOf('gpt-4 improves retrieval', 'retrieval with gpt-4 works')
 * r.coverage // => 0.6666666666666666（命中 gpt-4 与 retrieval，共 3 个词元）
 * r.missing // => ['improves']
 * ```
 */
export function coverageOf(claim: string, source: string): Coverage {
  const claimTokens = uniqueTokens(tokenize(claim))
  const sourceTokens = new Set(tokenize(source))
  const shared = claimTokens.filter((token) => sourceTokens.has(token))
  const missing = claimTokens.filter((token) => !sourceTokens.has(token))
  return {
    coverage: claimTokens.length === 0 ? 1 : shared.length / claimTokens.length,
    shared,
    missing,
    claimTokens: claimTokens.length,
  }
}

/**
 * 两个词元集合的 Jaccard 相似度，用于「连续两次失败单元是否几乎没变」的熔断判定。
 *
 * @param left - 上一次失败的单元词元（通常已去重）。
 * @param right - 本次失败的单元词元（通常已去重）。
 * @returns 交集/并集（0~1）；两边都为空时记为 1（视为完全重合）。
 * @example
 * ```ts
 * import { jaccard } from './text'
 * jaccard(['a', 'b'], ['b', 'c']) // => 0.3333333333333333
 * jaccard([], []) // => 1
 * ```
 */
export function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1
  const a = new Set(left)
  const b = new Set(right)
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * 取出现频率最高的 k 个词元（同频按字典序，保证结果确定、可复现）。
 *
 * @param tokens - 词元列表，允许含重复（频率即出现次数）。
 * @param k - 最多返回的个数，非负整数；超过去重后总数时返回全部。
 * @returns 按频率降序、同频按字典序升序排列的前 k 个词元。
 * @example
 * ```ts
 * import { topTokens } from './text'
 * topTokens(['b', 'a', 'b', 'c', 'a', 'b'], 2) // => ['b', 'a']
 * ```
 */
export function topTokens(tokens: readonly string[], k: number): string[] {
  const counts = new Map<string, number>()
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, k)
    .map(([token]) => token)
}

/**
 * 判断一段响应体是否像 HTML。
 *
 * 只嗅探前 2000 个字符：既够快，也避免被一篇长文正文里的 `<div` 字样误判；
 * 用它决定要不要走 {@link stripHtml}。
 *
 * @param input - 抓取回来的响应体（可能是 HTML，也可能是纯文本）。
 * @returns 像 HTML 返回 `true`，否则 `false`。
 * @example
 * ```ts
 * import { looksLikeHtml } from './text'
 * looksLikeHtml('<!doctype html><html><body>hi</body></html>') // => true
 * looksLikeHtml('纯文本正文') // => false
 * ```
 */
export function looksLikeHtml(input: string): boolean {
  return /<\/?(?:html|body|div|p|span|article|main|head|meta|title)[\s>/]|<!doctype/i.test(input.slice(0, 2000))
}

/** 常见 HTML 实体 → 字符。 */
const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
  '&times;': '×',
}

/**
 * 把 HTML 压成可比对的纯文本。
 *
 * 去掉 script/style/noscript/注释（它们会带入与正文无关的关键词，直接污染覆盖率），
 * 反转义常见实体，标签替换成空格，最后折叠空白。
 *
 * @param input - 原始 HTML 字符串。
 * @returns 去除标签与实体、空白已折叠的纯文本。
 * @example
 * ```ts
 * import { stripHtml } from './text'
 * stripHtml('<p>Hello&nbsp;<b>World</b></p>') // => 'Hello World'
 * ```
 */
export function stripHtml(input: string): string {
  let text = input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    text = text.split(entity).join(replacement)
  }
  text = text.replace(/&#(\d+);/g, (_match, code: string) => String.fromCharCode(Number(code)))
  return collapseWhitespace(text)
}

/**
 * 折叠连续空白为单个空格并 trim。
 *
 * 换行被保留为单个换行（不压成空格），因为段落边界对切句仍有用。
 *
 * @param input - 任意文本。
 * @returns 空格已折叠、首尾已 trim 的文本。
 * @example
 * ```ts
 * import { collapseWhitespace } from './text'
 * collapseWhitespace('a   b\n\n\nc') // => 'a b\nc'
 * ```
 */
export function collapseWhitespace(input: string): string {
  return input.replace(/[\t\f\v ]+/g, ' ').replace(/ *\n+ */g, '\n').replace(/\n{2,}/g, '\n').trim()
}

/**
 * 按字符数截断，尾部加省略号。来源正文必须截断，否则超长页面会拖垮验证耗时。
 *
 * @param input - 原始文本。
 * @param max - 允许的最大字符数（含省略号），非负整数。
 * @returns 长度不超过 `max` 的文本；未超长时原样返回。
 * @example
 * ```ts
 * import { truncate } from './text'
 * truncate('abcdef', 4) // => 'abc…'
 * truncate('abc', 4) // => 'abc'
 * ```
 */
export function truncate(input: string, max: number): string {
  if (input.length <= max) return input
  return `${input.slice(0, Math.max(0, max - 1))}…`
}

/** 一个数字锚点。 */
export interface NumberToken {
  /** 原文片段，如 `1,234.5%`。 */
  readonly raw: string
  /** 归一化数字串（去掉千分位），如 `1234.5`。 */
  readonly value: string
  /** 单位（`%`、`年`、`页`、`亿`…），没有则为 undefined。 */
  readonly unit?: string
}

/**
 * 数字锚点正则。
 *
 * 前面用 `(?<![\w.])` 保证不会从 `v1.2`、`iso9001` 这类标识符中间截出数字；
 * 后面接一个「可选单位」，年份（2021年）、百分比（37.5%）、样本量（1,200 例）、
 * 页码（第 12 页）都会落在同一套规则里。
 */
const NUMBER_PATTERN = /(?<![\w.])(\d+(?:[.,]\d+)*)\s*(%|％|‰|亿|万|千|百|余|多|人|例|名|项|次|倍|年|月|日|页|章|节|条|种|家|所|篇|GB|MB|TB|ms|分钟|小时|元|美元|欧元)?/g

/**
 * 归一化数字：NFKC、去掉千分位与空白。
 *
 * @param raw - 从原文截出的数字片段，如 `1,234.5`。
 * @returns 可直接做相等比较的数字串，如 `1234.5`。
 * @example
 * ```ts
 * import { normalizeNumber } from './text'
 * normalizeNumber('1,234.5') // => '1234.5'
 * ```
 */
export function normalizeNumber(raw: string): string {
  return raw.normalize('NFKC').replace(/[,\s_]/g, '')
}

/**
 * 抽取文本中的全部数字锚点。
 *
 * 只抽“值 + 单位”，不做语义解释；严格与否由 `strictNumbers` 在 L3 决定。
 *
 * @param text - 任意文本（草稿或来源）。
 * @returns 数字锚点数组；顺序与原文一致。
 * @example
 * ```ts
 * import { extractNumberTokens } from './text'
 * extractNumberTokens('2021 年增长了 37.5%')
 * // => [{ raw: '2021 年', value: '2021', unit: '年' }, { raw: '37.5%', value: '37.5', unit: '%' }]
 * ```
 */
export function extractNumberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = []
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const rawDigits = match[1] ?? ''
    if (rawDigits.length === 0) continue
    const value = normalizeNumber(rawDigits)
    const unit = match[2]
    tokens.push(unit === undefined ? { raw: match[0].trim(), value } : { raw: match[0].trim(), value, unit })
  }
  return tokens
}

/** 全大写缩写（≥2 字符），如 `BERT`、`GPT-4`、`ISO`。 */
const ACRONYM = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]{1,}(?:[-–][A-Z0-9]+)*(?![A-Za-z0-9])/g
/** 驼峰专名，如 `CiteLoop`、`ProofRAG`。 */
const CAMEL_CASE = /(?<![A-Za-z])[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*(?![A-Za-z])/g
/** 中文书名/引号专名。 */
const QUOTED_NAME = /[“"《]([^”"》]{2,40})[”"》]/g

/**
 * 抽取需要“必须在来源中出现”的实体锚点。
 *
 * 只收三类高置信锚点（参考 sentinel-proof-mcp 的做法）：
 * 全大写缩写、驼峰专名、引号/书名号内的专名。
 * 不收普通词组——那属于关键词重叠度的职责。
 *
 * @param text - 陈述句。
 * @returns 去重后的实体串（保留首次出现的大小写）。
 * @example
 * ```ts
 * import { extractEntities } from './text'
 * extractEntities('BERT 与 CiteLoop 都引用《Attention》')
 * // => ['BERT', 'CiteLoop', 'Attention']
 * ```
 */
export function extractEntities(text: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  /**
   * 记住一个候选实体：先 trim、丢弃长度 < 2 的，再按小写去重（保留首次出现写法）。
   *
   * @param value - 正则命中的原始片段，可能带空白。
   * @returns 无返回值。
   */
  const remember = (value: string): void => {
    const trimmed = value.trim()
    if (trimmed.length < 2) return
    const key = trimmed.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push(trimmed)
  }
  for (const match of text.matchAll(ACRONYM)) remember(match[0])
  for (const match of text.matchAll(CAMEL_CASE)) remember(match[0])
  for (const match of text.matchAll(QUOTED_NAME)) remember(match[1] ?? '')
  return found
}
