import { describe, expect, it } from "vitest";

import {
  buildAnnotationsPayloadStandalone,
  createInitialHistoryState,
  deriveCorrectionCards,
  deriveMoveMarkers,
  EditorHistoryState,
  hydrateFromServerAnnotations,
  tokenEditorReducer,
} from "./TokenEditor";

const baseText = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
const typeIds = [1, 2, 3, 4];

const createRng = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 48271) % 0x7fffffff;
    return state / 0x7fffffff;
  };
};

const randomInt = (rng: () => number, min: number, max: number) =>
  min + Math.floor(rng() * (max - min + 1));

const tokensToDisplay = (tokens: Array<{ kind?: string; text: string }>) =>
  tokens.map((tok) => (tok.kind === "empty" ? "⬚" : tok.text));

const debugTokenList = (tokens: Array<{ kind?: string; text: string; moveId?: string; groupId?: string; previousTokens?: unknown[]; origin?: string }>) =>
  tokens
    .map((tok, idx) => {
      const label = tok.kind === "empty" ? "⬚" : tok.text;
      const flags = [
        tok.moveId ? `move:${tok.moveId}` : null,
        tok.groupId ? `group:${tok.groupId}` : null,
        tok.previousTokens?.length ? `hist:${tok.previousTokens.length}` : null,
        tok.origin ? `origin:${tok.origin}` : null,
      ]
        .filter(Boolean)
        .join(",");
      return `[${idx}]${label}${flags ? `{${flags}}` : ""}`;
    })
    .join(" ");

const chooseTokenIndex = (state: EditorHistoryState, rng: () => number) => {
  const indices = state.present.tokens
    .map((tok, idx) => (tok.kind === "empty" ? null : idx))
    .filter((idx): idx is number => idx !== null);
  if (!indices.length) return null;
  return indices[Math.floor(rng() * indices.length)];
};

const makeEditText = (base: string, rng: () => number, suffix: string) => {
  const mutate = rng() < 0.35;
  const split = rng() < 0.35;
  if (split) {
    const tail = mutate ? `${base}${suffix}` : base;
    return `${tail} extra`;
  }
  return mutate ? `${base}${suffix}` : `${base}x`;
};

const snapshotCorrections = (state: EditorHistoryState) => {
  const tokens = state.present.tokens;
  const moveMarkers = deriveMoveMarkers(tokens);
  const correctionCards = deriveCorrectionCards(tokens, moveMarkers);
  return correctionCards
    .map((card) => ({
      rangeStart: card.rangeStart,
      rangeEnd: card.rangeEnd,
      isMove: moveMarkers.some((marker) => marker.id === card.id),
      tokens: tokensToDisplay(tokens.slice(card.rangeStart, card.rangeEnd + 1)),
    }))
    .sort((a, b) => a.rangeStart - b.rangeStart || a.rangeEnd - b.rangeEnd);
};

const summarizePayloads = (payloads: any[], originalTokens: Array<{ id: string; text: string; kind?: string }>) => {
  const idToText = new Map(
    originalTokens.filter((tok) => tok.kind !== "empty").map((tok) => [tok.id, tok.text])
  );
  return payloads
    .map((payload) => {
      const op = payload.payload?.operation ?? (payload.replacement ? "replace" : "noop");
      const beforeIds = Array.isArray(payload.payload?.before_tokens) ? payload.payload.before_tokens : [];
      const afterFragments = Array.isArray(payload.payload?.after_tokens) ? payload.payload.after_tokens : [];
      const beforeText = beforeIds.map((id: string) => idToText.get(id) ?? id).join(" ");
      const afterText = afterFragments.map((frag: any) => frag?.text ?? "").filter(Boolean).join(" ");
      return `${op} ${payload.start_token}-${payload.end_token} before=[${beforeText}] after=[${afterText}]`;
    })
    .join("\n");
};

type OperationResult = { state: EditorHistoryState; detail: string };

const applyDelete = (state: EditorHistoryState, rng: () => number): OperationResult => {
  const idx = chooseTokenIndex(state, rng);
  if (idx == null) return { state, detail: "delete:skip" };
  const text = state.present.tokens[idx]?.text ?? "unknown";
  return {
    state: tokenEditorReducer(state, { type: "DELETE_SELECTED_TOKENS", range: [idx, idx] }),
    detail: `delete:${text}@${idx}`,
  };
};

const applyInsert = (state: EditorHistoryState, rng: () => number, seq: number): OperationResult => {
  const idx = chooseTokenIndex(state, rng);
  if (idx == null) return { state, detail: "insert:skip" };
  const anchor = state.present.tokens[idx]?.text ?? "unknown";
  const inserted = tokenEditorReducer(state, { type: "INSERT_TOKEN_AFTER_SELECTED", range: [idx, idx] });
  const insertIdx = Math.min(idx + 1, inserted.present.tokens.length - 1);
  const base = inserted.present.tokens[insertIdx]?.text ?? "new";
  const newText = makeEditText(base, rng, `_${seq}`);
  return {
    state: tokenEditorReducer(inserted, {
      type: "EDIT_SELECTED_RANGE_AS_TEXT",
      range: [insertIdx, insertIdx],
      newText,
    }),
    detail: `insert:${anchor}@${idx}->${newText}`,
  };
};

const applyEdit = (state: EditorHistoryState, rng: () => number, seq: number): OperationResult => {
  const idx = chooseTokenIndex(state, rng);
  if (idx == null) return { state, detail: "edit:skip" };
  const base = state.present.tokens[idx]?.text ?? "edit";
  const newText = makeEditText(base, rng, `_${seq}`);
  return {
    state: tokenEditorReducer(state, { type: "EDIT_SELECTED_RANGE_AS_TEXT", range: [idx, idx], newText }),
    detail: `edit:${base}@${idx}->${newText}`,
  };
};

const applyMove = (state: EditorHistoryState, rng: () => number): OperationResult => {
  const idx = chooseTokenIndex(state, rng);
  if (idx == null) return { state, detail: "move:skip" };
  const tokens = state.present.tokens;
  let toIndex = randomInt(rng, 0, tokens.length);
  let guard = 0;
  while (toIndex >= idx && toIndex <= idx + 1 && guard < 5) {
    toIndex = randomInt(rng, 0, tokens.length);
    guard += 1;
  }
  if (toIndex >= idx && toIndex <= idx + 1) {
    toIndex = idx > 0 ? 0 : tokens.length;
  }
  const text = state.present.tokens[idx]?.text ?? "unknown";
  return {
    state: tokenEditorReducer(state, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: idx,
      fromEnd: idx,
      toIndex,
    }),
    detail: `move:${text}@${idx}->${toIndex}`,
  };
};

const applyOperation = (state: EditorHistoryState, op: string, rng: () => number, seq: number): OperationResult => {
  switch (op) {
    case "delete":
      return applyDelete(state, rng);
    case "insert":
      return applyInsert(state, rng, seq);
    case "edit":
      return applyEdit(state, rng, seq);
    case "move":
      return applyMove(state, rng);
    default:
      return { state, detail: `${op}:skip` };
  }
};

describe("model property round-trips", () => {
  it("rehydrates randomized correction sequences with stable tokens and badges", async () => {
    const seedOverride = process.env.DEBUG_SEED;
    const seeds = seedOverride ? [Number(seedOverride)] : Array.from({ length: 16 }, (_, idx) => idx + 11);
    const operations = ["delete", "insert", "edit", "move"];

    for (const seed of seeds) {
      const rng = createRng(seed);
      let state = tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: baseText });
      const opsApplied: string[] = [];

      for (let step = 0; step < 12; step += 1) {
        const op = operations[Math.floor(rng() * operations.length)];
        const result = applyOperation(state, op, rng, step);
        opsApplied.push(`${op}:${result.detail}`);
        state = result.state;
      }

      const tokens = state.present.tokens;
      const moveMarkers = deriveMoveMarkers(tokens);
      const correctionCards = deriveCorrectionCards(tokens, moveMarkers);
      if (!correctionCards.length) {
        continue;
      }
      const correctionTypeMap: Record<string, number> = {};
      correctionCards.forEach((card) => {
        correctionTypeMap[card.id] = typeIds[Math.floor(rng() * typeIds.length)];
      });

      const payloads = await buildAnnotationsPayloadStandalone({
        initialText: baseText,
        tokens,
        originalTokens: state.present.originalTokens,
        correctionCards,
        correctionTypeMap,
        moveMarkers,
      });

      const items = payloads.map((payload, idx) => ({
        id: 9000 + idx,
        author_id: "user-1",
        start_token: payload.start_token,
        end_token: payload.end_token,
        replacement: payload.replacement,
        error_type_id: payload.error_type_id,
        payload: payload.payload,
      }));

      const hydrated = hydrateFromServerAnnotations({
        items,
        initialText: baseText,
        currentUserId: "user-1",
      });
      expect(hydrated).not.toBeNull();
      if (!hydrated) continue;

      const hydratedTokens = tokensToDisplay(hydrated.present.tokens);
      const expectedTokens = tokensToDisplay(tokens);
      if (hydratedTokens.join("|") !== expectedTokens.join("|")) {
        const movePayloadDebug = payloads
          .filter((payload) => payload.payload?.operation === "move")
          .map((payload) => ({
            span: `${payload.start_token}-${payload.end_token}`,
            beforeCount: payload.payload?.before_tokens?.length ?? 0,
            afterCount: payload.payload?.after_tokens?.length ?? 0,
            afterText: (payload.payload?.after_tokens ?? []).map((frag: any) => frag?.text ?? "").join(" "),
            moveFrom: payload.payload?.move_from,
            moveTo: payload.payload?.move_to,
            moveLen: payload.payload?.move_len,
          }));
        throw new Error(
          `Seed ${seed} token mismatch. Ops=${opsApplied.join(",")}\n` +
            `expected=${expectedTokens.join(" ")}\n` +
            `actual=${hydratedTokens.join(" ")}\n` +
            `expectedTokens=${debugTokenList(tokens)}\n` +
            `hydratedTokens=${debugTokenList(hydrated.present.tokens)}\n` +
            `moves=${JSON.stringify(movePayloadDebug)}\n` +
            summarizePayloads(payloads, state.present.originalTokens)
        );
      }

      const originalSnapshots = snapshotCorrections(state);
      const hydratedSnapshots = snapshotCorrections({
        past: [],
        present: hydrated.present,
        future: [],
      });
      if (JSON.stringify(hydratedSnapshots) !== JSON.stringify(originalSnapshots)) {
        throw new Error(
          `Seed ${seed} correction snapshot mismatch. Ops=${opsApplied.join(",")}`
        );
      }

      const expectedTypes = correctionCards.map((card) => correctionTypeMap[card.id]).sort();
      const actualTypes = Object.values(hydrated.typeMap)
        .filter((value): value is number => typeof value === "number")
        .sort();
      if (JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)) {
        throw new Error(
          `Seed ${seed} type mismatch. Ops=${opsApplied.join(",")}`
        );
      }
    }
  });
});
