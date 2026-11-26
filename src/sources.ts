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
 */
export class EvidenceRegistry {
  private readonly bySession = new WeakMap<object, SourceDoc[]>()

  /** 记录一条工具产出（去重：同 URL 或同正文只保留最新一条）。 */
  record(session: object, doc: SourceDoc): void {
    const list = this.bySession.get(session) ?? []
    const duplicate = list.findIndex((item) => item.id === doc.id)
    if (duplicate >= 0) list.splice(duplicate, 1)
    list.push(doc)
    this.bySession.set(session, list)
  }

  /** 取出该会话已收集的证据（按时间升序）。 */
  get(session: object): readonly SourceDoc[] {
    return this.bySession.get(session) ?? []
  }

  /** 回合结束时清理，避免把旧证据当成新证据。 */
  clear(session: object): void {
    this.bySession.delete(session)
  }
}

/** 从工具调用里抽出一条可用的证据；不是检索类工具或没有正文时返回 undefined。 */
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
 * @param url - 目标地址。
 * @param config - 只用 `fetchTimeoutMs` 与 `maxSourceChars`。
 * @param origin - 该地址来自正文内联链接、DOI 还是 arXiv，决定报告的出处。
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

/** 由参考条目生成“只有元数据”的来源：无链接时用它做实体/关键词检查。 */
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
 * @param units - `buildUnits()` 的输出。
 * @param references - 参考列表。
 * @param config - 解析后的配置。
 * @param fetchImpl - 可注入的抓取实现（selftest 用它替换网络）。
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
