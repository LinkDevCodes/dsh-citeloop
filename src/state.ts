/**
 * 跨轮次状态：重写次数、上次失败单元、上次引用密度、是否已熔断。
 *
 * 用 `WeakMap<Session, state>` 保存：一个会话的校验历史只属于它自己，
 * 会话被回收后自动释放，插件不持有任何全局可变引用。
 *
 * 注意这不是“缓存验证结果”——每次校验都要重跑；这里只存**决策需要的历史信号**。
 * 回合边界用 `agent/turn-stopping` 带来的 `turn` 号判定：
 * 同一回合内的 steer 重写共享重试额度，用户发新消息后额度重置。
 */
import type { AttemptMemory } from './decide.ts'

/** 单个会话的校验状态。 */
export interface SessionState {
  /** 当前状态所属的回合号；`turn` 变化意味着用户开了新一轮。 */
  lastTurn: number
  /** 上次失败单元的词元（收敛检测）。 */
  tokens: readonly string[]
  /** 上次引用密度（规避检测）。 */
  density: number
  /** 本回合已发起的重写次数。 */
  rewrites: number
  /** 上次校验过的草稿，用于避免同一草稿被重复校验。 */
  lastDraft: string
  /** 是否已熔断：熔断后本回合不再校验，避免无限 steer。 */
  aborted: boolean
  /** 熔断原因（调试用）。 */
  abortReason?: string
}

function createState(turn: number): SessionState {
  return { lastTurn: turn, tokens: [], density: 0, rewrites: 0, lastDraft: '', aborted: false }
}

/** 会话级状态仓库。 */
export class TurnState {
  private readonly bySession = new WeakMap<object, SessionState>()

  /**
   * 进入（或延续）某个回合，返回其状态。
   *
   * turn 号变化时丢弃上一回合的记忆：重试额度是**按回合**发放的，
   * 否则用户第二次提问就会直接撞上“重试次数用尽”。
   */
  beginTurn(session: object, turn: number): SessionState {
    const existing = this.bySession.get(session)
    if (existing === undefined) {
      const created = createState(turn)
      this.bySession.set(session, created)
      return created
    }
    if (existing.lastTurn !== turn) {
      const reset = createState(turn)
      this.bySession.set(session, reset)
      return reset
    }
    return existing
  }

  /** 记录一次校验结果。 */
  remember(session: object, memory: AttemptMemory, draft: string): void {
    const state = this.bySession.get(session)
    if (state === undefined) return
    state.tokens = memory.tokens
    state.density = memory.density
    state.lastDraft = draft
  }

  /** 已发起重写：额度计数 +1。 */
  countRewrite(session: object): void {
    const state = this.bySession.get(session)
    if (state !== undefined) state.rewrites += 1
  }

  /** 标记熔断（同一回合后续的 turn-stopping 直接放行）。 */
  markAborted(session: object, reason: string): void {
    const state = this.bySession.get(session)
    if (state === undefined) return
    state.aborted = true
    state.abortReason = reason
  }

  /** 会话结束或用户发新消息时重置，让下一轮重新获得重试额度。 */
  reset(session: object): void {
    this.bySession.delete(session)
  }
}
