import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastTone = 'ok' | 'warn';
export type ToastFn = (message: string, tone?: ToastTone) => void;

const ToastContext = createContext<ToastFn>(() => {});
export const useToast = (): ToastFn => useContext(ToastContext);

interface Item {
  id: number;
  message: string;
  tone: ToastTone;
}

// Bottom-right stack, three at most, four seconds. tone: 'ok' | 'warn'.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const seq = useRef(0);
  const push = useCallback<ToastFn>((message, tone = 'ok') => {
    seq.current += 1;
    const id = seq.current;
    setItems((list) => [...list, { id, message, tone }].slice(-3));
    setTimeout(() => setItems((list) => list.filter((item) => item.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast${item.tone === 'warn' ? ' warn' : ''}`}>
            <span className="led" aria-hidden="true" />
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
