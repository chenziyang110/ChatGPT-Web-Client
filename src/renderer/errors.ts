/** Translate runtime diagnostics into a short message with a useful next step. */
export function friendlyError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const message = raw.replace(/^(?:Error:\s*)?(?:Error invoking remote method '[^']+':\s*)?(?:Error:\s*)?/, '').trim();
  const messages: [RegExp, string][] = [
    [/QUEUE_CHANGED/, '这条消息或队列已更新，请查看最新状态后再操作。'],
    [/Task queue is full/, '队列已满，请等待部分消息完成或移除不需要的条目。'],
    [/Use a personal .*conversation URL|Shared, temporary and special chats/, '当前会话暂不支持 Agent 协作，请切换到普通会话或新建会话。'],
    [/Only https:\/\/chatgpt.com|Invalid URL/, '这个链接暂不支持，请使用 ChatGPT 会话链接。'],
    [/USER_DECISION_REQUIRED/, '有任务需要确认，请到任务中心选择处理方式。'],
    [/STALE_DECISION/, '任务状态已更新，请重新打开任务详情。'],
    [/IDEMPOTENCY_CONFLICT|REQUEST_ALREADY_HANDLED/, '这次请求已被处理，请先查看原任务的状态。'],
    [/NEW_CHAT_UNRESOLVED|uncertain|可能已经发送/, '消息可能已发送，请先在任务中心核对结果。'],
    [/Account name confirmation does not match/, '账号名称不一致，请输入完整名称。'],
    [/Account alias already exists|Conversation alias already exists/, '这个名称已被使用，请换一个。'],
    [/Account not found/, '账号已不存在，请重新选择。'],
    [/Conversation not found/, '找不到这个会话，请重新选择。'],
    [/A maximum of 20 accounts/, '最多可添加 20 个账号，请先移除不再使用的账号。'],
    [/No page available|Select a conversation/, '请先打开一个会话，或新建会话。'],
    [/A new conversation requires/, '新建会话需要发送一条消息，请勾选发送后再试。'],
    [/LOGIN_REQUIRED/, '请先在网页中登录，再继续任务。'],
    [/VERIFICATION_REQUIRED/, '网页需要验证，请接管并完成验证。'],
    [/DRAFT_CONFLICT|DRAFT_CHANGED/, '网页中有未发送的草稿，请先处理草稿。'],
    [/timed out|timeout|ETIMEDOUT/i, '操作超时，请检查网络后重试。'],
    [/ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|Failed to fetch|fetch failed|ECONNREFUSED/i, '暂时无法连接，请检查网络和客户端是否正常运行。'],
    [/Runtime is stopping|Object has been destroyed/, '客户端正在关闭，请重新打开后再试。'],
  ];
  const match = messages.find(([pattern]) => pattern.test(message));
  if (match) return match[1];
  // Keep existing concise Chinese guidance; never display an exception stack.
  if (/^[\u3400-\u9fff]/.test(message) && message.length <= 110 && !message.includes('\n')) return message;
  return '操作未完成，请稍后重试。';
}
