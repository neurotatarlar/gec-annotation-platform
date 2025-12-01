# Annotation Experience Redesign

## Goals

1. Give annotators a predictable editing surface that mirrors what they see in the text canvas.
2. Support every requested operation without “modes”: insert, delete, split, merge, reorder, swap, edit-in-place.
3. Allow a single correction to describe multiple simultaneous changes (delete, insert, reorder, etc.).
4. Let the same base token participate in more than one correction (e.g., swap + edit).
5. Keep both the “old” snippet and the “corrected” snippet editable after a correction is created.

## High-Level Model

### Tokens

```ts
type TokenId = string; // e.g. "base-12" or "draft-uuid"

type BaseToken = {
  id: TokenId;
  index: number;
  text: string;
};

type DraftToken = {
  id: TokenId;
  text: string;
  origin: "base" | "inserted";
};
```

`BaseToken` is an immutable snapshot of the text returned by the backend. We never delete or mutate it; we only reference it.  
`DraftToken` represents a token in the corrected snippet (`origin === "inserted"`) or a reused reference to a base token (`origin === "base"`).

### Corrections

```ts
type CorrectionDraft = {
  id: string;
  errorTypeId: number | null;
  beforeTokens: TokenId[]; // ordered references into BaseToken[]
  afterTokens: DraftToken[]; // ordered sequence user can edit freely
  note?: string;
};
```

- `beforeTokens` preserves the original order that the user selected. Swapping two base tokens is modeled by reordering this array.  
- `afterTokens` is the corrected snippet. All editing, splitting, merging, insertion, and swapping happen against this array without affecting other corrections.
- A base token can appear in multiple `beforeTokens` arrays, so overlapping corrections are natural.

### Canvas State

- `selection: TokenId[]` – ordered list of tokens currently highlighted in the canvas (multi-select via click/shift-drag).  
- `activeCorrectionId: string | null` – which correction is open inside the editor pane.  
- `pendingAction: { type: "split" | "merge" | "swap" | "insert-before" | ... } | null` – short-lived UI flag (e.g., after clicking “Merge” we expect two clicks).

## Operations

| Operation | UX | Data Change |
|-----------|----|-------------|
| **Add correction** | Select one or more tokens → press “New correction” → opens editor with `beforeTokens` set. | Create `CorrectionDraft` with `afterTokens = beforeTokens.map(tokenRef)` (1:1 copy). |
| **Delete tokens** | In the editor, select tokens in “Corrected” column → press “Delete”. | Remove entries from `afterTokens`; result can be empty (pure deletion). |
| **Insert tokens** | In the editor, click `+ Add token` between tokens or at edges. | Insert new `DraftToken { id: uuid(), text: "" , origin: "inserted" }` into `afterTokens`. |
| **Split token** | Double-click a token inside “Corrected” column; inline editor appears; typing whitespace or punctuation splits automatically. | Replace one `DraftToken` with multiple `DraftToken`s (derived from tokenizer). |
| **Merge tokens** | Select adjacent tokens → click “Merge”. | Replace the selection with a single `DraftToken` whose `text` is the concatenation of the selection. |
| **Swap tokens** | Drag tokens within “Corrected” column or click “Swap order” when two tokens are selected. | Reorder `afterTokens`. |
| **Edit in place** | Double-click or press Enter on token cell. | Update the `text` of that `DraftToken` (and re-tokenize if needed to keep history). |
| **Edit original snippet** | “Original” column contains chips for each `beforeTokens` entry with drag handles + remove buttons. | Reorder or remove ids from `beforeTokens`. Removing a base token does **not** delete the actual token on the canvas; it simply means this correction no longer references it. |
| **Change error type / note** | Dropdown + textarea directly in the correction card. | Update `errorTypeId`/`note`. |
| **Multiple changes per error** | Everything above works inside a single correction; the user doesn’t need separate entries. | `afterTokens` can represent any combination of add/remove/edit operations relative to `beforeTokens`. |
| **Same token in multiple corrections** | Allowed by design (separate `CorrectionDraft` objects can mention identical `beforeTokens`). | No restriction – we do not mutate tokens globally. |

## UI Layout

```
┌────────────────────────────────────────────────────────────────┐
│ Text Canvas (Base tokens)                                      │
│  • click to select tokens                                      │
│  • selection persists until cleared                            │
│                                                                │
│ Toolbar: [New correction] [Clear selection] [Toggle multi-select] … |
└────────────────────────────────────────────────────────────────┘

┌───────────────┬───────────────────────────────────────────────┐
│ Sidebar       │ Correction Editor                            │
│ (list of      │                                               │
│ corrections)  │  Original (before)   |   Corrected (after)    │
│               │  [chip chip chip]    |   [token][token][+]    │
│               │                      |   per-token actions    │
└───────────────┴───────────────────────────────────────────────┘
```

- Selecting a correction in the sidebar highlights its tokens in the canvas.
- “Original” column chips show the source tokens; each chip exposes Remove/Drag handles.
- “Corrected” column tokens behave like tags with inline editing. Each has a context menu with Split, Merge, Swap, Delete.
- Inline keyboard shortcuts mirror the toolbar (Enter = edit/save, Escape = cancel, Ctrl+Backspace = delete token, Ctrl+Shift+Arrow = reorder).

## State Transitions

1. **Create**  
   - `beforeTokens = currentSelection` (ordered).  
   - `afterTokens = beforeTokens.map(cloneBaseToken)` so the corrected snippet starts identical.
2. **Edit**  
   - All per-token actions mutate `afterTokens` only.  
   - Reordering `beforeTokens` updates the preview in the canvas, but does not touch other corrections.
3. **Save**  
   - Persist `CorrectionDraft` as-is via `/api/texts/:id/annotations`.  
   - Server stores `beforeTokens` + `afterTokens` payload so any complex change is reproducible.

### Token Serialization

Backend change: extend annotation payload to include both arrays.

```jsonc
{
  "start_token": 12,
  "end_token": 16,
  "payload": {
    "operation": "replace",
    "text_sha256": "<hash-of-original-text>",
    "before_tokens": ["base-12", "base-13", "base-16"],
    "after_tokens": [
      { "id": "base-12", "text": "to", "origin": "base" },
      { "id": "draft-b83", "text": "quickly", "origin": "inserted" }
    ],
    "note": "optional",
    "source": "manual"
  }
}
```

Old APIs that expect contiguous `start_token`/`end_token` still work (we retain span for backwards compatibility), but the UI relies on `payload.beforeTokens/afterTokens` to rebuild the correction.

## Implementation Phases

1. **State groundwork**
   - Introduce `CorrectionDraft` model + helper utilities (clone base tokens, tokenize, reorder).
   - Store drafts keyed by `id`; drop legacy `editingRange/mergeMode` state.
2. **Canvas selection rewrite**
   - Simplify to multi-select array; highlight tokens per correction selection.
3. **Correction editor**
   - Build dedicated component to manage `beforeTokens` and `afterTokens`.
   - Implement per-token controls (inline edit, add/remove, split/merge, reorder).
4. **Sidebar + persistence**
   - Update sidebar to display new data (before/after preview, error type, counts).
   - Adjust save/submit payloads to send `beforeTokens`/`afterTokens`.
5. **Backward compatibility + migrations**
   - Provide migration helpers to convert legacy annotations (`replacement + tokenParts`) into the new shape on load so existing data still appears.
6. **Polish**
   - Keyboard shortcuts, undo stack, highlighting overlapping corrections, tests.

## Notes & Open Questions

- **Pre-annotated imports**: accept M2 files (standard for GEC). Backend converts each contiguous, non-overlapping edit into a `CorrectionDraft` by mapping the span to `beforeTokens` and tokenizing the replacement into `afterTokens`. Imported corrections are treated exactly like user-created ones (fully editable). Optionally tag them with `payload.source = "import"` for provenance.
- **Token IDs**: we can derive deterministic `base-${index}` IDs for source tokens and UUIDs for inserted tokens.  
- **Swap semantics**: swapping tokens in “Corrected” column automatically changes their order; no special operation needed.  
- **Overlapping visualization**: when a correction is active, highlight all related tokens in the canvas even if other corrections share them (use badge chips to distinguish).  
- **Backend validation**: ensure inserted tokens serialize cleanly (maybe limit token count per correction).  
- **Batch actions**: we can keep `undo/redo` by snapshotting `CorrectionDraft` objects in history stack (similar to current `setWithHistory`).

This design removes modal editing modes, keeps both versions visible, and treats every manipulation as a pure transformation of two ordered token lists, which naturally supports all requested behaviors.
