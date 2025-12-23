import { render, screen } from "@testing-library/react";
import React, { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { SaveStatusProvider, useSaveStatus } from "./SaveStatusContext";

const Consumer = () => {
  const { status, setStatus } = useSaveStatus();
  useEffect(() => {
    setStatus({ state: "saved", unsaved: false });
  }, [setStatus]);
  return <span data-testid="status">{status ? status.state : "null"}</span>;
};

describe("SaveStatusContext", () => {
  it("provides status updates to consumers", async () => {
    render(
      <SaveStatusProvider>
        <Consumer />
      </SaveStatusProvider>
    );
    expect(await screen.findByTestId("status")).toHaveTextContent("saved");
  });

  it("throws when used outside provider", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onError = vi.fn();
    class ErrorBoundary extends React.Component<{ onError: (err: Error) => void }, { hasError: boolean }> {
      state = { hasError: false };
      static getDerivedStateFromError() {
        return { hasError: true };
      }
      componentDidCatch(err: Error) {
        this.props.onError(err);
      }
      render() {
        return this.state.hasError ? <span data-testid="boundary-error">error</span> : this.props.children;
      }
    }
    render(
      <ErrorBoundary onError={onError}>
        <Consumer />
      </ErrorBoundary>
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "useSaveStatus must be used within SaveStatusProvider" }));
    errorSpy.mockRestore();
  });
});
