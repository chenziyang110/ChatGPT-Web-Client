import { useRef, useState, type FormEvent } from 'react';
import { Icon } from './Icon';

type PageAddressProps = {
  url: string;
  loading?: boolean;
  busy?: boolean;
  onOpen: (url: string) => Promise<boolean>;
};

const addressHint = '输入链接后按 Enter 在当前账号新标签页打开';

export function PageAddress({ url, loading, busy, onOpen }: PageAddressProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const submitting = useRef(false);
  const value = draft ?? url;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const target = value.trim();
    if (busy || composing.current || submitting.current || !target) return;
    submitting.current = true;
    try {
      if (await onOpen(target)) {
        setDraft(null);
        input.current?.blur();
      }
    } finally { submitting.current = false; }
  }

  return <form className="page-url" onSubmit={event => void submit(event)}>
    <input ref={input} type="text" inputMode="url" value={value} aria-label={addressHint} title={addressHint}
      placeholder={loading ? '网页正在加载，可输入链接…' : '输入登录或授权链接'}
      autoComplete="off" autoCapitalize="off" spellCheck={false}
      onFocus={event => { setDraft(current => current ?? url); event.currentTarget.select(); }}
      onChange={event => setDraft(event.currentTarget.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
        if (event.key === 'Escape' && !composing.current && !event.nativeEvent.isComposing) {
          event.preventDefault();
          setDraft(null);
          event.currentTarget.blur();
        }
      }} />
    <button type="submit" disabled={busy || !value.trim()} aria-label="在当前账号新标签页打开链接" title="在当前账号新标签页打开链接"><Icon name="arrow" size={14} /></button>
  </form>;
}
