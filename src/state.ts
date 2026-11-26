/**
 * 跨轮次状态：重写次数、上次失败单元、上次引用密度、是否已熔断。
 *
 * 四层流水线位置：L4（决策层）的输入来源之一。`decide()` 的 `previous`
 * 就来自这里，因此本文件只服务决策，不参与解析或验证。
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

/**
 * 创建一个空白的会话状态。
 *
 * `density` 取 0 而不是 null：首轮没有“上一轮密度”，
 * 决策层用 `previous.density > 0.05` 排除首轮，避免把 0 误判成骤降。
 *
 * @param turn - 当前回合号，原样写入 `lastTurn`。
 * @returns 初始化后的状态：无词元、无密度记忆、未重写、未熔断。
 * @example
 * createState(3)
 * // { lastTurn: 3, tokens: [], density: 0, rewrites: 0, lastDraft: '', aborted: false }
 */
function createState(turn: number): SessionState {
  return { lastTurn: turn, tokens: [], density: 0, rewrites: 0, lastDraft: '', aborted: false }
}

/**
 * 会话级状态仓库。
 *
 * 用 `WeakMap<object, SessionState>` 而不是普通 `Map`：会话对象被宿主回收后
 * 状态自动释放，插件不需要（也不应该）持有全局可变引用或手写清理逻辑。
 * key 声明为 `object` 是为了接受各宿主框架的会话实例，而不绑定具体类型。
 *
 * @example
 * const states = new TurnState()
 * const state = states.beginTurn(session, 3)
 * states.countRewrite(session)
 * state.rewrites // 1
 */
export class TurnState {
  /** 会话对象 → 该会话的校验状态；会话释放时条目随之消失。 */
  private readonly bySession = new WeakMap<object, SessionState>()

  /**
   * 进入（或延续）某个回合，返回其状态。
   *
   * turn 号变化时丢弃上一回合的记忆：重试额度是**按回合**发放的，
   * 否则用户第二次提问就会直接撞上“重试次数用尽”。
   *
   * @param session - 宿主会话对象，作为 WeakMap 的 key。
   * @param turn - 当前回合号；与已记录的不同即视为新回合。
   * @returns 该会话在本回合的状态（新建或复用）。
   * @example
   * const states = new TurnState()
   * const first = states.beginTurn(session, 3) // 新建，rewrites = 0
   * states.countRewrite(session)
   * const next = states.beginTurn(session, 4) // 新回合：rewrites 归零
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

  /**
   * 记录一次校验结果。
   *
   * 只覆盖“失败词元 / 密度 / 上次草稿”三项，**不动** `rewrites`：
   * 重写次数由 `countRewrite()` 单独维护，否则每次校验都会重复计数。
   * 会话不存在时静默返回（会话可能已被回收）。
   *
   * @param session - 宿主会话对象。
   * @param memory - 本次失败单元的尝试记忆（词元与密度）。
   * @param draft - 本次校验的草稿全文，用于下一轮去重。
   * @returns 无返回值。
   * @example
   * states.remember(session, { tokens: ['palm', '2023'], density: 8.5, rewrites: 1 }, draft)
   * // 之后 beginTurn(session, turn).density === 8.5
   */
  remember(session: object, memory: AttemptMemory, draft: string): void {
    const state = this.bySession.get(session)
    if (state === undefined) return
    state.tokens = memory.tokens
    state.density = memory.density
    state.lastDraft = draft
  }

  /**
   * 已发起重写：额度计数 +1。
   *
   * 只在反馈包真正注入模型之后调用，保证 `maxAttempts` 数的是“实际重试”，
   * 而不是“决定重试的次数”。
   *
   * @param session - 宿主会话对象。
   * @returns 无返回值。
   * @example
   * states.countRewrite(session)
   * states.beginTurn(session, 3).rewrites // 1
   */
  countRewrite(session: object): void {
    const state = this.bySession.get(session)
    if (state !== undefined) state.rewrites += 1
  }

  /**
   * 标记熔断（同一回合后续的 turn-stopping 直接放行）。
   *
   * 记原因是为了调试：只记一个 bool，事后无法区分是“检索不足”还是“原地打转”。
   *
   * @param session - 宿主会话对象。
   * @param reason - 熔断原因（来自 `Decision.reason`），仅用于日志排查。
   * @returns 无返回值。
   * @example
   * states.markAborted(session, '失败单元相似度 92%，超过阈值 85%')
   * states.beginTurn(session, 3).aborted // true
   */
  markAborted(session: object, reason: string): void {
    const state = this.bySession.get(session)
    if (state === undefined) return
    state.aborted = true
    state.abortReason = reason
  }

  /**
   * 会话结束或用户发新消息时重置，让下一轮重新获得重试额度。
   *
   * 这里直接 `delete` 而不是清字段：状态整体重建更简单，也不会残留
   * 上一轮的 `abortReason` 影响日志。
   *
   * @param session - 宿主会话对象。
   * @returns 无返回值。
   * @example
   * states.reset(session)
   * states.beginTurn(session, 9).rewrites // 0（额度已重置）
   */
  reset(session: object): void {
    this.bySession.delete(session)
  }
}
