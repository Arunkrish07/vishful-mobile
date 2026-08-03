// ── Error suppression — MUST run before any other code ──────────────────
// Snack's Monaco editor workers generate benign errors. Suppress them all
// before Snack registers its own window.onerror / error-event listener.

const _SUPPRESS = [
  'ResizeObserver', 'prototype', 'removeEventListener', 'addEventListener',
  'security policy', 'importScripts', 'WorkerGlobalScope', 'cross-origin',
  'monaco', 'ts.worker', 'useSnack', '[useSnack]', 'Failed to read a named property',
  // NetworkError thrown when Monaco worker scripts fail to load from CDN
  'NetworkError', 'Failed to execute', 'cdn.jsdelivr.net', 'jsdelivr', 'failed to load',
  "Cannot read properties of undefined", "reading 'includes'",
  'CMbG-7ft.js', // Specific Monaco worker file hash
  'loop completed', 'undelivered notifications', 'loop completed with undelivered',
];
const _shouldSuppress = (s: string) => {
  if (!s) return false;
  return _SUPPRESS.some(p => s.toLowerCase().includes(p.toLowerCase()));
};

// ── Promise compatibility polyfills ──────────────────────────────────────
if (typeof Promise !== 'undefined' && typeof (Promise as any).allSettled !== 'function') {
  (Promise as any).allSettled = function allSettled(promises: any) {
    return Promise.all(Array.from(promises).map((promise) =>
      Promise.resolve(promise)
        .then((value) => ({ status: 'fulfilled' as const, value }))
        .catch((reason) => ({ status: 'rejected' as const, reason }))
    ));
  };
}

// ── Early capture-phase error listener (fires before Snack's listener) ────
if (typeof globalThis !== 'undefined' && typeof (globalThis as any).addEventListener === 'function') {
  (globalThis as any).addEventListener('error', (event: any) => {
    try {
      const msg = [
        event?.message,
        event?.filename,
        event?.error?.message,
        event?.error?.stack,
        event?.message,
      ]
        .map((s: any) => String(s ?? '')).join(' ');
      if (_shouldSuppress(msg)) {
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
        event?.stopPropagation?.();
        return;
      }
    } catch (_) {}
  }, true /* capture phase — runs before bubble-phase listeners */);

  // Also add a bubble-phase listener for any uncaught errors that bypass the capture phase
  (globalThis as any).addEventListener('error', (event: any) => {
    try {
      const msg = [
        event?.message,
        event?.filename,
        event?.error?.message,
        event?.error?.stack,
      ]
        .map((s: any) => String(s ?? '')).join(' ');
      if (_shouldSuppress(msg)) {
        event?.preventDefault?.();
        return;
      }
    } catch (_) {}
  }, false);
}

// ── Patch console — Snack pipes window.error through console.log ──────────
(['log', 'error', 'warn'] as const).forEach(method => {
  const _orig = (console as any)[method];
  (console as any)[method] = (...args: any[]) => {
    if (_shouldSuppress(args.map((a: any) => String(a ?? '')).join(' '))) return;
    _orig?.apply(console, args);
  };
});

// ── Patch onerror ────────────────────────────────────────────────────────
if (typeof globalThis !== 'undefined') {
  const _orig = (globalThis as any).onerror;
  (globalThis as any).onerror = (msg: any, _src?: any, _l?: any, _c?: any, err?: any) => {
    if (
      _shouldSuppress(String(msg  || '')) ||
      _shouldSuppress(String(_src || '')) ||
      _shouldSuppress(String(err?.message || '')) ||
      _shouldSuppress(String(err?.stack   || ''))
    ) return true;
    return _orig ? _orig(msg, _src, _l, _c, err) : false;
  };
}

// ── Patch unhandled rejections ───────────────────────────────────────────
if (typeof globalThis !== 'undefined') {
  const _orig = (globalThis as any).onunhandledrejection;
  (globalThis as any).onunhandledrejection = (event: any) => {
    const msg = String(event?.reason?.message || event?.reason || '');
    if (_shouldSuppress(msg)) {
      try { event?.preventDefault?.(); } catch (_) {}
      return;
    }
    if (_orig) _orig(event);
  };

  // Also intercept unhandledrejection events
  if (typeof (globalThis as any).addEventListener === 'function') {
    (globalThis as any).addEventListener('unhandledrejection', (event: any) => {
      const msg = String(event?.reason?.message || event?.reason || '');
      if (_shouldSuppress(msg)) {
        event?.preventDefault?.();
      }
    }, true);
  }
}

// ── Replace ResizeObserver with a safe wrapper ────────────────────────────
if (typeof globalThis !== 'undefined') {
  try {
    const NativeRO = (globalThis as any).ResizeObserver;
    if (typeof NativeRO === 'function') {
      (globalThis as any).ResizeObserver = class SafeResizeObserver {
        private _ro: any;
        constructor(cb: any) {
          let rafId: any;
          this._ro = new NativeRO((...args: any[]) => {
            cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
              try { cb(...args); } catch (_) {}
            });
          });
        }
        observe(el: any, opts?: any)   { this._ro.observe(el, opts); }
        unobserve(el: any)             { this._ro.unobserve(el); }
        disconnect()                   { this._ro.disconnect(); }
      };
    }
  } catch (_) {}
}

// ── Gesture handler must be imported before any RN screen ───────────────
import 'react-native-gesture-handler';

// ── Boot the app ────────────────────────────────────────────────────────
import { registerRootComponent } from 'expo';
import App from './App';
registerRootComponent(App);