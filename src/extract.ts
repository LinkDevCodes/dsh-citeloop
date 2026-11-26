/**
 * L2 解析层：从草稿里抽出「引用标记」与「参考列表」，并把引用绑定到句子。
 *
 * 产出两类东西：
 * 1. `Citation[]` —— 正文里每一处引用标记，带精确偏移；
 * 2. `RawUnit[]` —— 每个“带引用的句子”组成一个待验证单元。
 *
 * 流水线位置：L1 触发层拿到草稿文本 → **本文件（L2 解析）** → `sources.ts`（L2 取证）
 * → L3 验证层（`verify.ts`）→ L4 决策层（`decide.ts`）。本文件只给 `RawUnit`，
 * 不带来源；来源由 `sources.ts` 解析后再用 `withSources()` 补成 `ClaimUnit`。
 *
 * 这里刻意不抓网络、不读配置：它只做纯文本解析，因此可以在 selftest 里逐条断言。
 */
import type { Citation, CitationKind, ClaimUnit, SourceOrigin } from './types.ts'
import { splitSentences, truncate } from './text.ts'

/**
 * 引用在解析阶段的“待解析键”：说明这处引用应该去哪里找来源。
 * `sources.ts` 会按 `origin` 决定是查参考列表、还是直接抓 URL。
 *
 * 一处引用可能展开成多个键：`[4-6]` 一个标记会生成 `4`、`5`、`6` 三个键。
 */
export interface CitationKey {
  /** 归一化标识（数字 `"1"`、`"smith2020"`、URL、DOI、arXiv 编号）。 */
  readonly marker: string
  /** 引用形态，决定 `origin` 与展示方式。 */
  readonly kind: CitationKind
  /** 来源通道：查参考列表，还是直接抓正文里的链接 / DOI / arXiv。 */
  readonly origin: SourceOrigin
  /** 可抓取的地址（URL 类引用、DOI/arXiv 推导地址、参考条目里的链接）。 */
  readonly url?: string
  /** 展示用标签。 */
  readonly label: string
}

/** 文末参考列表中的一条：只保留定位来源所需的最小元数据。 */
export interface ReferenceEntry {
  /** 数字条目是数字串；作者-年份条目是 `smith2020`。 */
  readonly marker: string
  /** 条目正文（已压掉多余空白、截断到 220 字符），无链接时兼作来源正文。 */
  readonly label: string
  /** 条目里出现的第一条链接；没有则只能靠元数据做实体/关键词比对。 */
  readonly url?: string
}

/** `extract()` 的解析结果：正文引用、参考列表、以及两者的分界线。 */
export interface Extraction {
  /** 正文中的引用标记（已按位置排序，互不重叠）。 */
  readonly citations: readonly Citation[]
  /** 文末参考列表。 */
  readonly references: readonly ReferenceEntry[]
  /** 参考列表起始偏移；该位置之后的句子不再参与验证。 */
  readonly referenceStart: number
}

/** 尚未解析来源的验证单元：句子 + 它的引用 + 待解析的键。 */
export interface RawUnit {
  /** 单元编号 `u1`、`u2`…，按正文顺序递增。 */
  readonly id: string
  /** 单元对应的原句（含引用标记）。 */
  readonly sentence: string
  /** 句子去掉引用标记后的正文，用于覆盖率计算。 */
  readonly prose: string
  /** 句子在草稿中的起始偏移（含头）。 */
  readonly start: number
  /** 句子在草稿中的结束偏移（不含尾）。 */
  readonly end: number
  /** 绑定到该句的引用（至少一个，否则不会建单元）。 */
  readonly citations: readonly Citation[]
  /** 这些引用展开出的待解析键，供 `sources.ts` 逐个取来源。 */
  readonly keys: readonly CitationKey[]
}

/**
 * 正文内联 URL。
 *
 * 坑：字符类里排除空白、尖括号与中英文引号/括号，是为了让紧贴正文写的链接不被吞掉；
 * 末尾的句号、右括号仍会被吃进来，交给 `trimUrl()` 削掉。
 * `g` 是 `matchAll` 的硬性要求，缺了会直接抛 TypeError。
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'“”（）()\u3000]+/g
/**
 * DOI：`10.` + 4~9 位注册号 + `/` + 后缀。
 *
 * 坑：`\b` 防止从更长数字串中间截取；后缀排除中文标点与右括号，否则句末的“。”会进 marker，
 * 导致后面拼 `https://doi.org/...` 抓取失败。
 */
const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s<>"'，。；）)]+/g
/**
 * arXiv 标识：`arXiv:2101.00001`、`arXiv:2101.00001v2`。
 *
 * 坑：大小写混用很常见（`arXiv` / `ARXIV`），所以必须带 `i`；
 * `g` 是 `matchAll` 的硬性要求。版本号单独成组，拼 marker 时要带上它。
 */
const ARXIV_PATTERN = /\barXiv\s*:\s*(\d{4}\.\d{4,5})(v\d+)?/gi
/**
 * 编号引用：`[1]`、`[2,3]`、`[4-6]`、`[1，2]`。
 *
 * 坑：数字限制 1~3 位，避免把 `[2020]` 这类年份/页码当条目号；
 * 区间不会被这里展开，交给 `expandedMarkers()`；Markdown 链接文本 `[1](url)` 也会命中，
 * 但代码块已被 `maskCode()` 抹掉，剩下的误报按“引用”处理可接受。
 */
const NUMERIC_PATTERN = /\[(\d{1,3}(?:\s*[,，、\-–~]\s*\d{1,3})*)\]/g
/**
 * 括号式作者-年份：`(Smith, 2020)`、`(Smith et al., 2020)`、`(Smith and Jones, 2020)`。
 *
 * 坑：作者名限定首字母大写，因此 `(smith, 2020)` 与中文作者（`(张三, 2020)`）都匹配不到；
 * 这是有意的取舍——宁缺勿滥，避免把普通括号内容当引用。`g` 为 `matchAll` 所需。
 */
const PAREN_AUTHOR_YEAR = /\(\s*([A-Z][A-Za-z'’\-]+(?:\s+(?:et\s+al\.?|and|&)\s*(?:[A-Z][A-Za-z'’\-]+)?)?)\s*[,，]\s*(\d{4})[a-z]?\s*\)/g
/**
 * 叙述式作者-年份：`Smith (2020)`。
 *
 * 坑：`(?<![A-Za-z])` 保证不从单词中间起匹配；但 `Figure (2020)`、`Section (2020)`
 * 这类也会被当成引用——代价可接受，它们通常确实指向某个年份命名的事物。
 */
const NARRATIVE_AUTHOR_YEAR = /(?<![A-Za-z])([A-Z][A-Za-z'’\-]{1,})\s+\((\d{4})[a-z]?\)/g

/**
 * 把围栏代码块与行内代码替换成等长空格。
 *
 * 代码里出现的 `[1]`、`http://localhost` 不是引用，直接算进来会制造假阳性；
 * 用等长空格替换可以保持后续所有偏移不变。
 *
 * @param text - 草稿全文（可含 Markdown 代码块）。
 * @returns 与输入等长的文本，代码段已被空格替换，偏移与原文一一对应。
 * @example
 * const masked = maskCode('见 `[1]` 处')
 * // masked.length === 原串长度，且 '[1]' 已被空格吃掉，不会被当成引用
 */
function maskCode(text: string): string {
  // 逐行保留换行符：只抹掉可见字符，否则按行切分参考列表时会串行。
  const maskSegment = (segment: string): string => segment.replace(/[^\n]/g, ' ')
  return text
    .replace(/```[\s\S]*?```/g, maskSegment)
    .replace(/~~~[\s\S]*?~~~/g, maskSegment)
    .replace(/`[^`\n]*`/g, maskSegment)
}

/**
 * 作者名归一化：`Smith` → `smith`，`van der Waals` 之类保持原样只做小写与去标点。
 *
 * 归一化后与年份拼成 marker（`smith2020`），是正文引用与参考条目唯一的对接口，
 * 所以这里只保留字母与汉字，撇号、连字符、空格全部丢弃。
 *
 * @param author - 引用里抽出的作者名，如 `"Smith"`、`"O'Brien"`、`"van der Waals"`。
 * @returns 仅含小写字母/汉字的 marker 片段。
 * @example
 * normalizeAuthor("O'Brien")
 * // => 'obrien'
 */
function normalizeAuthor(author: string): string {
  return author.toLowerCase().replace(/[^a-z\u4e00-\u9fff]/g, '')
}

/**
 * 去掉 URL 尾部的标点（句末的 `.`、`)` 等不属于链接）。
 *
 * 被削掉的字符会留在原句里，因此不能把 `end` 之外的东西一并删掉。
 *
 * @param url - 正则刚匹配到的原始链接，可能带尾部标点。
 * @returns 去掉尾部 `.,;:、，。；！？"'”’` 后的链接。
 * @example
 * trimUrl('https://example.com/a).')
 * // => 'https://example.com/a'
 */
function trimUrl(url: string): string {
  return url.replace(/[.,;:、，。；！？"'”’]+$/, '')
}

/**
 * 展开编号引用里的区间：`5-7` → `5,6,7`；`2,3` → `2,3`。
 *
 * 上限 50 条：`[1-999]` 这种明显是笔误或页码，展开会瞬间造出上千个待抓取来源。
 *
 * @param marker - 已去空白的条目号串，如 `"2,3"`、`"5-7"`、`"1，2"`。
 * @returns 展开后的条目号数组；非数字片段被忽略。
 * @example
 * expandedMarkers('4-6, 8')
 * // => ['4', '5', '6', '8']
 */
export function expandedMarkers(marker: string): string[] {
  const result: string[] = []
  for (const part of marker.split(/[,，、]/)) {
    const range = part.split(/[-–~]/)
    const first = Number(range[0])
    const second = range.length > 1 ? Number(range[1]) : NaN
    if (Number.isInteger(first) && Number.isInteger(second) && second >= first && second - first <= 50) {
      for (let value = first; value <= second; value += 1) result.push(String(value))
      continue
    }
    if (Number.isInteger(first)) result.push(String(first))
  }
  return result
}

/**
 * 扫描正文里的全部引用候选，按“位置升序、同位置长者优先”去重成不重叠列表。
 *
 * 顺序即优先级：URL 先占位，DOI 才不会把 `https://doi.org/10.xxx` 从中间再匹配一次；
 * 同位置保留更长的那个，保证 `[1,2]` 不会被缩成 `[1]`。
 *
 * @param text - 草稿全文；内部先 `maskCode()`，因此代码段里的引用不会被扫到。
 * @returns `citations` 为去重后的引用，`numericGroups` 是其中编号类引用的子集。
 * @example
 * const { citations } = scanCitations('准确率提升 12% [1]，见 https://example.com/a。')
 * // citations 含两条：kind === 'numeric' 与 kind === 'url'，且按出现位置排序
 */
function scanCitations(text: string): { citations: Citation[]; numericGroups: Citation[] } {
  const masked = maskCode(text)
  const candidates: Citation[] = []
  // 只登记候选，去重统一放到最后一步，避免边扫边改造成偏移错乱。
  const add = (raw: string, kind: CitationKind, marker: string, start: number, end: number): void => {
    candidates.push({ raw, kind, marker, start, end })
  }
  // URL 优先级最高：DOI 常常嵌在 doi.org 链接里，必须让 URL 先占位。
  for (const match of masked.matchAll(URL_PATTERN)) {
    const raw = trimUrl(match[0])
    add(raw, 'url', raw, match.index, match.index + raw.length)
  }
  for (const match of masked.matchAll(DOI_PATTERN)) {
    add(match[0], 'doi', match[0], match.index, match.index + match[0].length)
  }
  for (const match of masked.matchAll(ARXIV_PATTERN)) {
    const id = `${match[1] ?? ''}${match[2] ?? ''}`
    if (id.length === 0) continue
    add(match[0], 'arxiv', id, match.index, match.index + match[0].length)
  }
  for (const match of masked.matchAll(PAREN_AUTHOR_YEAR)) {
    const author = match[1] ?? ''
    const year = match[2] ?? ''
    add(match[0], 'author-year', `${normalizeAuthor(author)}${year}`, match.index, match.index + match[0].length)
  }
  for (const match of masked.matchAll(NARRATIVE_AUTHOR_YEAR)) {
    const author = match[1] ?? ''
    const year = match[2] ?? ''
    add(match[0], 'author-year', `${normalizeAuthor(author)}${year}`, match.index, match.index + match[0].length)
  }
  for (const match of masked.matchAll(NUMERIC_PATTERN)) {
    const digits = (match[1] ?? '').replace(/\s+/g, '')
    if (digits.length === 0) continue
    add(match[0], 'numeric', digits, match.index, match.index + match[0].length)
  }
  candidates.sort((left, right) => left.start - right.start || right.end - left.end)
  const citations: Citation[] = []
  let cursor = -1
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue
    citations.push(candidate)
    cursor = candidate.end
  }
  return { citations, numericGroups: citations.filter((citation) => citation.kind === 'numeric') }
}

/**
 * 参考列表的标题行。
 *
 * 匹配中英文标题（`参考文献`/`参考资料`/`references`/`bibliography` 等），
 * 允许 Markdown `#` 前缀、行尾冒号与行内多余空白，但必须独占一行。
 *
 * 必须带 `g`：这里用 `matchAll` 逐个找标题行（正文里可能有多级标题重复出现），
 * 非全局正则会直接抛 `String.prototype.matchAll called with a non-global RegExp`。
 * 另外 `m` 必须保留，否则 `^`/`$` 只认全文首尾，标题永远匹配不到。
 */
const REFERENCE_HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:参考文献|参考资料|引用文献|references?|works?\s+cited|bibliography)[ \t]*[:：]?[ \t]*$/gim

/**
 * 找到参考列表起始位置；没有则返回 -1。
 *
 * 取**最后一个**匹配：正文里常出现“参考文献见附录”这类前置小标题，
 * 真正的列表总在文末，用最后一个标题行能把这类误判挡掉。
 *
 * @param text - 草稿全文。
 * @returns 标题行的起始偏移；没有标题时返回 -1。
 * @example
 * findReferenceHeading('正文\n\n## 参考文献\n[1] Smith 2020')
 * // => 指向 '## 参考文献' 的起始偏移；找不到标题时返回 -1
 */
function findReferenceHeading(text: string): number {
  const masked = maskCode(text)
  let start = -1
  for (const match of masked.matchAll(REFERENCE_HEADING)) {
    start = match.index
  }
  return start
}

/**
 * 解析参考列表。
 *
 * 支持三种条目形式：
 *   `[1] Author. Title. Journal, 2020. https://...`
 *   `1. Author. Title, 2020.`
 *   `- Author. Title, 2020.`
 * 作者-年份条目会额外生成 `smith2020` 形式的 marker，供 `(Smith, 2020)` 引用匹配。
 *
 * 同一 marker 只保留第一条：重复条目会让“引用指向性”检查拿到两份不一致的正文。
 *
 * @param text - 草稿全文（从标题行起才会被当作条目区）。
 * @param referenceStart - 参考列表起始偏移，默认自动探测；显式传入便于复用 `extract()` 的结果。
 * @returns 参考条目列表；没有参考列表时返回空数组。
 * @example
 * parseReferenceEntries('参考文献\n[1] Smith J. Attention. 2020. https://example.com/a')
 * // => [{ marker: '1', label: 'Smith J. Attention. 2020. https://example.com/a', url: 'https://example.com/a' }]
 */
export function parseReferenceEntries(text: string, referenceStart = findReferenceHeading(text)): ReferenceEntry[] {
  if (referenceStart < 0) return []
  const section = text.slice(referenceStart)
  const entries: ReferenceEntry[] = []
  const seen = new Set<string>()
  // 逐条登记：marker 去重、抽第一条链接、label 压空白后截断到 220 字符。
  const pushEntry = (marker: string, body: string): void => {
    if (seen.has(marker)) return
    seen.add(marker)
    const url = body.match(URL_PATTERN)?.[0]
    const label = truncate(body.replace(/\s+/g, ' ').trim(), 220)
    entries.push(url === undefined ? { marker, label } : { marker, label, url: trimUrl(url) })
  }
  const lines = section.split('\n')
  for (const line of lines) {
    const numeric = line.match(/^[ \t]*\[(\d{1,3})\][ \t]*(.+)$/)
    if (numeric !== null) {
      pushEntry(numeric[1] ?? '', numeric[2] ?? '')
      continue
    }
    const ordered = line.match(/^[ \t]*(\d{1,3})[.)][ \t]+(\S.+)$/)
    if (ordered !== null) {
      pushEntry(ordered[1] ?? '', ordered[2] ?? '')
      continue
    }
    const bullet = line.match(/^[ \t]*[-*•][ \t]+(\S.+)$/)
    if (bullet !== null) {
      const body = bullet[1] ?? ''
      const year = body.match(/\b(19|20)\d{2}\b/)?.[0]
      const author = body.match(/^[A-Z][A-Za-z'’\-]+/)?.[0]
      // 只有“作者 + 年份”齐备的条目才建立作者-年份 marker，否则只保留 URL 用途。
      if (year !== undefined && author !== undefined) pushEntry(`${normalizeAuthor(author)}${year}`, body)
    }
  }
  return entries
}

/**
 * 把一处引用映射成待解析键。
 *
 * 纯函数：只做形态转换，不查表取正文。`numeric` 会按区间展开，因此返回值可能比 1 多。
 * 未在参考列表命中的条目也照样返回键——`label` 退化成 `[n]` / 原样片段，
 * 这样“引用了但列表里没有”能作为 `no-source` 被 L3 抓出来，而不是静默消失。
 *
 * @param citation - 单处引用标记。
 * @param references - 参考列表，用于给键补上标题与链接。
 * @returns 待解析键列表，每项带 `origin` 与可抓取地址。
 * @example
 * citationKeys({ raw: '[2]', kind: 'numeric', marker: '2', start: 0, end: 3 }, [])
 * // => [{ marker: '2', kind: 'numeric', origin: 'reference', label: '[2]' }]
 */
export function citationKeys(citation: Citation, references: readonly ReferenceEntry[]): CitationKey[] {
  const byMarker = new Map(references.map((entry) => [entry.marker, entry]))
  switch (citation.kind) {
    case 'numeric':
      return expandedMarkers(citation.marker).map((marker) => {
        const entry = byMarker.get(marker)
        return {
          marker,
          kind: 'numeric',
          origin: 'reference',
          label: entry?.label ?? `[${marker}]`,
          ...(entry?.url === undefined ? {} : { url: entry.url }),
        }
      })
    case 'author-year': {
      const entry = byMarker.get(citation.marker)
      return [{
        marker: citation.marker,
        kind: citation.kind,
        origin: 'reference',
        label: entry?.label ?? citation.raw,
        ...(entry?.url === undefined ? {} : { url: entry.url }),
      }]
    }
    case 'url':
      return [{ marker: citation.marker, kind: 'url', origin: 'inline-url', url: citation.marker, label: citation.marker }]
    case 'doi':
      return [{
        marker: citation.marker,
        kind: 'doi',
        origin: 'doi',
        url: `https://doi.org/${citation.marker}`,
        label: citation.marker,
      }]
    case 'arxiv':
      return [{
        marker: citation.marker,
        kind: 'arxiv',
        origin: 'arxiv',
        url: `https://arxiv.org/abs/${citation.marker}`,
        label: `arXiv:${citation.marker}`,
      }]
  }
}

/**
 * 把句子里的引用标记删掉，得到用于关键词比对的“纯陈述”。
 *
 * 为什么必须删：`[1]`、`(Smith, 2020)` 里的数字/作者名会污染词元覆盖率，
 * 让“来源里没有这个数字”被误算成命中。
 *
 * @param sentence - 原句文本（不是全文）。
 * @param citations - 该句绑定的引用，坐标为全文偏移。
 * @param offset - 该句在全文中的起始偏移，用来把全文坐标换算成句内坐标。
 * @returns 去掉引用并压缩多余空白后的正文；无引用时原样返回。
 * @example
 * stripCitations('准确率提升 12%[1]。', [citation], 0)
 * // => '准确率提升 12%。'
 */
export function stripCitations(sentence: string, citations: readonly Citation[], offset: number): string {
  if (citations.length === 0) return sentence
  let result = ''
  let cursor = 0
  for (const citation of citations) {
    const localStart = citation.start - offset
    const localEnd = citation.end - offset
    if (localStart < cursor || localEnd > sentence.length) continue
    result += sentence.slice(cursor, localStart)
    cursor = localEnd
  }
  result += sentence.slice(cursor)
  return result.replace(/\s{2,}/g, ' ').trim()
}

/**
 * 找到“包含该偏移”的句子下标；落在句子间隙时归给前一句。
 *
 * `splitSentences()` 会裁掉句间空白，引用标记恰好掉进间隙时若不兜底就会丢单元，
 * 于是这里退化为“最后一个起点不晚于该偏移的句子”。
 *
 * @param sentences - 句子区间列表（`start`/`end` 为全文偏移）。
 * @param offset - 引用标记的起始偏移。
 * @returns 句子下标；偏移在所有句子之前时返回 -1。
 * @example
 * sentenceIndexOf([{ start: 0, end: 5 }, { start: 5, end: 10 }], 7)
 * // => 1
 */
function sentenceIndexOf(sentences: readonly { start: number; end: number }[], offset: number): number {
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index]
    if (sentence === undefined) continue
    if (offset >= sentence.start && offset < sentence.end) return index
  }
  let fallback = -1
  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index]
    if (sentence !== undefined && sentence.start <= offset) fallback = index
  }
  return fallback
}

/**
 * 解析整篇草稿：引用标记 + 参考列表 + 待验证单元。
 *
 * 单元划分规则（对应方案书 L2）：一个句子里的所有引用都属于同一个单元；
 * 参考列表自身的句子不参与验证；引用标记与句子的绑定按字符偏移精确对齐。
 *
 * @param text - 草稿全文。
 * @returns 引用、参考列表与参考列表起始偏移；没有参考列表时 `referenceStart` 为 -1。
 * @example
 * const result = extract('准确率提升 12% [1]。\n\n## 参考文献\n[1] Smith 2020')
 * // result.citations.length === 1；result.referenceStart 指向 '## 参考文献'
 */
export function extract(text: string): Extraction {
  const referenceStart = findReferenceHeading(text)
  const { citations: scanned } = scanCitations(text)
  // 参考列表里的 URL 只是条目的定位信息，不是“正文引用”。
  // 把它们算进 citations 会虚高引用密度，也会让「靠删引用规避校验」的检测失真。
  const citations = referenceStart < 0
    ? scanned
    : scanned.filter((citation) => citation.start < referenceStart)
  const references = parseReferenceEntries(text, referenceStart)
  return { citations, references, referenceStart }
}

/**
 * 生成待验证单元。
 *
 * 一句多引用会合并进同一个单元（`keys` 取并集），因此单元数等于“带引用的句子数”，
 * 不会因为一句话引了五篇就炸出五个单元。
 *
 * @param text - 草稿全文。
 * @param extraction - `extract()` 的结果。
 * @returns 按正文顺序排列的单元；没有引用的句子不会出现。
 * @example
 * const draft = '准确率提升 12% [1]。\n\n参考文献\n[1] Smith 2020'
 * buildUnits(draft, extract(draft))
 * // => [{ id: 'u1', prose: '准确率提升 12%。', keys: [{ marker: '1', ... }] }]
 */
export function buildUnits(text: string, extraction: Extraction): RawUnit[] {
  const sentences = splitSentences(text)
  const usable = extraction.referenceStart >= 0
    ? sentences.filter((sentence) => sentence.start < extraction.referenceStart)
    : sentences
  const buckets = new Map<number, Citation[]>()
  for (const citation of extraction.citations) {
    const index = sentenceIndexOf(usable, citation.start)
    if (index < 0) continue
    const bucket = buckets.get(index) ?? []
    bucket.push(citation)
    buckets.set(index, bucket)
  }
  const units: RawUnit[] = []
  for (const [index, bucket] of [...buckets.entries()].sort((left, right) => left[0] - right[0])) {
    const sentence = usable[index]
    if (sentence === undefined) continue
    const keys = bucket.flatMap((citation) => citationKeys(citation, extraction.references))
    units.push({
      id: `u${units.length + 1}`,
      sentence: sentence.text,
      prose: stripCitations(sentence.text, bucket, sentence.start),
      start: sentence.start,
      end: sentence.end,
      citations: bucket,
      keys,
    })
  }
  return units
}

/**
 * 把单元接上来源（由 `sources.ts` 调用，避免解析层依赖抓取层）。
 *
 * 这也解释了为什么 `RawUnit` 与 `ClaimUnit` 分开：解析层不该 import 任何网络代码，
 * 否则 selftest 里就会出现“解析测试需要联网”的怪圈。
 *
 * @param unit - `buildUnits()` 产出的单元。
 * @param sources - 该单元引用解析出的来源；抓取失败时也要传进来，不能过滤掉。
 * @returns 补全了 `sources` 的 `ClaimUnit`。
 * @example
 * const [unit] = buildUnits(draft, extract(draft))
 * withSources(unit, [
 *   { id: 'ref:1', label: 'Smith 2020', text: 'Smith 2020', origin: 'reference', status: 'available', retrievedAt: 0 },
 * ])
 * // => ClaimUnit，其 sources 已回填
 */
export function withSources(unit: RawUnit, sources: ClaimUnit['sources']): ClaimUnit {
  return {
    id: unit.id,
    sentence: unit.sentence,
    prose: unit.prose,
    start: unit.start,
    end: unit.end,
    citations: unit.citations,
    sources,
  }
}
