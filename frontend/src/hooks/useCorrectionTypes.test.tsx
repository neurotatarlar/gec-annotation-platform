import { useLayoutEffect } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";

import { useCorrectionTypes } from "./useCorrectionTypes";
import { CorrectionCardLite } from "../components/TokenEditorModel";

const TestComponent = ({
  textId,
  correctionCards,
  defaultTypeForCard,
  seedAssignments,
}: {
  textId: number;
  correctionCards: CorrectionCardLite[];
  defaultTypeForCard?: (cardId: string) => number | null;
  seedAssignments?: Record<string, number | null>;
}) => {
  const { correctionTypeMap, seedCorrectionTypes } = useCorrectionTypes({
    textId,
    correctionCards,
    defaultTypeForCard,
  });
  useLayoutEffect(() => {
    if (seedAssignments) {
      seedCorrectionTypes(seedAssignments);
    }
  }, [seedAssignments, seedCorrectionTypes]);
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

  it("does not override seeded types with stale local storage", async () => {
    localStorage.setItem(
      "tokenEditorPrefs:types:1",
      JSON.stringify({ assignments: { stale: 99 } })
    );
    const cards = [{ id: "c1", rangeStart: 0, rangeEnd: 1 }];
    render(
      <TestComponent
        textId={1}
        correctionCards={cards}
        seedAssignments={{ c1: 1 }}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("map").textContent).toContain("\"c1\":1");
    });
  });

  it("keeps seeded types when cards arrive after seed", async () => {
    const seed = { c1: 1 };
    const { rerender } = render(
      <TestComponent textId={5} correctionCards={[]} seedAssignments={seed} />
    );

    await waitFor(() => {
      expect(screen.getByTestId("map").textContent).toContain("\"c1\":1");
    });

    rerender(
      <TestComponent
        textId={5}
        correctionCards={[{ id: "c1", rangeStart: 0, rangeEnd: 0 }]}
        seedAssignments={seed}
      />
    );

    await waitFor(() => {
      expect(screen.getByTestId("map").textContent).toContain("\"c1\":1");
    });
  });
});
