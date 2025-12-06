import { render, screen } from "@testing-library/react";
import React, { useEffect } from "react";
import { describe, expect, it } from "vitest";

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
    const renderWithoutProvider = () => render(<Consumer />);
    expect(renderWithoutProvider).toThrow();
    errorSpy.mockRestore();
  });
});
