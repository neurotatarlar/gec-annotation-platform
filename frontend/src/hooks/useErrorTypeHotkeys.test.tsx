import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErrorType } from "../types";
import { eventToHotkeyStrings, useErrorTypeHotkeys } from "./useErrorTypeHotkeys";

const typeWithHotkey = (id: number, hotkey: string): ErrorType =>
  ({
    id,
    en_name: `Type ${id}`,
    tt_name: `Type ${id}`,
    is_active: true,
    default_hotkey: hotkey,
  }) as ErrorType;

const HotkeysHarness = ({
  errorTypes,
  onTypePick,
}: {
  errorTypes: ErrorType[];
  onTypePick: (typeId: number) => void;
}) => {
  useErrorTypeHotkeys(errorTypes, onTypePick);
  return <input aria-label="edit" />;
};

describe("eventToHotkeyStrings", () => {
  it("normalizes key and keyboard-code specs", () => {
    expect(
      eventToHotkeyStrings({
        key: "A",
        code: "KeyA",
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
      })
    ).toEqual({ keySpec: "ctrl+shift+a", codeSpec: "ctrl+shift+code:KeyA" });
  });

  it("ignores pure modifier key presses", () => {
    expect(
      eventToHotkeyStrings({
        key: "Shift",
        code: "ShiftLeft",
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        metaKey: false,
      })
    ).toEqual({ keySpec: null, codeSpec: null });
  });
});

describe("useErrorTypeHotkeys", () => {
  it("applies a matching error type and prevents default", () => {
    const onTypePick = vi.fn();
    render(<HotkeysHarness errorTypes={[typeWithHotkey(7, "ctrl+a")]} onTypePick={onTypePick} />);

    const event = new KeyboardEvent("keydown", {
      key: "a",
      code: "KeyA",
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(onTypePick).toHaveBeenCalledWith(7);
    expect(event.defaultPrevented).toBe(true);
  });

  it("matches keyboard code when the visible key differs", () => {
    const onTypePick = vi.fn();
    render(<HotkeysHarness errorTypes={[typeWithHotkey(8, "a")]} onTypePick={onTypePick} />);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ф", code: "KeyA" }));

    expect(onTypePick).toHaveBeenCalledWith(8);
  });

  it("ignores hotkeys while editing text inputs", () => {
    const onTypePick = vi.fn();
    const { getByLabelText } = render(
      <HotkeysHarness errorTypes={[typeWithHotkey(9, "a")]} onTypePick={onTypePick} />
    );

    getByLabelText("edit").dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true })
    );

    expect(onTypePick).not.toHaveBeenCalled();
  });

  it("updates listeners on rerender and removes them on unmount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = render(
      <HotkeysHarness errorTypes={[typeWithHotkey(1, "a")]} onTypePick={first} />
    );

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
    expect(first).toHaveBeenCalledWith(1);

    rerender(<HotkeysHarness errorTypes={[typeWithHotkey(2, "b")]} onTypePick={second} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", code: "KeyA" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB" }));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith(2);

    unmount();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", code: "KeyB" }));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
