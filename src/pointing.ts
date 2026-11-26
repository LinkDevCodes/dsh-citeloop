/**
 * L3 指向性检查：引用“指对了人没有”。
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

/** 从 `(Smith, 2020)` 这类引用原文里取作者姓氏。 */
function authorOf(citation: Citation): string | undefined {
  if (citation.kind !== 'author-year') return undefined
  const match = citation.raw.match(/\(\s*([A-Z][A-Za-z'’\-]+)/) ?? citation.raw.match(/^([A-Z][A-Za-z'’\-]+)/)
  return match?.[1]
}

/**
 * 检查引用的作者是否出现在来源里。
 *
 * @param citations - 该单元绑定的引用。
 * @param source - 被引用的来源。
 * @returns 归属错误列表（可能为空）。
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
