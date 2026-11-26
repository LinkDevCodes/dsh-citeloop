/**
 * L3 指向性检查：引用“指对了人没有”。
 *
 * 四层流水线中的位置：L3 验证层的最后一道检查，由 `verify.ts` 的 `verifyUnit()`
 * 对每个（引用 × 可读来源）组合调用；它不复核对内容，只核对“归属”这一个维度。
 *
 * 与关键词覆盖率不同，这一层只关心可判定的**归属错误（Attribution Error）**：
 * 正文说 `(Smith, 2020)`，而抓回来的页面通篇没出现 Smith——那多半是引错了来源。
 *
 * 故意保持保守：只在来源正文足够长（>200 字符，说明真的抓到了内容）时才判断，
 * 且 `(Author, Year)` 里的作者是唯一被验证的锚点，避免把“来源没提到姓名缩写”
 * 这类正常情况判成错配。
 */
import type { Citation, Failure, SourceDoc } from './types.ts'
import { normalizeText } from './text.ts'

/**
 * 从 `(Smith, 2020)` 这类引用原文里取作者姓氏。
 *
 * 两种形态都支持：括号内开头（`(Smith, 2020)`）与行首叙述式（`Smith (2020)`）。
 * 只取第一个大写开头的词——年份、页码不参与归属判断，多说多错。
 *
 * @param citation - 一条引用标记；仅 `kind === 'author-year'` 会返回作者。
 * @returns 作者姓氏（如 `'Smith'`）；非作者-年份引用或匹配不到时返回 `undefined`。
 * @example
 * authorOf({ raw: '(Smith, 2020)', kind: 'author-year', marker: 'smith2020', start: 0, end: 13 })
 * // 预期：'Smith'
 * authorOf({ raw: '[1]', kind: 'numeric', marker: '1', start: 0, end: 3 }) // 预期：undefined
 */
function authorOf(citation: Citation): string | undefined {
  if (citation.kind !== 'author-year') return undefined
  const match = citation.raw.match(/\(\s*([A-Z][A-Za-z'’\-]+)/) ?? citation.raw.match(/^([A-Z][A-Za-z'’\-]+)/)
  return match?.[1]
}

/**
 * 检查引用的作者是否出现在来源里。
 *
 * 判为 `major` 而不是 `critical`：作者名只是归属线索，来源可能正常但正文用了
 * “等人”/机构署名/不同语言写法，误判会逼模型改掉正确的引用；因此它与专名缺失同级，
 * 阻断通过但不强制重写。两处保守处理各有理由——`< 200` 字符直接放过，是因为
 * 摘要级正文常省略署名，据此判错配会把“抓取残缺”误报成“引错来源”；
 * 作者短于 3 个字符（如 `Wu`）也放过，子串匹配太容易撞上普通单词。
 *
 * @param citations - 该单元绑定的引用；空数组表示没有可核对的归属。
 * @param source - 被引用的来源；`text` 短于 200 字符时不做判断。
 * @returns 归属错误列表（可能为空），每个错配引用对应一条 `citation-mismatch`。
 * @example
 * import type { SourceDoc } from './types.ts'
 * import { checkPointing } from './pointing.ts'
 *
 * const source: SourceDoc = {
 *   id: '#1', label: 'Smith 2020', url: 'https://example.com',
 *   text: 'Smith 讨论了该问题。'.repeat(20), // 来源正文需超过 200 字符
 *   origin: 'reference', retrievedAt: 0, status: 'available',
 * }
 * const citations = [{ raw: '(Smith, 2020)', kind: 'author-year' as const, marker: 'smith2020', start: 0, end: 13 }]
 * checkPointing(citations, source) // 预期：[]
 * checkPointing([{ ...citations[0]!, raw: '(Jones, 2021)', marker: 'jones2021' }], source)
 * // 预期：[{ kind: 'citation-mismatch', severity: 'major',
 * //         detail: '引用 (Jones, 2021) 的作者 Jones 未出现在来源中', missing: ['Jones'] }]
 */
export function checkPointing(citations: readonly Citation[], source: SourceDoc): Failure[] {
  if (source.text.length < 200) return []
  const haystack = normalizeText(source.text)
  const failures: Failure[] = []
  for (const citation of citations) {
    const author = authorOf(citation)
    if (author === undefined) continue
    const needle = normalizeText(author)
    if (needle.length < 3) continue
    if (haystack.includes(needle)) continue
    failures.push({
      kind: 'citation-mismatch',
      severity: 'major',
      detail: `引用 ${citation.raw} 的作者 ${author} 未出现在来源中`,
      missing: [author],
    })
  }
  return failures
}
