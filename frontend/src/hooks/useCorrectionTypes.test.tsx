import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";

import { useCorrectionTypes } from "./useCorrectionTypes";
import { CorrectionCardLite } from "../components/TokenEditorModel";

const TestComponent = ({
  textId,
  correctionCards,
  defaultTypeForCard,
}: {
  textId: number;
  correctionCards: CorrectionCardLite[];
  defaultTypeForCard?: (cardId: string) => number | null;
}) => {
  const { correctionTypeMap } = useCorrectionTypes({
    textId,
    correctionCards,
    defaultTypeForCard,
  });
  return <div data-testid="map">{JSON.stringify(correctionTypeMap)}</div>;
};

describe("useCorrectionTypes defaults", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("uses defaultTypeForCard when provided", async () => {
    const cards = [{ id: "move-1", rangeStart: 0, rangeEnd: 1 }];
    render(
      <TestComponent
        textId={1}
        correctionCards={cards}
        defaultTypeForCard={(id) => (id === "move-1" ? 42 : null)}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("map").textContent).toContain("\"move-1\":42");
    });
  });

  it("replaces a null assignment when a default becomes available", async () => {
    const cards = [{ id: "c1", rangeStart: 0, rangeEnd: 1 }];
    const { rerender } = render(
      <TestComponent textId={3} correctionCards={cards} defaultTypeForCard={() => null} />
    );
    await waitFor(() => {
      expect(screen.getByTestId("map").textContent).toContain("\"c1\":null");
    });
    rerender(<TestComponent textId={3} correctionCards={cards} defaultTypeForCard={() => 9} />);
    await waitFor(() => {
      expect(screen.getByTestId("map").textContent).toContain("\"c1\":9");
    });
  });
});
