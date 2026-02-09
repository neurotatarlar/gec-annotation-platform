/**
 * Test-runtime setup for Vitest + Testing Library in jsdom.
 * Adds canvas measurement mocks, prevents dangling timers from blocking process exit, and
 * suppresses noisy React Router future-flag warnings so test output stays focused.
 */
import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock canvas for jsdom
(HTMLCanvasElement.prototype as any).getContext = vi.fn(() => ({
  measureText: (text: string) => ({ width: text.length * 8 }),
}));

// Prevent long-running timers from keeping the process alive.
const realSetTimeout = global.setTimeout;
// @ts-ignore
global.setTimeout = ((fn: TimerHandler, delay?: number, ...args: any[]) => {
  const timer = realSetTimeout(fn, delay, ...args);
  // @ts-ignore
  if (typeof timer?.unref === "function") (timer as any).unref();
  return timer;
}) as any;

// Silence noisy React Router future-flag warnings in tests.
const originalWarn = console.warn;
console.warn = (...args: any[]) => {
  const msg = args[0];
  if (typeof msg === "string" && msg.includes("React Router Future Flag Warning")) {
    return;
  }
  originalWarn(...args);
};
