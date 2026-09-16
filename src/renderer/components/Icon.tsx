import type { CSSProperties } from 'react';

const paths = {
  trash: <><path d="M3 6h18M9 6V3h6v3m-8 0 1 15h8l1-15M10 10v7m4-7v7" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  tasks: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="m8 8 1 1 2-2m2 1h3M8 13h8m-8 4h5" /></>,
  settings: <><path d="m9 3-1 3-3 1-2 3 2 2v3l3 1 1 3h4l1-3 3-1v-3l2-2-2-3-3-1-1-3Z" transform="translate(1 1)" /><circle cx="12" cy="12" r="3" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  back: <path d="M19 12H5m5-5-5 5 5 5" />,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 6a8 8 0 0 1 13 3M5 15a8 8 0 0 0 13 3" /></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1" />,
  restore: <><path d="M9 5V3h12v12h-2" /><rect x="3" y="9" width="12" height="12" rx="1" /></>,
  chat: <path d="M20 14a3 3 0 0 1-3 3H9l-5 4V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3ZM8 8h8m-8 4h5" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  snapshot: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 13h4m-4 3h8" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  send: <><path d="m3 10 18-7-7 18-3-8Zm8 3L21 3" /></>,
  leaf: <><path d="M5 19C-1 7 12 3 21 3c0 9-4 22-16 16Zm0 0L16 8" /></>,
};
export type IconName = keyof typeof paths;
export function Icon({ name, size = 18, className = '', style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`icon ${className}`} style={style}>{paths[name]}</svg>;
}
export function Logo({ className = '' }: { className?: string }) {
  return <img className={`brand-logo ${className}`} src="./brand/workspace.png" alt="ChatGPT Workspace" draggable={false} />;
}
