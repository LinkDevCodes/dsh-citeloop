/**
 * L3 锚定检查：数字锚定 + 实体锚定。
 *
 * 这是整套验证里**最不容易产生争议**的一层：
 * 年份、百分比、样本量、页码必须能在来源里找到；缩写/专名必须原样出现。
 * 它不判断“语义是否蕴含”，只判断“这些硬事实是否在场”，因此
 * 假阳性极低——也正因如此，它被放在一期的最小可行验证器里。
 */
import type { Failure, SourceDoc } from './types.ts'
import type { ResolvedConfig } from './config.ts'
import { extractEntities, extractNumberTokens, normalizeText } from './text.ts'

/** 小数位数为 0 的整数数字（年份、页码、样本量）。 */
function isIntegerValue(value: string): boolean {
  return /^\d+$/.test(value)
}

/**
 * 判断一个数字锚点在来源里是否存在。
 *
 * 严格模式下要求字面值完全一致；非严格模式允许小数相对误差 1%
 * （来源常把 `37.5%` 写成 `37.53%`，或把 `1,200` 写成 `1200`）。
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
 * @param prose - 去掉引用标记后的陈述句。
 * @param source - 被引用的来源。
 * @param config - `strictNumbers` 影响小数比对口径。
 * @returns 锚定失败列表（可能为空）。
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
