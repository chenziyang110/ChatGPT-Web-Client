import { useEffect, useState } from 'react';
import { Icon } from './Icon';

export function Toast({ message, dismiss }: { message: string; dismiss: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (hovered || focused) return;
    const timer = setTimeout(dismiss, 6000);
    return () => clearTimeout(timer);
  }, [dismiss, hovered, focused]);
  return <div className="toast-viewport">
    <div className="toast" role="alert" aria-atomic="true"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <span className="toast-symbol" aria-hidden="true">!</span>
      <span className="toast-message">{message}</span>
      <button className="toast-close" aria-label="关闭提示" onClick={dismiss}><Icon name="close" size={15} /></button>
    </div>
  </div>;
}
