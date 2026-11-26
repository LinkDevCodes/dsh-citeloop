/**
 * 会话消息读取辅助（L1 触发层的输入侧）。
 *
 * 钩子（`agent/turn-stopping`）和斜杠命令（`/citeloop`）都要回答同一个问题：
 * “这一轮模型最后想给用户看的正文是什么”。把它抽成一处，
 * 避免两边各写一遍倒序查找、也避免两处口径不一致。
 */
import type { Message } from '@deepseek-ai/dsh-llm'
import { blocksToText } from './text.ts'

/**
 * 取最后一条 assistant 消息的纯文本。
 *
 * `deriveMessages()` 返回的是按 surface 折叠后的**有效**历史，所以这里拿到的
 * 就是模型本轮真正想问用户的那段话（不含被折叠掉的中间步骤）。
 * 图片、工具调用等非文本块由 `blocksToText` 过滤掉。
 *
 * 注意：这里不做任何“是否像最终答案”的判断——工具调用进行到一半时，
 * 最后一条 assistant 消息可能只有一句引导语；那种情况由调用方用
 * “草稿与上次相同”“草稿为空”等守卫跳过校验，而不是在这里猜。
 *
 * @param messages - 会话的有效历史，通常来自 `agent.session.deriveMessages()`。
 * @returns 最后一条 assistant 消息的文本；没有任何 assistant 消息时返回空字符串。
 * @example
 * // 钩子里取本轮草稿
 * const draft = lastAssistantText(agent.session.deriveMessages())
 * if (draft.trim().length === 0) return // 只有工具调用、没有正文，无需校验
 * @example
 * // 命令里校验“上一条回答”
 * const draft = lastAssistantText(invocation.agent.session.deriveMessages())
 */
export function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.role === 'assistant') {
      return blocksToText(message.content)
    }
  }
  return ''
}
