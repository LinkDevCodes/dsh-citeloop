/**
 * L2 解析层：从草稿里抽出「引用标记」与「参考列表」，并把引用绑定到句子。
 *
 * 产出两类东西：
 * 1. `Citation[]` —— 正文里每一处引用标记，带精确偏移；
 * 2. `RawUnit[]` —— 每个“带引用的句子”组成一个待验证单元。
 *
 * 这里刻意不抓网络、不读配置：它只做纯文本解析，因此可以在 selftest 里逐条断言。
 */
import type { Citation, CitationKind, ClaimUnit, SourceOrigin } from './types.ts'
import { splitSentences, truncate } from './text.ts'

/**
 * 引用在解析阶段的“待解析键”：说明这处引用应该去哪里找来源。
 * `sources.ts` 会按 `origin` 决定是查参考列表、还是直接抓 URL。
 */
export interface CitationKey {
  /** 归一化标识（数字 `"1"`、`"smith2020"`、URL、DOI、arXiv 编号）。 */
  readonly marker: string
  readonly kind: CitationKind
  readonly origin: SourceOrigin
  /** 可抓取的地址（URL 类引用、DOI/arXiv 推导地址、参考条目里的链接）。 */
  readonly url?: string
  /** 展示用标签。 */
  readonly label: string
}

/** 文末参考列表中的一条。 */
export interface ReferenceEntry {
  /** 数字条目是数字串；作者-年份条目是 `smith2020`。 */
  readonly marker: string
  readonly label: string
  readonly url?: string
}

/** 解析结果。 */
export interface Extraction {
  /** 正文中的引用标记（已按位置排序，互不重叠）。 */
  readonly citations: readonly Citation[]
  /** 文末参考列表。 */
  readonly references: readonly ReferenceEntry[]
  /** 参考列表起始偏移；该位置之后的句子不再参与验证。 */
  readonly referenceStart: number
}

/** 尚未解析来源的验证单元。 */
export interface RawUnit {
  readonly id: string
  readonly sentence: string
  /** 句子去掉引用标记后的正文，用于覆盖率计算。 */
  readonly prose: string
  readonly start: number
  readonly end: number
  readonly citations: readonly Citation[]
  readonly keys: readonly CitationKey[]
}

/** 正文内联 URL。 */
const URL_PATTERN = /https?:\/\/[^\s<>"'“”（）()\u3000]+/g
/** DOI。 */
const DOI_PATTERN = /\b10\.\d{4,9}\/[^\s<>"'，。；）)]+/g
/** arXiv 标识。 */
const ARXIV_PATTERN = /\barXiv\s*:\s*(\d{4}\.\d{4,5})(v\d+)?/gi
/** 编号引用：`[1]`、`[2,3]`、`[4-6]`、`[1，2]`。 */
const NUMERIC_PATTERN = /\[(\d{1,3}(?:\s*[,，、\-–~]\s*\d{1,3})*)\]/g
/** 括号式作者-年份：`(Smith, 2020)`、`(Smith et al., 2020)`、`(Smith and Jones, 2020)`。 */
const PAREN_AUTHOR_YEAR = /\(\s*([A-Z][A-Za-z'’\-]+(?:\s+(?:et\s+al\.?|and|&)\s*(?:[A-Z][A-Za-z'’\-]+)?)?)\s*[,，]\s*(\d{4})[a-z]?\s*\)/g
/** 叙述式作者-年份：`Smith (2020)`。 */
const NARRATIVE_AUTHOR_YEAR = /(?<![A-Za-z])([A-Z][A-Za-z'’\-]{1,})\s+\((\d{4})[a-z]?\)/g

/**
 * 把围栏代码块与行内代码替换成等长空格。
 *
 * 代码里出现的 `[1]`、`http://localhost` 不是引用，直接算进来会制造假阳性；
 * 用等长空格替换可以保持后续所有偏移不变。
 */
function maskCode(text: string): string {
  const maskSegment = (segment: string): string => segment.replace(/[^\n]/g, ' ')
  return text
    .replace(/```[\s\S]*?```/g, maskSegment)
    .replace(/~~~[\s\S]*?~~~/g, maskSegment)
    .replace(/`[^`\n]*`/g, maskSegment)
}

/** 作者名归一化：`Smith` → `smith`，`van der Waals` 之类保持原样只做小写与去标点。 */
function normalizeAuthor(author: string): string {
  return author.toLowerCase().replace(/[^a-z\u4e00-\u9fff]/g, '')
}

/** 去掉 URL 尾部的标点（句末的 `.`、`)` 等不属于链接）。 */
function trimUrl(url: string): string {
  return url.replace(/[.,;:、，。；！？"'”’]+$/, '')
}

/** 展开编号引用里的区间：`5-7` → `5,6,7`；`2,3` → `2,3`。 */
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

/** 扫描正文里的全部引用候选，按“位置升序、同位置长者优先”去重成不重叠列表。 */
function scanCitations(text: string): { citations: Citation[]; numericGroups: Citation[] } {
  const masked = maskCode(text)
  const candidates: Citation[] = []
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
 * 必须带 `g`：这里用 `matchAll` 逐个找标题行（正文里可能有多级标题重复出现），
 * 非全局正则会直接抛 `String.prototype.matchAll called with a non-global RegExp`。
 */
const REFERENCE_HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:参考文献|参考资料|引用文献|references?|works?\s+cited|bibliography)[ \t]*[:：]?[ \t]*$/gim

/** 找到参考列表起始位置；没有则返回 -1。 */
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
 */
export function parseReferenceEntries(text: string, referenceStart = findReferenceHeading(text)): ReferenceEntry[] {
  if (referenceStart < 0) return []
  const section = text.slice(referenceStart)
  const entries: ReferenceEntry[] = []
  const seen = new Set<string>()
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

/** 把一处引用映射成待解析键。 */
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

/** 把句子里的引用标记删掉，得到用于关键词比对的“纯陈述”。 */
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

/** 找到“包含该偏移”的句子下标；落在句子间隙时归给前一句。 */
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
 * @param text - 草稿全文。
 * @param extraction - `extract()` 的结果。
 * @returns 按正文顺序排列的单元；没有引用的句子不会出现。
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

/** 把单元接上来源（由 `sources.ts` 调用，避免解析层依赖抓取层）。 */
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
