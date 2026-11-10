/**
 * ERROR GUARD — Thin wrapper (real suppression happens in index.ts)
 * This file is imported early in App.tsx for additional safety in component-tree errors.
 */

// ── Promise compatibility polyfills (Hermes / older JS engines) ───────────
// Promise.allSettled is not available on Hermes (React Native default engine).
// Patch it here because this file is imported before any screen.
if (typeof Promise !== 'undefined' && typeof (Promise as any).allSettled !== 'function') {
  (Promise as any).allSettled = function allSettled(promises: Iterable<any>) {
    return Promise.all(
      Array.from(promises).map((p: any) =>
        Promise.resolve(p)
          .then((value: any) => ({ status: 'fulfilled' as const, value }))
          .catch((reason: any) => ({ status: 'rejected' as const, reason }))
      )
    );
  };
}

// Promise.any polyfill (also missing on Hermes)
if (typeof Promise !== 'undefined' && typeof (Promise as any).any !== 'function') {
  (Promise as any).any = function any(promises: Iterable<any>) {
    return new Promise((resolve, reject) => {
      const arr = Array.from(promises);
      if (arr.length === 0) { reject(new (AggregateError || Error)('All promises were rejected')); return; }
      let rejCount = 0;
      const errors: any[] = [];
      arr.forEach((p, i) => {
        Promise.resolve(p).then(resolve).catch((err: any) => {
          errors[i] = err;
          rejCount++;
          if (rejCount === arr.length) reject(new (AggregateError || Error)(errors, 'All promises were rejected'));
        });
      });
    });
  };
}

const SUPPRESSED_PATTERNS = [
  'monaco', 'ts.worker', 'NetworkError', 'Failed to execute', 'importScripts',
  'WorkerGlobalScope', 'cdn.jsdelivr.net', 'failed to load', 'useSnack',
  'CMbG-7ft.js',
  'Cannot read properties of undefined',
  "reading 'includes'",
  'min/vs/assets/ts.worker',
  '/ts.worker',
];

function shouldSuppress(msg: string): boolean {
  if (!msg) return false;
  return SUPPRESSED_PATTERNS.some(p => msg.toLowerCase().includes(p.toLowerCase()));
}

// Quick double-check on console methods (in case index.ts patches didn't apply)
try {
  const _origCE = console.error;
  console.error = (...args: any[]) => {
    const msg = args.map(a => String(a ?? '')).join(' ');
    if (shouldSuppress(msg)) return;
    _origCE.apply(console, args);
  };

  const _origCW = console.warn;
  console.warn = (...args: any[]) => {
    const msg = args.map(a => String(a ?? '')).join(' ');
    if (shouldSuppress(msg)) return;
    _origCW.apply(console, args);
  };

  const _origCL = console.log;
  console.log = (...args: any[]) => {
    const msg = args.map(a => String(a ?? '')).join(' ');
    if (shouldSuppress(msg)) return;
    _origCL.apply(console, args);
  };
} catch (_) {}

export {};