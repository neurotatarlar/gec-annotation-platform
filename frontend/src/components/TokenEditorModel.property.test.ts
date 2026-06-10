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
type SelectionRange = { start: number | null; end: number | null };
type ChainAction = "move" | "edit" | "delete" | "select" | "add";
type ChainContext = {
  state: EditorHistoryState;
  selection: SelectionRange;
  details: string[];
};

const chainActions: ChainAction[] = ["move", "edit", "delete", "select", "add"];
const chainText =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma";

const displayState = (state: EditorHistoryState) => ({
  tokens: tokensToDisplay(state.present.tokens),
  corrections: snapshotCorrections(state),
});

const sameDisplayState = (left: EditorHistoryState, right: EditorHistoryState) =>
  JSON.stringify(displayState(left)) === JSON.stringify(displayState(right));

const enumerateActionChains = (depth: number): ChainAction[][] => {
  if (depth === 0) return [[]];
  const tails = enumerateActionChains(depth - 1);
  return chainActions.flatMap((action) => tails.map((tail) => [action, ...tail]));
};

const visibleTokenIndices = (state: EditorHistoryState) =>
  state.present.tokens
    .map((token, idx) => (token.kind === "empty" || token.kind === "special" ? null : idx))
    .filter((idx): idx is number => idx !== null);

const changedTokenIndices = (state: EditorHistoryState) =>
  state.present.tokens
    .map((token, idx) =>
      token.kind !== "empty" &&
      (token.previousTokens?.length || token.origin === "inserted" || token.moveId || token.groupId)
        ? idx
        : null
    )
    .filter((idx): idx is number => idx !== null);

const plainTokenIndices = (state: EditorHistoryState) =>
  state.present.tokens
    .map((token, idx) =>
      token.kind !== "empty" &&
      token.kind !== "special" &&
      !token.groupId &&
      !token.moveId &&
      !token.previousTokens?.length &&
      token.origin !== "inserted" &&
      !state.present.tokens[idx + 1]?.groupId &&
      !state.present.tokens[idx + 1]?.moveId &&
      !state.present.tokens[idx + 1]?.previousTokens?.length &&
      state.present.tokens[idx + 1]?.origin !== "inserted" &&
      !state.present.tokens[idx - 1]?.groupId &&
      !state.present.tokens[idx - 1]?.moveId &&
      !state.present.tokens[idx - 1]?.previousTokens?.length &&
      state.present.tokens[idx - 1]?.origin !== "inserted"
        ? idx
        : null
    )
    .filter((idx): idx is number => idx !== null);

const isPlainChainToken = (state: EditorHistoryState, idx: number) => {
  const token = state.present.tokens[idx];
  return Boolean(
    token &&
      token.kind !== "empty" &&
      token.kind !== "special" &&
      !token.groupId &&
      !token.moveId &&
      !token.previousTokens?.length &&
      token.origin !== "inserted"
  );
};

const clampPlainRange = (state: EditorHistoryState, start: number, size: number): [number, number] | null => {
  let s = Math.max(0, Math.min(state.present.tokens.length - 1, start));
  while (s < state.present.tokens.length && !isPlainChainToken(state, s)) s += 1;
  if (s >= state.present.tokens.length) return null;
  let e = s;
  while (e + 1 < state.present.tokens.length && isPlainChainToken(state, e + 1) && e - s + 1 < size) {
    e += 1;
  }
  return [s, e];
};

const safeEditTokenIndices = (state: EditorHistoryState) =>
  state.present.tokens
    .map((token, idx) =>
      token.kind !== "empty" &&
      token.kind !== "special" &&
      !token.moveId &&
      !state.present.tokens[idx + 1]?.moveId &&
      !state.present.tokens[idx - 1]?.moveId
        ? idx
        : null
    )
    .filter((idx): idx is number => idx !== null);

const rangeHasMovedToken = (state: EditorHistoryState, [start, end]: [number, number]) =>
  state.present.tokens.slice(start, end + 1).some((token) => token.moveId);

const clampRange = (state: EditorHistoryState, start: number, size: number): [number, number] | null => {
  const visible = visibleTokenIndices(state);
  if (!visible.length) return null;
  const sortedVisible = new Set(visible);
  let s = Math.max(0, Math.min(state.present.tokens.length - 1, start));
  while (s < state.present.tokens.length && !sortedVisible.has(s)) s += 1;
  if (s >= state.present.tokens.length) s = visible[visible.length - 1];
  let e = s;
  while (e + 1 < state.present.tokens.length && sortedVisible.has(e + 1) && e - s + 1 < size) {
    e += 1;
  }
  return [s, e];
};

const selectRangeForStep = (
  state: EditorHistoryState,
  chainIndex: number,
  step: number,
  action: ChainAction,
  currentSelection: SelectionRange
): [number, number] | null => {
  const currentStart = currentSelection.start;
  if (
    currentStart !== null &&
    currentSelection.end !== null &&
    state.present.tokens[currentStart] &&
    action !== "select" &&
    action !== "add" &&
    action !== "move" &&
    (step + chainIndex) % 3 !== 0
  ) {
    const size = Math.min(3, Math.abs(currentSelection.end - currentStart) + 1);
    const range = clampRange(state, Math.min(currentStart, currentSelection.end), size);
    if (range) return range;
  }

  const plain = action === "add" ? plainTokenIndices(state) : [];
  if (plain.length) {
    const anchor = plain[(chainIndex + step * 5) % plain.length];
    return clampRange(state, anchor, 1);
  }
  if (action === "add") return null;

  const movable = action === "move" ? plainTokenIndices(state) : [];
  if (movable.length) {
    const anchor = movable[(chainIndex + step * 7) % movable.length];
    const size = 1 + ((chainIndex + step) % 3);
    return clampPlainRange(state, anchor, size);
  }
  if (action === "move") return null;

  const editCandidates = action === "edit" ? safeEditTokenIndices(state) : [];
  if (editCandidates.length) {
    const anchor = editCandidates[(chainIndex + step * 7) % editCandidates.length];
    const size = 1 + ((chainIndex + step) % 2);
    return clampRange(state, anchor, size);
  }
  if (action === "edit") return null;

  const changed = changedTokenIndices(state);
  const visible = visibleTokenIndices(state);
  const candidates = changed.length ? changed : visible;
  if (!candidates.length) return null;
  const anchor = candidates[(chainIndex + step * 7) % candidates.length];
  const size = 1 + ((chainIndex + step) % 3);
  return clampRange(state, anchor, size);
};

const normalizeMoveRange = (state: EditorHistoryState, range: [number, number]): [number, number] => {
  const [start, end] = range;
  const groupedToken = state.present.tokens.slice(start, end + 1).find((token) => token.groupId);
  if (groupedToken?.groupId) {
    const groupIndices = state.present.tokens
      .map((token, idx) => (token.groupId === groupedToken.groupId ? idx : null))
      .filter((idx): idx is number => idx !== null);
    if (groupIndices.length) {
      return [Math.min(...groupIndices), Math.max(...groupIndices)];
    }
  }
  const movedToken = state.present.tokens.slice(start, end + 1).find((token) => token.moveId && token.kind !== "empty");
  if (!movedToken?.moveId) return range;
  const moveIndices = state.present.tokens
    .map((token, idx) => (token.moveId === movedToken.moveId && token.kind !== "empty" ? idx : null))
    .filter((idx): idx is number => idx !== null);
  if (!moveIndices.length) return [start, start];
  return [Math.min(...moveIndices), Math.max(...moveIndices)];
};

const normalizeChangedRange = (state: EditorHistoryState, range: [number, number]): [number, number] => {
  const [start, end] = range;
  const groupedToken = state.present.tokens.slice(start, end + 1).find((token) => token.groupId);
  if (groupedToken?.groupId) {
    const groupIndices = state.present.tokens
      .map((token, idx) => (token.groupId === groupedToken.groupId ? idx : null))
      .filter((idx): idx is number => idx !== null);
    if (groupIndices.length) return [Math.min(...groupIndices), Math.max(...groupIndices)];
  }
  const movedToken = state.present.tokens.slice(start, end + 1).find((token) => token.moveId && token.kind !== "empty");
  if (movedToken?.moveId) {
    const moveIndices = state.present.tokens
      .map((token, idx) => (token.moveId === movedToken.moveId && token.kind !== "empty" ? idx : null))
      .filter((idx): idx is number => idx !== null);
    if (moveIndices.length) return [Math.min(...moveIndices), Math.max(...moveIndices)];
  }
  return range;
};

const isSafeMoveDropIndex = (state: EditorHistoryState, toIndex: number, fromStart: number, fromEnd: number) => {
  if (toIndex >= fromStart && toIndex <= fromEnd + 1) return false;
  const left = state.present.tokens[toIndex - 1];
  const right = state.present.tokens[toIndex];
  return Boolean(
    (!left || (isPlainChainToken(state, toIndex - 1) && !left.groupId && !left.moveId)) &&
      (!right || (isPlainChainToken(state, toIndex) && !right.groupId && !right.moveId))
  );
};

const chooseSafeMoveDropIndex = (
  state: EditorHistoryState,
  seedIndex: number,
  fromStart: number,
  fromEnd: number
) => {
  const tokenCount = state.present.tokens.length;
  for (let offset = 0; offset <= tokenCount; offset += 1) {
    const toIndex = (seedIndex + offset) % (tokenCount + 1);
    if (isSafeMoveDropIndex(state, toIndex, fromStart, fromEnd)) return toIndex;
  }
  return null;
};

const applyChainAction = (
  context: ChainContext,
  action: ChainAction,
  chainIndex: number,
  step: number
): ChainContext => {
  const range = selectRangeForStep(context.state, chainIndex, step, action, context.selection);
  if (!range) {
    return { ...context, details: [...context.details, `${step}:${action}:skip`] };
  }
  const normalizedRange =
    action === "move"
      ? normalizeMoveRange(context.state, range)
      : action === "edit" || action === "delete"
        ? normalizeChangedRange(context.state, range)
        : range;
  const [start, end] = normalizedRange;
  const label = tokensToDisplay(context.state.present.tokens.slice(start, end + 1)).join("+");

  if (action === "edit" && rangeHasMovedToken(context.state, normalizedRange)) {
    return { ...context, details: [...context.details, `${step}:${action}:skip-move:${label}@${start}-${end}`] };
  }

  if (action === "select") {
    return {
      ...context,
      selection: { start, end },
      details: [...context.details, `${step}:select:${label}@${start}-${end}`],
    };
  }

  if (action === "delete") {
    return {
      state: tokenEditorReducer(context.state, { type: "DELETE_SELECTED_TOKENS", range: normalizedRange }),
      selection: { start: null, end: null },
      details: [...context.details, `${step}:delete:${label}@${start}-${end}`],
    };
  }

  if (action === "edit") {
    const split = (chainIndex + step) % 2 === 0;
    const newText = split ? `E${chainIndex}_${step} split` : `E${chainIndex}_${step}`;
    return {
      state: tokenEditorReducer(context.state, {
        type: "EDIT_SELECTED_RANGE_AS_TEXT",
        range: normalizedRange,
        newText,
      }),
      selection: { start, end: start },
      details: [...context.details, `${step}:edit:${label}@${start}-${end}->${newText}`],
    };
  }

  if (action === "add") {
    const inserted = tokenEditorReducer(context.state, { type: "INSERT_TOKEN_AFTER_SELECTED", range: normalizedRange });
    const insertIndex = Math.min(end + 1, inserted.present.tokens.length - 1);
    const newText = (chainIndex + step) % 2 === 0 ? `A${chainIndex}_${step}` : `A${chainIndex}_${step} plus`;
    return {
      state: tokenEditorReducer(inserted, {
        type: "EDIT_SELECTED_RANGE_AS_TEXT",
        range: [insertIndex, insertIndex],
        newText,
      }),
      selection: { start: insertIndex, end: insertIndex },
      details: [...context.details, `${step}:add:${label}@${start}-${end}->${newText}`],
    };
  }

  const tokenCount = context.state.present.tokens.length;
  let toIndex = chooseSafeMoveDropIndex(
    context.state,
    (chainIndex * 5 + step * 11) % (tokenCount + 1),
    start,
    end
  );
  if (toIndex === null) {
    return { ...context, details: [...context.details, `${step}:move:skip-drop:${label}@${start}-${end}`] };
  }
  const leftGroupId = context.state.present.tokens[toIndex - 1]?.groupId;
  const rightGroupId = context.state.present.tokens[toIndex]?.groupId;
  if (leftGroupId && rightGroupId && leftGroupId === rightGroupId) {
    let adjusted = toIndex;
    while (
      adjusted < context.state.present.tokens.length &&
      context.state.present.tokens[adjusted]?.groupId === leftGroupId
    ) {
      adjusted += 1;
    }
    toIndex = adjusted;
  }
  return {
    state: tokenEditorReducer(context.state, {
      type: "MOVE_SELECTED_TOKENS",
      fromStart: start,
      fromEnd: end,
      toIndex,
    }),
    selection: { start: null, end: null },
    details: [...context.details, `${step}:move:${label}@${start}-${end}->${toIndex}`],
  };
};

const correctionTypeMapForState = (state: EditorHistoryState) => {
  const moveMarkers = deriveMoveMarkers(state.present.tokens);
  const correctionCards = deriveCorrectionCards(state.present.tokens, moveMarkers);
  return Object.fromEntries(
    correctionCards.map((card, idx) => [card.id, typeIds[idx % typeIds.length]])
  );
};

const assertPayloadHydrates = async (state: EditorHistoryState, details: string[], label: string) => {
  const tokens = state.present.tokens;
  const moveMarkers = deriveMoveMarkers(tokens);
  const correctionCards = deriveCorrectionCards(tokens, moveMarkers);
  const correctionTypeMap = correctionTypeMapForState(state);
  const payloads = await buildAnnotationsPayloadStandalone({
    initialText: chainText,
    tokens,
    originalTokens: state.present.originalTokens,
    correctionCards,
    correctionTypeMap,
    moveMarkers,
    allowUnassigned: true,
  });

  if (correctionCards.length) {
    expect(payloads.length, `${label} payload count. Ops=${details.join(",")}`).toBeGreaterThan(0);
  }
  if (!payloads.length) return;

  const hydrated = hydrateFromServerAnnotations({
    items: payloads.map((payload, idx) => ({
      id: 100000 + idx,
      author_id: "user-1",
      start_token: payload.start_token,
      end_token: payload.end_token,
      replacement: payload.replacement,
      error_type_id: payload.error_type_id,
      payload: payload.payload,
    })),
    initialText: chainText,
    currentUserId: "user-1",
  });

  expect(hydrated, `${label} hydration null. Ops=${details.join(",")}`).not.toBeNull();
  if (!hydrated) return;
  const hydratedDisplay = tokensToDisplay(hydrated.present.tokens);
  const expectedDisplay = tokensToDisplay(tokens);
  if (JSON.stringify(hydratedDisplay) !== JSON.stringify(expectedDisplay)) {
    throw new Error(
      `${label} hydrated tokens. Ops=${details.join(",")}\n` +
        `expected=${expectedDisplay.join(" ")}\n` +
        `actual=${hydratedDisplay.join(" ")}\n` +
        `expectedTokens=${debugTokenList(tokens)}\n` +
        `hydratedTokens=${debugTokenList(hydrated.present.tokens)}\n` +
        summarizePayloads(payloads, state.present.originalTokens)
    );
  }
  expect(snapshotCorrections({ past: [], present: hydrated.present, future: [] }), `${label} hydrated corrections. Ops=${details.join(",")}`).toEqual(
    snapshotCorrections(state)
  );
};

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

  it("exhaustively validates N=5 operation chains with every undo depth", async () => {
    const chains = enumerateActionChains(5);

    for (let chainIndex = 0; chainIndex < chains.length; chainIndex += 1) {
      const chain = chains[chainIndex];
      let context: ChainContext = {
        state: tokenEditorReducer(createInitialHistoryState(), { type: "INIT_FROM_TEXT", text: chainText }),
        selection: { start: null, end: null },
        details: [],
      };
      const undoableSnapshots: EditorHistoryState[] = [context.state];

      for (let step = 0; step < chain.length; step += 1) {
        const previousPastLength = context.state.past.length;
        context = applyChainAction(context, chain[step], chainIndex, step);
        if (context.state.past.length > previousPastLength) {
          undoableSnapshots.push(context.state);
        }
        await assertPayloadHydrates(context.state, context.details, `chain=${chain.join(">")} step=${step}`);
      }

      const maxUndoDepth = Math.min(chain.length, undoableSnapshots.length - 1);
      for (let undoDepth = 1; undoDepth <= maxUndoDepth; undoDepth += 1) {
        let undone = context.state;
        for (let count = 0; count < undoDepth; count += 1) {
          undone = tokenEditorReducer(undone, { type: "UNDO" });
        }
        const expected = undoableSnapshots[undoableSnapshots.length - 1 - undoDepth];
        if (!sameDisplayState(undone, expected)) {
          throw new Error(
            `Undo mismatch chain=${chain.join(">")} M=${undoDepth}\n` +
              `ops=${context.details.join(",")}\n` +
              `expected=${debugTokenList(expected.present.tokens)}\n` +
              `actual=${debugTokenList(undone.present.tokens)}`
          );
        }
      }
    }
  }, 600000);
});
