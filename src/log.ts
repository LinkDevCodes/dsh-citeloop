/**
 * 控制台可观测层：把 CiteLoop 每一步的判定结果实时打到终端。
 *
 * 四层流水线位置：贯穿 L1（触发）→ L2（解析/取证）→ L3（验证）→ L4（决策）的旁路，
 * 只负责展示，不参与任何判定，因此纯逻辑层不依赖它。
 *
 * 为什么直接 `process.stdout.write` 而不是 `ctx.logger`：
 * DSH 在 web 模式下只把 warn 及以上转发到 stdout，`ctx.logger.info` 会被吞掉；
 * 而插件的 stdout 会被 `dshRunner.py` 逐行透传并着色，所以这里自己写、自己上色。
 *
 * 颜色全部是 ANSI 转义序列：
 * - Windows 10+ 的 Windows Terminal / PowerShell 7 原生支持；
 * - 老 conhost 需要先开启 VT（`dshRunner.py` 启动时会调用 `enableAnsi()`）；
 * - 重定向到文件时设 `NO_COLOR=1` 或 `CITELOOP_COLOR=0` 即可去掉转义字符。
 */
import type { VerificationReport } from './types.ts'

/** ANSI 复位。 */
const RESET = '\u001B[0m'

/** 各层标签的配色：L1 触发 / L2 解析 / L3 验证 / L4 决策。 */
const LAYER_COLOR: Readonly<Record<string, number>> = {
  L1: 36,
  L2: 96,
  L3: 33,
  L4: 35,
}

/**
 * 是否输出颜色。
 *
 * 默认开启：即便 stdout 是管道（runner 抓取后再打印），最终仍然落到终端。
 * 优先级有意如此：`CITELOOP_COLOR` 是插件专用开关，必须能覆盖通用的 `NO_COLOR`，
 * 便于在 CI / 日志采集环境里显式强制或关闭，而不依赖外部工具的约定。
 *
 * @returns 允许 ANSI 颜色时为 true；环境变量要求去色时为 false。
 * @example
 * process.env.CITELOOP_COLOR = '0'
 * colorEnabled() // false
 * delete process.env.CITELOOP_COLOR
 * process.env.NO_COLOR = '1'
 * colorEnabled() // false
 */
export function colorEnabled(): boolean {
  if (process.env.CITELOOP_COLOR === '0') return false
  if (process.env.CITELOOP_COLOR === '1') return true
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  return true
}

/**
 * 模块加载时求值一次：运行期再改环境变量不会影响本进程，
 * 也避免每写一行日志都读一次 env。
 */
const COLOR = colorEnabled()

/**
 * 给文本套上 ANSI 样式；`codes` 为空时原样返回。
 *
 * @param text - 待着色的文本。
 * @param codes - ANSI SGR 码，可传多个，如 32（绿）、33（黄）、90（灰）、1（加粗）。
 * @returns 着色后的文本；颜色关闭或无样式码时返回原文本。
 * @example
 * paint('L3 验证', 33) // 终端显示黄色；NO_COLOR=1 时原样返回 'L3 验证'
 */
function paint(text: string, ...codes: readonly number[]): string {
  return COLOR && codes.length > 0 ? `\u001B[${codes.join(';')}m${text}${RESET}` : text
}

/** 统一的日志前缀，runner 靠 `[citeloop]` 这个字面量识别插件输出。 */
const TAG = paint('[citeloop]', 36)

/** 详细的中间步骤是否输出（`verbose: false` 时只留每回合一行结论）。 */
let verbose = true

/**
 * 设置详细程度，由 `apply()` 按配置调用一次。
 *
 * @param value - true 输出逐层日志；false 只保留结论级日志。
 * @returns 无返回值。
 * @example
 * setVerbose(false)
 * isVerbose() // false
 */
export function setVerbose(value: boolean): void {
  verbose = value
}

/**
 * 当前是否输出详细日志。
 *
 * @returns 详细模式为 true；否则 false。
 * @example
 * isVerbose() // true（默认）
 */
export function isVerbose(): boolean {
  return verbose
}

/**
 * 写一行到 stdout。插件运行在 DSH 进程里，stdout 会被 runner 捕获。
 *
 * 统一在这里补换行，避免每个调用点各写一遍 `\n` 导致格式不一致。
 *
 * @param line - 不含换行的整行文本（可含 ANSI 转义）。
 * @returns 无返回值（副作用：向 stdout 写一行）。
 * @example
 * emit('hello') // stdout 出现 "hello\n"
 */
function emit(line: string): void {
  process.stdout.write(`${line}\n`)
}

/**
 * 毫秒数格式化：`842ms` / `1.8s`。
 *
 * 超过 1 秒改用秒并保留一位小数：耗时大多是 0~50ms，毫秒整数更好读；
 * 抓取来源时才可能到秒级，用秒能少占几列。
 *
 * @param ms - 耗时毫秒数，非负。
 * @returns 形如 `842ms` 或 `1.8s` 的短字符串。
 * @example
 * formatMs(842) // '842ms'
 * formatMs(1840) // '1.8s'
 */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * 单位数的短横：`u2,u4` 这种。
 *
 * 截断后附 `…+N`：失败单元可能很多，一行日志要保证首屏可读，
 * 完整列表在 L3 明细里已有。
 *
 * @param ids - 单元编号列表，例如 `['u1', 'u3']`。
 * @param limit - 最多展示几个，默认 6。
 * @returns 逗号连接的短串；超出部分折叠为 `…+N`。
 * @example
 * unitList(['u1', 'u2', 'u3']) // 'u1, u2, u3'
 * unitList(['u1', 'u2', 'u3'], 2) // 'u1, u2 …+1'
 */
function unitList(ids: readonly string[], limit = 6): string {
  const shown = ids.slice(0, limit)
  const rest = ids.length - shown.length
  return shown.join(', ') + (rest > 0 ? ` …+${String(rest)}` : '')
}

/**
 * 插件装配完成的横幅。
 *
 * 这一行刻意带上英文标记 `plugin-loaded`：`dshRunner.py` 用它来判断
 * “插件真的被 cordis 装配了”，进而打印带颜色的成功横幅。
 *
 * @param detail - 附加信息（例如模式、阈值摘要），直接拼在行尾。
 * @returns 无返回值。
 * @example
 * logReady('mode=mark · 阈值 0.35')
 * // [citeloop] ✔ plugin-loaded · CiteLoop 引用校验已装配 · mode=mark · 阈值 0.35
 */
export function logReady(detail: string): void {
  emit(`${TAG} ${paint('✔ plugin-loaded', 32, 1)} · CiteLoop 引用校验已装配 · ${detail}`)
}

/**
 * L1：回合即将结束，钩子拿到草稿。
 *
 * `verbose: false` 时也输出：每回合至少留一行，否则日志里看不出插件跑过。
 *
 * @param turn - 回合号，来自 `agent/turn-stopping`。
 * @param chars - 草稿字符数。
 * @returns 无返回值。
 * @example
 * logTurn(3, 1280)
 * // [citeloop] ── L1 触发 ── turn=3 · 草稿 1280 字
 */
export function logTurn(turn: number, chars: number): void {
  if (!verbose) return
  emit(`${TAG} ${paint('── L1 触发 ──', LAYER_COLOR.L1 ?? 36)} turn=${String(turn)} · 草稿 ${String(chars)} 字`)
}

/**
 * L2：解析或取证的中间统计（由 `pipeline.ts` 的 stage 回调驱动）。
 *
 * 三个阶段的字段不同，所以按 `stage` 分支取值并给默认值：
 * 日志层不应因为某个阶段少传一个计数就抛异常。
 *
 * @param event - 阶段事件：`stage` 取 `extract` | `sources` | `verify`，`ms` 为该阶段耗时（毫秒），
 * `detail` 为各阶段计数（缺少的字段按 0 处理）。
 * @returns 无返回值。
 * @example
 * logStage({ stage: 'extract', ms: 3, detail: { citations: 4, units: 2, references: 1 } })
 * // [citeloop]    L2 解析 · 引用 4 条 · 陈述单元 2 个 · 参考条目 1 条 3ms
 */
export function logStage(event: { readonly stage: string; readonly ms: number; readonly detail: Readonly<Record<string, number>> }): void {
  if (!verbose) return
  const cost = paint(formatMs(event.ms), 90)
  if (event.stage === 'extract') {
    const { citations = 0, references = 0, units = 0 } = event.detail
    emit(`${TAG}    ${paint('L2 解析', LAYER_COLOR.L2 ?? 96)} · 引用 ${String(citations)} 条 · 陈述单元 ${String(units)} 个 · 参考条目 ${String(references)} 条 ${cost}`)
    return
  }
  if (event.stage === 'sources') {
    const { available = 0, unreachable = 0 } = event.detail
    const tone = unreachable > 0 ? 33 : 32
    emit(`${TAG}    ${paint('L2 取证', LAYER_COLOR.L2 ?? 96)} · 可读来源 ${paint(String(available), tone)} 个 · 不可达 ${paint(String(unreachable), unreachable > 0 ? 33 : 90)} 个 ${cost}`)
    return
  }
  const { supported = 0, partial = 0, unsupported = 0, unreachable = 0, skipped = 0 } = event.detail
  emit(`${TAG}    ${paint('L3 验证', LAYER_COLOR.L3 ?? 33)} · 达标 ${paint(String(supported), 32)} · 部分 ${paint(String(partial), 33)} · 无支撑 ${paint(String(unsupported), 31)} · 不可达 ${String(unreachable)} · 跳过 ${paint(String(skipped), 90)} ${cost}`)
}

/**
 * L3 明细：逐个失败单元列出首要失败类型与覆盖率。
 *
 * 只列失败项，并默认截断到 6 条：明细是给人看的，不是给机器解析的，
 * 首屏能看完比“全量”更重要（完整报告走 `formatReport`）。
 *
 * @param report - L3 验证报告。
 * @param limit - 最多展示几个失败单元，默认 6。
 * @returns 无返回值。
 * @example
 * logVerdicts(report, 6)
 * // [citeloop]       ✘ u2 覆盖率 18% · numeric-missing · 2023 未在来源中出现
 */
export function logVerdicts(report: VerificationReport, limit = 6): void {
  if (!verbose) return
  const failing = report.units.filter((verdict) => verdict.status === 'unsupported' || verdict.status === 'partial' || verdict.status === 'unreachable')
  if (failing.length === 0) return
  for (const verdict of failing.slice(0, limit)) {
    const first = verdict.failures[0]
    const kinds = verdict.failures.map((failure) => failure.kind).join(',')
    const tail = first === undefined ? kinds : `${kinds} · ${first.detail}`
    emit(`${TAG}       ${paint(`✘ ${verdict.unit.id}`, 31)} ${paint(`覆盖率 ${(verdict.coverage * 100).toFixed(0)}%`, 90)} · ${tail}`)
  }
  const rest = failing.length - Math.min(failing.length, limit)
  if (rest > 0) emit(`${TAG}       ${paint(`…另有 ${String(rest)} 个单元被截断`, 90)}`)
}

/**
 * L4：通过，直接放行。
 *
 * 放行是每回合的最终结论之一，因此不受 `verbose` 影响。
 *
 * @param summary - 单行摘要（通常来自 `summarizeReport`）。
 * @param ms - 本次校验总耗时（毫秒）。
 * @returns 无返回值。
 * @example
 * logPass('单元 4（supported 4 / …）；引用 5 条，已解析 4 条', 12)
 * // [citeloop] ✔ 放行 · 单元 4（…）… （校验 12ms）
 */
export function logPass(summary: string, ms: number): void {
  emit(`${TAG} ${paint('✔ 放行', 32, 1)} · ${summary} ${paint(`（校验 ${formatMs(ms)}）`, 90)}`)
}

/**
 * L4：`mark` 模式下的标记（不阻断）。
 *
 * 这里必须明说“未阻断”：`mark` 是默认模式，用户看到失败项时
 * 容易误以为回答被拦截，日志要提前消除这个歧义。
 *
 * @param reason - 决策原因（来自 `Decision.reason`）。
 * @param units - 失败单元编号列表；为空时不追加该段。
 * @returns 无返回值。
 * @example
 * logAnnotate('mode=mark，仅标记不拦截', ['u2'])
 * // [citeloop] ! 标记 · 未阻断（mark 模式）· mode=mark，仅标记不拦截 · 失败单元 u2
 */
export function logAnnotate(reason: string, units: readonly string[]): void {
  emit(`${TAG} ${paint('! 标记', 33, 1)} · 未阻断（mark 模式）· ${reason}${units.length > 0 ? paint(` · 失败单元 ${unitList(units)}`, 90) : ''}`)
}

/**
 * L4：退回重写（尚未真正注入反馈）。
 *
 * 与 `logSteer` 分两步打印：先记“决定重写”，注入成功后再记“已注入”，
 * 这样中途失败时能看出卡在哪一步。
 *
 * @param attempt - 本次是第几次重写，从 1 开始。
 * @param max - 允许的最大重写次数。
 * @param units - 失败单元编号列表。
 * @returns 无返回值。
 * @example
 * logRewrite(1, 2, ['u2', 'u5'])
 * // [citeloop] ↻ 退回重写 · 第 1/2 次 · 失败单元 u2, u5
 */
export function logRewrite(attempt: number, max: number, units: readonly string[]): void {
  emit(`${TAG} ${paint('↻ 退回重写', 35, 1)} · 第 ${String(attempt)}/${String(max)} 次 · 失败单元 ${unitList(units)}`)
}

/**
 * L4：反馈包已通过 `agent.steer()` 注入，模型会再跑一个 step。
 *
 * @param chars - 注入的反馈包字符数。
 * @returns 无返回值。
 * @example
 * logSteer(820)
 * // [citeloop]    → steer(next-step) 已注入反馈包 820 字
 */
export function logSteer(chars: number): void {
  emit(`${TAG}    ${paint('→ steer(next-step)', 90)} 已注入反馈包 ${paint(`${String(chars)} 字`, 36)}`)
}

/**
 * L4：熔断。
 *
 * `cause` 单独着色并保留英文枚举名：它是排查与统计用的稳定键，
 * 中文 `reason` 才是给人读的解释，两者不能混。
 *
 * @param cause - 熔断原因枚举，如 `unstable-iteration`、`insufficient-retrieval`。
 * @param reason - 面向人的解释（来自 `Decision.reason`）。
 * @returns 无返回值。
 * @example
 * logAbort('unstable-iteration', '连续两次失败单元相似度 92%，超过熔断阈值 85%')
 * // [citeloop] ⛔ 熔断 · cause=unstable-iteration · 连续两次…（红色）
 */
export function logAbort(cause: string, reason: string): void {
  emit(`${TAG} ${paint('⛔ 熔断', 31, 1)} · cause=${paint(cause, 33)} · ${reason}`)
}

/**
 * 证据旁路：检索类工具的输出被回收为来源。
 *
 * 这条日志用于确认“证据真的抓到了”，否则重写失败时无法判断是模型没改
 * 还是根本没有可用材料。
 *
 * @param tool - 工具名，如 `web_search`、`web_fetch`。
 * @param label - 来源的短标签。
 * @returns 无返回值。
 * @example
 * logEvidence('web_search', 'PaLM · Google Research Blog')
 * // [citeloop]    evidence ← web_search · PaLM · Google Research Blog
 */
export function logEvidence(tool: string, label: string): void {
  if (!verbose) return
  emit(`${TAG}    ${paint('evidence', 90)} ← ${paint(tool, 36)} · ${label}`)
}

/**
 * 警告（配置降级、校验异常等）。
 *
 * 不受 `verbose` 影响：警告可能解释“为什么行为退化了”，
 * 即使关掉详细日志也必须让用户知道。
 *
 * @param message - 警告正文。
 * @returns 无返回值。
 * @example
 * logWarn('未知的 mode "strict"，已退回 mark') // [citeloop] ! 未知的 mode…
 */
export function logWarn(message: string): void {
  emit(`${TAG} ${paint('!', 33)} ${message}`)
}

/**
 * 错误。
 *
 * 同样不受 `verbose` 影响：错误是用户必须看到的信息。
 *
 * @param message - 错误正文。
 * @returns 无返回值。
 * @example
 * logError('校验异常：fetch 超时') // [citeloop] ✘ 校验异常：fetch 超时
 */
export function logError(message: string): void {
  emit(`${TAG} ${paint('✘', 31)} ${message}`)
}

/**
 * 调试级细节：`verbose: false` 时完全静默。
 *
 * @param message - 调试正文。
 * @returns 无返回值。
 * @example
 * logDebug('skip u7: 词元不足') // verbose 时输出；否则无输出
 */
export function logDebug(message: string): void {
  if (!verbose) return
  emit(`${TAG} ${paint('·', 90)} ${paint(message, 90)}`)
}
