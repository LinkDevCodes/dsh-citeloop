/**
 * 离线自测：不联网、不启动 DSH，直接跑一遍 L2 → L3 → L4 的关键路径。
 *
 * 为什么不用测试框架：插件是独立目录、只 link 了 harness 的源码包，
 * 引入 vitest 会让“装依赖 → 跑测试”这条链路和宿主版本耦合。
 * 这里用 `node:assert` 手写一个极小的 runner，`pnpm selftest` 即可跑。
 *
 * 运行：`node ../deepseek-harness/node_modules/tsx/dist/cli.mjs scripts/selftest.ts`
 */
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.ts'
import { decide } from '../src/decide.ts'
import type { AttemptMemory } from '../src/decide.ts'
import { buildUnits, extract } from '../src/extract.ts'
import { verifyText } from '../src/pipeline.ts'
import type { FetchImpl } from '../src/pipeline.ts'
import { EvidenceRegistry, evidenceFromTool } from '../src/sources.ts'
import { TurnState } from '../src/state.ts'
import { extractNumberTokens, splitSentences, tokenize } from '../src/text.ts'
import type { SourceDoc } from '../src/types.ts'
import { failureTokens } from '../src/verify.ts'

const config = resolveConfig(DEFAULT_CONFIG)

/** 构造一份可用的来源。 */
function source(url: string, text: string): SourceDoc {
  return {
    id: url,
    label: url,
    url,
    text,
    origin: 'inline-url',
    retrievedAt: 1_700_000_000_000,
    status: 'available',
  }
}

/** 按 URL 查表的假抓取器：表里没有的 URL 一律当作“打不开”。 */
function fakeFetch(table: ReadonlyMap<string, SourceDoc>): FetchImpl {
  return async (url, _config, origin) => table.get(url) ?? {
    id: url,
    label: url,
    url,
    text: '',
    origin,
    retrievedAt: 1_700_000_000_000,
    status: 'unreachable',
    error: 'not found',
  }
}

const PLUGIN_DOC = source(
  'https://example.com/plugin',
  'DSH 的插件在启动时通过 cordis.yml 注册，cordis 加载器会读取配置文件并解析插件入口。',
)
const PERF_DOC = source(
  'https://example.com/perf',
  '插件启动耗时约 1200 毫秒，测试环境为 Windows 桌面版。',
)

const GOOD_DRAFT = [
  'DSH 的插件在启动时通过 cordis.yml 注册 [1]。启动耗时约 1200 毫秒 [2]。',
  '',
  '## 参考资料',
  '[1] DSH 插件文档. https://example.com/plugin',
  '[2] 启动性能报告. https://example.com/perf',
].join('\n')

const WRONG_NUMBER_DRAFT = GOOD_DRAFT.replace('1200 毫秒', '900 毫秒')

const TABLE = new Map<string, SourceDoc>([
  ['https://example.com/plugin', PLUGIN_DOC],
  ['https://example.com/perf', PERF_DOC],
])
const fetchOk = fakeFetch(TABLE)
const fetchDown = fakeFetch(new Map())

let passed = 0
const failures: string[] = []

async function test(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    console.log(`  FAIL ${name}`)
  }
}

// ---- L0 文本工具 ---------------------------------------------------------------

await test('splitSentences 按中英文标点断句', () => {
  const sentences = splitSentences('第一句话。第二句话！Third one.')
  assert.equal(sentences.length, 3)
})

await test('tokenize 为中文生成二元词元', () => {
  const tokens = tokenize('引用校验')
  assert.ok(tokens.includes('引用'))
  assert.ok(tokens.includes('校验'))
})

await test('extractNumberTokens 抽出数字并归一化', () => {
  const numbers = extractNumberTokens('约 1,200 毫秒，占 35%')
  const raws = numbers.map((token) => token.raw)
  const values = numbers.map((token) => token.value)
  assert.ok(values.includes('1200'), `未抽到 1,200：${JSON.stringify(values)}`)
  assert.ok(values.includes('35'))
  assert.ok(raws.some((raw) => raw.includes('1,200')), `raw 丢了千分位：${JSON.stringify(raws)}`)
})

// ---- L2 解析 -------------------------------------------------------------------

await test('extract 识别数字引用与参考资料条目', () => {
  const extraction = extract(GOOD_DRAFT)
  assert.equal(extraction.references.length, 2)
  assert.ok(extraction.citations.length >= 2)
  assert.ok(extraction.citations.every((citation) => citation.kind === 'numeric'))
})

await test('buildUnits 把引用绑定到句子并去掉标记', () => {
  const units = buildUnits(GOOD_DRAFT, extract(GOOD_DRAFT))
  assert.ok(units.length > 0)
  for (const unit of units) {
    assert.ok(!unit.prose.includes('[1]'), `正文里残留引用标记：${unit.prose}`)
    assert.ok(unit.citations.length > 0)
  }
})

// ---- L3 验证 -------------------------------------------------------------------

await test('来源能支撑的草稿整体通过', async () => {
  const { report } = await verifyText(GOOD_DRAFT, config, fetchOk)
  assert.equal(report.units.length, 2)
  assert.ok(report.allSupported, `未通过：${JSON.stringify(report.units.map((unit) => unit.failures))}`)
  assert.equal(report.stats.unsupported, 0)
})

await test('数字与来源不符时判 numeric-missing', async () => {
  const { report } = await verifyText(WRONG_NUMBER_DRAFT, config, fetchOk)
  assert.equal(report.allSupported, false)
  const kinds = report.units.flatMap((unit) => unit.failures.map((failure) => failure.kind))
  assert.ok(kinds.includes('numeric-missing'), `实际失败：${JSON.stringify(kinds)}`)
})

await test('来源打不开时单元落到 unreachable', async () => {
  const { report } = await verifyText(GOOD_DRAFT, config, fetchDown)
  assert.ok(report.units.every((unit) => unit.status === 'unreachable'))
  assert.equal(report.allSupported, false)
})

// ---- L4 决策 -------------------------------------------------------------------

await test('全部通过 → pass', async () => {
  const { report } = await verifyText(GOOD_DRAFT, config, fetchOk)
  const decision = decide({ report, config, evidence: [] })
  assert.equal(decision.kind, 'pass')
})

await test('mark 模式：有材料可修 → annotate（不阻断）', async () => {
  const { report } = await verifyText(WRONG_NUMBER_DRAFT, config, fetchOk)
  const decision = decide({ report, config, evidence: [PERF_DOC] })
  assert.equal(decision.kind, 'annotate')
})

await test('rewrite 模式：有材料可修 → rewrite，反馈带单元编号', async () => {
  const { report } = await verifyText(WRONG_NUMBER_DRAFT, config, fetchOk)
  const rewriteConfig = resolveConfig({ ...config, mode: 'rewrite' })
  const decision = decide({ report, config: rewriteConfig, evidence: [PERF_DOC] })
  assert.equal(decision.kind, 'rewrite')
  if (decision.kind === 'rewrite') {
    assert.ok(/u\d/.test(decision.feedback), `反馈包里没有单元编号：${decision.feedback.slice(0, 120)}`)
    assert.ok(decision.feedback.includes('900'), '反馈包里没有原句')
  }
})

await test('检索不足 → abort insufficient-retrieval（且不重试）', async () => {
  const { report } = await verifyText(GOOD_DRAFT, config, fetchDown)
  const rewriteConfig = resolveConfig({ ...config, mode: 'rewrite' })
  const decision = decide({ report, config: rewriteConfig, evidence: [] })
  assert.equal(decision.kind, 'abort')
  if (decision.kind === 'abort') assert.equal(decision.cause, 'insufficient-retrieval')
})

await test('失败单元原地打转 → abort unstable-iteration', async () => {
  const { report } = await verifyText(WRONG_NUMBER_DRAFT, config, fetchOk)
  const rewriteConfig = resolveConfig({ ...config, mode: 'rewrite' })
  const previous: AttemptMemory = { tokens: failureTokens(report), density: report.citationDensity, rewrites: 1 }
  const decision = decide({ report, config: rewriteConfig, evidence: [PERF_DOC], previous })
  assert.equal(decision.kind, 'abort')
  if (decision.kind === 'abort') assert.equal(decision.cause, 'unstable-iteration')
})

await test('重写次数用尽 → abort attempts-exhausted', async () => {
  const { report } = await verifyText(WRONG_NUMBER_DRAFT, config, fetchOk)
  const rewriteConfig = resolveConfig({ ...config, mode: 'rewrite', maxAttempts: 1 })
  const previous: AttemptMemory = { tokens: ['完全不同', '的词元'], density: report.citationDensity, rewrites: 1 }
  const decision = decide({ report, config: rewriteConfig, evidence: [PERF_DOC], previous })
  assert.equal(decision.kind, 'abort')
  if (decision.kind === 'abort') assert.equal(decision.cause, 'attempts-exhausted')
})

// ---- 跨轮次状态 ----------------------------------------------------------------

await test('TurnState 按回合发放重试额度', () => {
  const turns = new TurnState()
  const session = {}
  const first = turns.beginTurn(session, 1)
  turns.countRewrite(session)
  turns.countRewrite(session)
  assert.equal(first.rewrites, 2)
  const second = turns.beginTurn(session, 2)
  assert.equal(second.rewrites, 0, '新回合应当重置重试次数')
  turns.markAborted(session, '测试')
  assert.equal(turns.beginTurn(session, 2).aborted, true)
})

await test('EvidenceRegistry 去重并可按会话取回', () => {
  const registry = new EvidenceRegistry()
  const session = {}
  registry.record(session, PLUGIN_DOC)
  registry.record(session, PLUGIN_DOC)
  assert.equal(registry.get(session).length, 1)
  registry.clear(session)
  assert.equal(registry.get(session).length, 0)
})

await test('evidenceFromTool 能把工具输出压成来源', () => {
  const doc = evidenceFromTool('web_fetch', { url: 'https://example.com/plugin' }, [
    { type: 'text', text: 'DSH 的插件通过 cordis.yml 注册。' },
  ])
  assert.ok(doc !== undefined)
  assert.equal(doc?.status, 'available')
  assert.equal(doc?.origin, 'retrieval')
})

// ---- 插件装配面 ----------------------------------------------------------------

await test('插件导出 name / inject / apply', async () => {
  const plugin = await import('../src/index.ts')
  assert.equal(plugin.name, 'citeloop')
  assert.ok(plugin.inject.includes('tools'))
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function')
})

// ---- 汇总 ----------------------------------------------------------------------

console.log(`\n${passed} 项通过，${failures.length} 项失败`)
for (const failure of failures) console.log(`- ${failure}`)
if (failures.length > 0) process.exitCode = 1
