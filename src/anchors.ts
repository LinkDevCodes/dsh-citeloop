/**
 * L3 锚定检查：数字锚定 + 实体锚定。
 *
 * 四层流水线中的位置：L3 验证层的第一道确定性检查，由 `verify.ts` 的 `verifyUnit()`
 * 在覆盖率算完之后调用（锚定看“硬事实在不在场”，覆盖率看“是不是同一件事”，两者互补）。
 *
 * 这是整套验证里**最不容易产生争议**的一层：
 * 年份、百分比、样本量、页码必须能在来源里找到；缩写/专名必须原样出现。
 * 它不判断“语义是否蕴含”，只判断“这些硬事实是否在场”，因此
 * 假阳性极低——也正因如此，它被放在一期的最小可行验证器里。
 */
import type { Failure, SourceDoc } from './types.ts'
import type { ResolvedConfig } from './config.ts'
import { extractEntities, extractNumberTokens, normalizeText } from './text.ts'

/**
 * 判断一个数字串是否为整数形式（小数位数为 0）。
 *
 * 只用于决定“能不能走相对误差容错”：整数锚点多是年份、页码、样本量，
 * 差一位就是另一个事实，不能按 1% 宽容；小数则是测量值，口径不一致很常见。
 *
 * @param value - 归一化后的数字串，如 `'2019'`、`'37.5'`（不含单位与千分位）。
 * @returns `true` 表示是纯整数（`/^\d+$/`），`false` 表示含小数点。
 * @example
 * isIntegerValue('2019') // 预期：true
 * isIntegerValue('37.5') // 预期：false
 */
function isIntegerValue(value: string): boolean {
  return /^\d+$/.test(value)
}

/**
 * 判断一个数字锚点在来源里是否存在。
 *
 * 严格模式下要求字面值完全一致；非严格模式允许小数相对误差 1%
 * （来源常把 `37.5%` 写成 `37.53%`，或把 `1,200` 写成 `1200`）。
 * 严格模式仍是默认关闭的，因为 1% 容错对“同一指标的多次测量”更贴近现实；
 * 而整数永不进入容错分支，避免把 2019 年认成 2020 年。
 *
 * @param claimValue - 陈述里的数字值（`extractNumberTokens()` 的 `value`，已去千分位）。
 * @param sourceNumbers - 来源里抽出的全部数字值。
 * @param strict - 为 `true` 时只接受字面完全相等。
 * @returns `true` 表示来源中存在该数字（或容错范围内的近似值）。
 * @example
 * numberPresent('37.5', ['37.53', '12'], false) // 预期：true（1% 容错）
 * numberPresent('37.5', ['37.53', '12'], true) // 预期：false（严格模式要求字面一致）
 * numberPresent('2019', ['2019', '2020'], false) // 预期：true（整数按字面命中）
 */
function numberPresent(claimValue: string, sourceNumbers: readonly string[], strict: boolean): boolean {
  for (const candidate of sourceNumbers) {
    if (candidate === claimValue) return true
    if (isIntegerValue(claimValue) !== isIntegerValue(candidate)) continue
    if (strict || isIntegerValue(claimValue)) continue
    const left = Number(claimValue)
    const right = Number(candidate)
    if (!Number.isFinite(left) || !Number.isFinite(right) || right === 0) continue
    if (Math.abs(left - right) / Math.abs(right) <= 0.01) return true
  }
  return false
}

/**
 * 检查一个单元的硬锚点。
 *
 * 严重度分级的理由：数字（年份/百分比/样本量）一旦对不上，陈述的事实基础就错了，
 * 是 `critical`；专名缺失可能只是来源用了缩写或别的译名，误判成本更高，故降为 `major`。
 * 两类失败都会带上 `missing` 字段，反馈包据此逐项点名要改哪个锚点。
 *
 * @param prose - 去掉引用标记后的陈述句（不能让 `[1]` 这类编号污染数字锚点）。
 * @param source - 被引用的来源；正文为空时直接返回空数组。
 * @param config - 配置，其中 `strictNumbers` 影响小数比对口径。
 * @returns 锚定失败列表（可能为空）：最多一条 `numeric-missing` 和一条 `entity-missing`。
 * @example
 * import type { SourceDoc } from './types.ts'
 * import { DEFAULT_CONFIG } from './config.ts'
 * import { checkAnchors } from './anchors.ts'
 *
 * const source: SourceDoc = {
 *   id: '#1', label: 'BERT 论文', text: 'BERT 于 2019 年发布，使用 BooksCorpus。',
 *   origin: 'reference', retrievedAt: 0, status: 'available',
 * }
 * checkAnchors('BERT 于 2019 年发布。', source, DEFAULT_CONFIG) // 预期：[]
 * checkAnchors('BERT 于 2020 年发布。', source, DEFAULT_CONFIG)
 * // 预期：[{ kind: 'numeric-missing', severity: 'critical', detail: '来源中找不到数字 2020 年' }]
 */
export function checkAnchors(prose: string, source: SourceDoc, config: ResolvedConfig): Failure[] {
  // 来源正文为空时无法做锚定判断，交给 sources 层的 unreachable/empty 失败去报告。
  if (source.text.trim().length === 0) return []
  const sourceText = normalizeText(source.text)
  const sourceNumbers = extractNumberTokens(source.text).map((token) => token.value)
  const failures: Failure[] = []
  const claimNumbers = extractNumberTokens(prose)
  const missingNumbers: string[] = []
  for (const token of claimNumbers) {
    if (!numberPresent(token.value, sourceNumbers, config.strictNumbers)) missingNumbers.push(token.raw)
  }
  if (missingNumbers.length > 0) {
    failures.push({
      kind: 'numeric-missing',
      severity: 'critical',
      detail: `来源中找不到数字 ${missingNumbers.join('、')}`,
      missing: missingNumbers,
    })
  }
  const missingEntities: string[] = []
  for (const entity of extractEntities(prose)) {
    // 实体按小写子串匹配：来源里换行/连字符被清洗后仍应能命中。
    if (!sourceText.includes(normalizeText(entity))) missingEntities.push(entity)
  }
  if (missingEntities.length > 0) {
    failures.push({
      kind: 'entity-missing',
      severity: 'major',
      detail: `来源中找不到专名 ${missingEntities.join('、')}`,
      missing: missingEntities,
    })
  }
  return failures
}
