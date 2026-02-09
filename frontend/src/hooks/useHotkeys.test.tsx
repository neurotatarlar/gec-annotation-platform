import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useAnnotationHotkeys } from "./useHotkeys";

const HotkeysHarness = ({ bindings }: { bindings: Record<string, () => void> }) => {
  useAnnotationHotkeys(bindings);
  return null;
};

describe("useAnnotationHotkeys", () => {
  it("triggers bound actions and prevents default", () => {
    const onA = vi.fn();
    render(<HotkeysHarness bindings={{ a: onA }} />);

    const event = new KeyboardEvent("keydown", { key: "A", cancelable: true });
    window.dispatchEvent(event);

    expect(onA).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("replaces listeners on rerender and removes them on unmount", () => {
    const onA = vi.fn();
    const onB = vi.fn();
    const { rerender, unmount } = render(<HotkeysHarness bindings={{ a: onA }} />);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    expect(onA).toHaveBeenCalledTimes(1);

    rerender(<HotkeysHarness bindings={{ b: onB }} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", cancelable: true }));

    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);

    unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", cancelable: true }));
    expect(onB).toHaveBeenCalledTimes(1);
  });
});
