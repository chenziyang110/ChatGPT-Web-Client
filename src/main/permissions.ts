import { isChatUrl } from '../core/validation';

export function allowChatGptClipboardWrite(permission: string, requestingUrl: string, isMainFrame: boolean): boolean {
  return permission === 'clipboard-sanitized-write' && isMainFrame && isChatUrl(requestingUrl);
}
