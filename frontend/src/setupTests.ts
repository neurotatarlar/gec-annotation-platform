import "@testing-library/jest-dom";
import { vi } from "vitest";

// Mock canvas for jsdom
(HTMLCanvasElement.prototype as any).getContext = vi.fn(() => ({
  measureText: (text: string) => ({ width: text.length * 8 }),
}));
