import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useEditorUIState } from "./useEditorUIState";

describe("useEditorUIState", () => {
  it("tracks selection/edit mode transitions", () => {
    const { result } = renderHook(() => useEditorUIState());

    expect(result.current.ui.mode).toBe("idle");
    expect(result.current.ui.overlay).toBe("none");

    act(() => {
      result.current.setSelection({ start: 1, end: 3 });
    });
    expect(result.current.ui.selection).toEqual({ start: 1, end: 3 });
    expect(result.current.ui.mode).toBe("selecting");

    act(() => {
      result.current.startEdit({ start: 1, end: 3 }, "edited text");
    });
    expect(result.current.ui.mode).toBe("editing");
    expect(result.current.ui.editingRange).toEqual({ start: 1, end: 3 });
    expect(result.current.ui.editText).toBe("edited text");

    act(() => {
      result.current.updateEditText("updated");
      result.current.endEdit();
    });
    expect(result.current.ui.editingRange).toBeNull();
    expect(result.current.ui.editText).toBe("");
    expect(result.current.ui.mode).toBe("selecting");
  });

  it("manages clear-confirm and flag overlays", () => {
    const { result } = renderHook(() => useEditorUIState());

    act(() => {
      result.current.openClearConfirm();
    });
    expect(result.current.ui.overlay).toBe("clear");

    act(() => {
      result.current.closeClearConfirm();
      result.current.openFlagConfirm("trash");
    });
    expect(result.current.ui.overlay).toBe("flag");
    expect(result.current.ui.pendingAction).toBe("trash");

    act(() => {
      result.current.updateFlagReason("bad source");
      result.current.updateFlagError("required");
    });
    expect(result.current.ui.flagReason).toBe("bad source");
    expect(result.current.ui.flagError).toBe("required");

    act(() => {
      result.current.closeFlagConfirm();
    });
    expect(result.current.ui.overlay).toBe("none");
    expect(result.current.ui.pendingAction).toBeNull();
    expect(result.current.ui.flagReason).toBe("");
    expect(result.current.ui.flagError).toBeNull();
  });

  it("resets all UI state", () => {
    const { result } = renderHook(() => useEditorUIState());

    act(() => {
      result.current.setSelection({ start: 0, end: 0 });
      result.current.startEdit({ start: 0, end: 0 }, "x");
      result.current.openFlagConfirm("skip");
      result.current.updateFlagReason("reason");
      result.current.updateFlagError("err");
      result.current.resetUI();
    });

    expect(result.current.ui).toEqual({
      mode: "idle",
      overlay: "none",
      selection: { start: null, end: null },
      editingRange: null,
      editText: "",
      pendingAction: null,
      flagReason: "",
      flagError: null,
    });
  });
});
