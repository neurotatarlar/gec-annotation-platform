export interface ErrorType {
  id: number;
  description?: string | null;
  scope?: string | null;
  default_color: string;
  default_hotkey?: string | null;
  category_en?: string | null;
  category_tt?: string | null;
  en_name?: string | null;
  tt_name?: string | null;
  is_active: boolean;
}

export interface AnnotationDraft {
  id?: number;
  start_token: number;
  end_token: number;
  replacement?: string | null;
  error_type_id: number;
  payload: AnnotationDetailPayload;
}

export interface AnnotationSavePayload {
  annotations: AnnotationDraft[];
  client_version: number;
  deleted_ids?: number[];
}

export type TokenId = string;

export interface BaseToken {
  id: TokenId;
  index: number;
  text: string;
}

export interface DraftTokenFragment {
  id: TokenId;
  text: string;
  origin: "base" | "inserted";
  sourceId?: TokenId | null;
}

export interface CorrectionDraftV2 {
  id: string;
  errorTypeId: number | null;
  beforeTokens: TokenId[];
  afterTokens: DraftTokenFragment[];
  note?: string | null;
  payload?: Record<string, unknown>;
}

export interface TokenFragmentPayload {
  id: string;
  text: string;
  origin: "base" | "inserted";
  source_id?: string | null;
}

export interface AnnotationDetailPayload {
  text_sha256?: string | null;
  operation: "replace" | "delete" | "insert" | "move" | "noop";
  before_tokens: string[];
  after_tokens: TokenFragmentPayload[];
  note?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

export interface TextData {
  id: number;
  content: string;
  category_id: number;
  required_annotations: number;
}

export interface CategorySummary {
  id: number;
  name: string;
  description?: string | null;
  total_texts: number;
  remaining_texts: number;
  in_progress_texts: number;
  awaiting_review_texts: number;
}

export interface CrossValidationResult {
  text_id: number;
  status: string;
  result: Record<string, unknown>;
  updated_at: string;
}

export interface TextDiffPairs {
  text_id: number;
  pairs: {
    pair: string[];
    only_left: [number, number, string | null, number][];
    only_right: [number, number, string | null, number][];
  }[];
}

export interface ErrorTypePreference {
  error_type_id: number;
  color?: string | null;
  hotkey?: string | null;
  custom_name?: string | null;
}

export interface HistoryItem {
  text_id: number;
  status: string;
  updated_at: string;
  preview: string;
}

export interface FlaggedTextEntry {
  id: number;
  text: TextData;
  reason?: string | null;
  created_at: string;
  flag_type: string;
}
