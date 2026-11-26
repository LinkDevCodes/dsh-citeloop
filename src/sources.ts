/**
 * 来源层：把「引用键」变成可读取的 `SourceDoc`。
 *
 * 两条来源通道：
 * 1. **参考列表**：文末 `[1] ...` 这类条目本身是元数据（标题、作者、年份、链接）。
 *    有链接就去抓正文；没链接就把元数据当正文——它仍足以支撑实体/关键词检查，
 *    只是数字锚定会不确定（`anchors.ts` 会把它降级为 minor）。
 * 2. **检索片段**：本轮对话中 `web_search` / `web_fetch` 等工具的返回，
 *    在 `tools/post-execute` 里被回收。它们不是“被引用的来源”，
 *    而是**重写时的可用证据**——这正是本方案「区分检索不足」的判据基础。
 *
 * 抓取失败本身是要上报的失败信号，不能被静默跳过。
 *
 * 流水线位置：`extract.ts` 产出 `RawUnit` 与参考列表 → **本文件（L2 取证）** →
 * L3 验证层拿 `ClaimUnit[]` 做锚定与覆盖率检查。因此这里不出现任何验证逻辑，
 * 也不决定“通过/不通过”，只负责把来源取到手并如实标注状态。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ClaimUnit, SourceDoc, SourceOrigin } from './types.ts'
import type { CitationKey, RawUnit, ReferenceEntry } from './extract.ts'
import { withSources } from './extract.ts'
import type { ResolvedConfig } from './config.ts'
import { blocksToText, collapseWhitespace, looksLikeHtml, stripHtml, truncate } from './text.ts'

/** 抓取单条 URL 的默认 UA。有些站点会对无 UA 请求直接返回 403。 */
const USER_AGENT = 'CiteLoop/0.1 (citation verifier)'

/**
 * 检索证据登记簿。
 *
 * 用 `WeakMap` 而不是 `Map`：会话对象不可枚举、也不该被插件长期持有，
 * 弱引用能在会话被回收时自动清空，避免内存泄漏。
 *
 * 注意：同一会话内证据按登记顺序保存，L3 的「引用指向性」检查依赖这个顺序。
 */
export class EvidenceRegistry {
  /** 会话对象 → 该会话已登记的证据（按登记顺序，最新的在末尾）。 */
  private readonly bySession = new WeakMap<object, SourceDoc[]>()

  /**
   * 记录一条工具产出（去重：同 URL 或同正文只保留最新一条）。
   *
   * 去重后重新 push 到末尾，等于把“再次命中的来源”刷新成最新证据，
   * 让 L3 优先采用本轮新抓到的正文，而不是上一轮残留的旧片段。
   *
   * @param session - 会话对象（`WeakMap` 的键，插件不会持有它的强引用）。
   * @param doc - 从工具调用里抽出的来源文档。
   * @returns 无返回值。
   * @example
   * const registry = new EvidenceRegistry()
   * registry.record(session, doc)
   * registry.get(session) // => [doc]
   */
  record(session: object, doc: SourceDoc): void {
    const list = this.bySession.get(session) ?? []
    const duplicate = list.findIndex((item) => item.id === doc.id)
    if (duplicate >= 0) list.splice(duplicate, 1)
    list.push(doc)
    this.bySession.set(session, list)
  }

  /**
   * 取出该会话已收集的证据（按时间升序）。
   *
   * 返回内部数组本身而不是副本：调用方只做只读遍历，每个回合都复制一次没必要。
   *
   * @param session - 会话对象。
   * @returns 该会话的证据列表；从未登记过时返回空数组。
   * @example
   * registry.get(session) // => 该会话已登记的 SourceDoc[]，按登记顺序
   */
  get(session: object): readonly SourceDoc[] {
    return this.bySession.get(session) ?? []
  }

  /**
   * 回合结束时清理，避免把旧证据当成新证据。
   *
   * 不清理的后果很隐蔽：上一轮重写时检索到的片段会被当成本轮的证据，
   * 让“检索不足”这种熔断原因永远判不出来。
   *
   * @param session - 会话对象。
   * @returns 无返回值。
   * @example
   * registry.clear(session)
   * registry.get(session) // => []
   */
  clear(session: object): void {
    this.bySession.delete(session)
  }
}

/**
 * 从工具调用里抽出一条可用的证据；不是检索类工具或没有正文时返回 undefined。
 *
 * 宽进严出：任何工具只要返回了文本就先收下（L3 只在需要时把它当“可用证据”用），
 * 但不带正文的调用一律丢弃，否则会造出一堆空来源。
 *
 * @param name - 工具名，如 `"web_fetch"`；仅用于给无 URL 的结果起标签与 id。
 * @param args - 本次工具调用的参数；含 `url` 时用它做去重键。
 * @param content - 工具返回的内容块，会被压成纯文本。
 * @returns 一张 `origin: 'retrieval'` 的来源文档；正文为空时返回 undefined。
 * @example
 * evidenceFromTool('web_fetch', { url: 'https://example.com/a' }, blocks)
 * // => { id: 'tool:https://example.com/a', origin: 'retrieval', status: 'available', ... }
 */
export function evidenceFromTool(name: string, args: unknown, content: readonly ContentBlock[]): SourceDoc | undefined {
  const text = collapseWhitespace(blocksToText(content))
  if (text.length === 0) return undefined
  const url = typeof args === 'object' && args !== null && 'url' in args
    ? String((args as { url?: unknown }).url ?? '')
    : ''
  const id = url.length > 0 ? `tool:${url}` : `tool:${name}:${text.slice(0, 48)}`
  return {
    id,
    label: url.length > 0 ? url : `${name} 结果`,
    ...(url.length > 0 ? { url } : {}),
    text,
    origin: 'retrieval',
    retrievedAt: Date.now(),
    status: 'available',
  }
}

/**
 * 抓取一个 URL 并压成纯文本。
 *
 * 失败分类（对应 `FailKind` 的三种来源失败）：
 * - 网络/HTTP 错误 → `source-unreachable`
 * - 正文为空（付费墙、纯 JS 页）→ `source-empty`
 *
 * 这里刻意不抛异常：抓取失败要作为**数据**流到 L4，而不是中断整条流水线。
 *
 * @param url - 目标地址。
 * @param config - 只用 `fetchTimeoutMs` 与 `maxSourceChars`。
 * @param origin - 该地址来自正文内联链接、DOI 还是 arXiv，决定报告的出处。
 * @returns 一定返回 `SourceDoc`；失败时 `status` 为 `unreachable`/`empty` 且带 `error`。
 * @example
 * const doc = await fetchSource('https://example.com/a', config, 'inline-url')
 * // doc.status === 'available' | 'unreachable' | 'empty'
 */
export async function fetchSource(
  url: string,
  config: ResolvedConfig,
  origin: SourceOrigin = 'inline-url',
): Promise<SourceDoc> {
  const base = {
    id: url,
    label: url,
    url,
    origin,
    retrievedAt: Date.now(),
  }
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
    })
    if (!response.ok) {
      return { ...base, text: '', status: 'unreachable', error: `HTTP ${String(response.status)}` }
    }
    const raw = await response.text()
    // 先粗截断再清洗：有些页面正文有数 MB，先 strip 会白烧 CPU。
    const cleaned = looksLikeHtml(raw) ? stripHtml(raw.slice(0, config.maxSourceChars * 4)) : collapseWhitespace(raw)
    const text = truncate(cleaned, config.maxSourceChars)
    if (text.length < 20) {
      return { ...base, text, status: 'empty', error: '正文过短或为空' }
    }
    return { ...base, text, status: 'available' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...base, text: '', status: 'unreachable', error: message }
  }
}

/**
 * 由参考条目生成“只有元数据”的来源：无链接时用它做实体/关键词检查。
 *
 * 不算失败：L3 会把它当 `available` 用，只是数字锚定会降级为 minor——
 * 因为条目本身的作者年份往往就写在正文里，能支撑一部分判定。
 *
 * @param entry - 参考列表里的一条。
 * @returns 以 `ref:<marker>` 为 id、正文即条目文本的来源文档。
 * @example
 * metadataSource({ marker: '1', label: 'Smith 2020. Attention.' })
 * // => { id: 'ref:1', text: 'Smith 2020. Attention.', status: 'available' }
 */
function metadataSource(entry: ReferenceEntry): SourceDoc {
  return {
    id: `ref:${entry.marker}`,
    label: entry.label,
    ...(entry.url === undefined ? {} : { url: entry.url }),
    text: entry.label,
    origin: 'reference',
    retrievedAt: Date.now(),
    status: 'available',
  }
}

/**
 * 把待验证单元解析成带来源的单元。
 *
 * 关键决定：**同一个 URL 在一个回合内只抓一次**（`cache`），
 * 一篇文章被引用五次不应该发五次请求。
 *
 * 另一个关键决定：抓取预算（`maxFetchPerTurn`）耗尽时返回 `unreachable` 而不是空来源，
 * 让 L4 能把“本轮没来得及验证”与“来源不存在”区分开。
 *
 * @param units - `buildUnits()` 的输出。
 * @param references - 参考列表。
 * @param config - 解析后的配置，读取 `maxFetchPerTurn` 与抓取超时/截断参数。
 * @param fetchImpl - 可注入的抓取实现（selftest 用它替换网络）。
 * @returns 与入参等长、同序的 `ClaimUnit[]`；`sources` 已按引用逐个解析并去重。
 * @example
 * const units = await resolveUnits(buildUnits(draft, extract(draft)), extract(draft).references, config)
 * // units[0].sources.length === 该句引用能解析出的来源数
 */
export async function resolveUnits(
  units: readonly RawUnit[],
  references: readonly ReferenceEntry[],
  config: ResolvedConfig,
  fetchImpl: (url: string, config: ResolvedConfig, origin: SourceOrigin) => Promise<SourceDoc> = fetchSource,
): Promise<ClaimUnit[]> {
  const byMarker = new Map(references.map((entry) => [entry.marker, entry]))
  const cache = new Map<string, Promise<SourceDoc>>()
  const budget = { remaining: config.maxFetchPerTurn }
  // 同一 URL 复用同一个 Promise：并发单元同时引用一篇来源时也只会发一次请求。
  const get = (url: string, origin: SourceOrigin): Promise<SourceDoc> => {
    const cached = cache.get(url)
    if (cached !== undefined) return cached
    if (budget.remaining <= 0) {
      // 预算耗尽时明确标记为不可达，而不是假装通过。
      const doc: SourceDoc = {
        id: url,
        label: url,
        url,
        text: '',
        origin,
        retrievedAt: Date.now(),
        status: 'unreachable',
        error: '本轮抓取预算已用尽',
      }
      return Promise.resolve(doc)
    }
    budget.remaining -= 1
    const promise = fetchImpl(url, config, origin)
    cache.set(url, promise)
    return promise
  }
  // 单个键 → 来源：参考条目走“有链接抓正文、无链接用元数据”的分支。
  const resolveKey = async (key: CitationKey): Promise<SourceDoc | undefined> => {
    if (key.origin === 'reference') {
      const entry = byMarker.get(key.marker)
      if (entry === undefined) return undefined
      if (entry.url === undefined) return metadataSource(entry)
      const fetched = await get(entry.url, 'reference')
      // 抓取失败仍然返回该条目：正文退化为元数据，label 仍可用于关键词/实体比对。
      return { ...fetched, label: entry.label, text: fetched.status === 'available' ? fetched.text : entry.label }
    }
    if (key.url === undefined) return undefined
    return get(key.url, key.origin)
  }
  const resolved: ClaimUnit[] = []
  for (const unit of units) {
    const sources: SourceDoc[] = []
    const seen = new Set<string>()
    for (const key of unit.keys) {
      const doc = await resolveKey(key)
      if (doc === undefined) continue
      if (seen.has(doc.id)) continue
      seen.add(doc.id)
      sources.push(doc)
    }
    resolved.push(withSources(unit, sources))
  }
  return resolved
}
