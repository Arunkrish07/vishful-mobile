import { useRef, useEffect } from 'react';

/**
 * Returns a ref that is `true` while the component is mounted.
 * Use in async callbacks: `if (mounted.current) setState(...)`.
 */
export function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

/**
 * Returns `true` when the error is an AbortError or abort-related rejection.
 * These are benign and should be silently swallowed.
 */
export function isAbortError(e: unknown): boolean {
  if (!e) return false;
  if (typeof e === 'string') {
    return e.includes('aborted') || e.includes('AbortError') || e.includes('signal');
  }
  if (e instanceof Error || (typeof e === 'object' && e !== null)) {
    const err = e as any;
    if (err.name === 'AbortError') return true;
    if (typeof err.message === 'string') {
      const msg = err.message.toLowerCase();
      if (msg.includes('aborted') || msg.includes('signal is aborted')) return true;
    }
    if (typeof err.code === 'number' && err.code === 20) return true; // DOMException ABORT_ERR
  }
  return false;
}