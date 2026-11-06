// Also serialized into the sandboxed page; keep this parser self-contained.
export function parseConversationPath(pathname: string): { pathname: string; remoteId: string; kind: 'chat' | 'project' | 'dot' } | undefined {
  const chat = /^\/c\/([a-zA-Z0-9_-]{1,128})\/?$/.exec(pathname);
  if (chat) return { pathname: `/c/${chat[1]}`, remoteId: chat[1], kind: 'chat' };
  const project = /^\/g\/(g-p-[a-zA-Z0-9_-]{1,256})\/c\/([a-zA-Z0-9_-]{1,128})\/?$/.exec(pathname);
  if (project) return { pathname: `/g/${project[1]}/c/${project[2]}`, remoteId: `project:${project[1]}:${project[2]}`, kind: 'project' };
  const dot = /^\/dots\/([a-zA-Z0-9_-]{1,128}(?:~[a-zA-Z0-9_-]{1,128})?)\/?$/.exec(pathname);
  if (dot) return { pathname: `/dots/${dot[1]}`, remoteId: `dot:${dot[1]}`, kind: 'dot' };
}
