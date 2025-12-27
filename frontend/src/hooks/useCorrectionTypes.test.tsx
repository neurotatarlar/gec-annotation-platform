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

  it("falls back to activeErrorTypeId when no default applies", async () => {
    localStorage.setItem(
      "tokenEditorPrefs:types:2",
      JSON.stringify({ activeErrorTypeId: 7, assignments: {} })
    );
    const cards = [{ id: "move-1", rangeStart: 0, rangeEnd: 1 }];
    render(<TestComponent textId={2} correctionCards={cards} defaultTypeForCard={() => null} />);

    await waitFor(() => {
      expect(screen.getByTestId("map").textContent).toContain("\"move-1\":7");
    });
  });
});
