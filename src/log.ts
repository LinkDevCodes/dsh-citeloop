/**
 * 控制台可观测层：把 CiteLoop 每一步的判定结果实时打到终端。
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
 */
export function colorEnabled(): boolean {
  if (process.env.CITELOOP_COLOR === '0') return false
  if (process.env.CITELOOP_COLOR === '1') return true
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false
  return true
}

const COLOR = colorEnabled()

/** 给文本套上 ANSI 样式；`codes` 为空时原样返回。 */
function paint(text: string, ...codes: readonly number[]): string {
  return COLOR && codes.length > 0 ? `\u001B[${codes.join(';')}m${text}${RESET}` : text
}

/** 统一的日志前缀，runner 靠 `[citeloop]` 这个字面量识别插件输出。 */
const TAG = paint('[citeloop]', 36)

/** 详细的中间步骤是否输出（`verbose: false` 时只留每回合一行结论）。 */
let verbose = true

/** 设置详细程度，由 `apply()` 按配置调用一次。 */
export function setVerbose(value: boolean): void {
  verbose = value
}

/** 当前是否输出详细日志。 */
export function isVerbose(): boolean {
  return verbose
}

/** 写一行到 stdout。插件运行在 DSH 进程里，stdout 会被 runner 捕获。 */
function emit(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** 毫秒数格式化：`842ms` / `1.8s`。 */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 单位数的短横：`u2,u4` 这种。 */
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
 */
export function logReady(detail: string): void {
  emit(`${TAG} ${paint('✔ plugin-loaded', 32, 1)} · CiteLoop 引用校验已装配 · ${detail}`)
}

/** L1：回合即将结束，钩子拿到草稿。 */
export function logTurn(turn: number, chars: number): void {
  if (!verbose) return
  emit(`${TAG} ${paint('── L1 触发 ──', LAYER_COLOR.L1 ?? 36)} turn=${String(turn)} · 草稿 ${String(chars)} 字`)
}

/** L2：解析或取证的中间统计（由 `pipeline.ts` 的 stage 回调驱动）。 */
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

/** L3 明细：逐个失败单元列出首要失败类型与覆盖率。 */
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

/** L4：通过，直接放行。 */
export function logPass(summary: string, ms: number): void {
  emit(`${TAG} ${paint('✔ 放行', 32, 1)} · ${summary} ${paint(`（校验 ${formatMs(ms)}）`, 90)}`)
}

/** L4：`mark` 模式下的标记（不阻断）。 */
export function logAnnotate(reason: string, units: readonly string[]): void {
  emit(`${TAG} ${paint('! 标记', 33, 1)} · 未阻断（mark 模式）· ${reason}${units.length > 0 ? paint(` · 失败单元 ${unitList(units)}`, 90) : ''}`)
}

/** L4：退回重写（尚未真正注入反馈）。 */
export function logRewrite(attempt: number, max: number, units: readonly string[]): void {
  emit(`${TAG} ${paint('↻ 退回重写', 35, 1)} · 第 ${String(attempt)}/${String(max)} 次 · 失败单元 ${unitList(units)}`)
}

/** L4：反馈包已通过 `agent.steer()` 注入，模型会再跑一个 step。 */
export function logSteer(chars: number): void {
  emit(`${TAG}    ${paint('→ steer(next-step)', 90)} 已注入反馈包 ${paint(`${String(chars)} 字`, 36)}`)
}

/** L4：熔断。 */
export function logAbort(cause: string, reason: string): void {
  emit(`${TAG} ${paint('⛔ 熔断', 31, 1)} · cause=${paint(cause, 33)} · ${reason}`)
}

/** 证据旁路：检索类工具的输出被回收为来源。 */
export function logEvidence(tool: string, label: string): void {
  if (!verbose) return
  emit(`${TAG}    ${paint('evidence', 90)} ← ${paint(tool, 36)} · ${label}`)
}

/** 警告（配置降级、校验异常等）。 */
export function logWarn(message: string): void {
  emit(`${TAG} ${paint('!', 33)} ${message}`)
}

/** 错误。 */
export function logError(message: string): void {
  emit(`${TAG} ${paint('✘', 31)} ${message}`)
}

/** 调试级细节：`verbose: false` 时完全静默。 */
export function logDebug(message: string): void {
  if (!verbose) return
  emit(`${TAG} ${paint('·', 90)} ${paint(message, 90)}`)
}
