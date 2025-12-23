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
  space_before?: boolean;
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
  is_hidden: boolean;
  created_at?: string;
  total_texts: number;
  remaining_texts: number;
  in_progress_texts: number;
  locked_texts: number;
  skipped_texts: number;
  trashed_texts: number;
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

export interface AnnotatorSummary {
  id: string;
  username: string;
  full_name?: string | null;
}

export interface DashboardCategorySummary {
  id: number;
  name: string;
}

export interface DashboardFlaggedEntry {
  id: number;
  flag_type: string;
  reason?: string | null;
  created_at: string;
  text_id: number;
  text_preview: string;
  category: DashboardCategorySummary;
  annotator: AnnotatorSummary;
}

export interface DashboardTaskEntry {
  task_id: number;
  text_id: number;
  status: string;
  updated_at: string;
  text_preview: string;
  category: DashboardCategorySummary;
  annotator: AnnotatorSummary;
}

export interface PaginatedFlagged {
  items: DashboardFlaggedEntry[];
  next_offset?: number | null;
}

export interface PaginatedTasks {
  items: DashboardTaskEntry[];
  next_offset?: number | null;
}

export interface ActivityItem {
  id: number;
  text_id: number;
  kind: "skip" | "trash" | "task";
  status?: string | null;
  occurred_at: string;
  text_preview: string;
  category: DashboardCategorySummary;
  annotator: AnnotatorSummary;
}

export interface PaginatedActivity {
  items: ActivityItem[];
  next_offset?: number | null;
}

export interface DashboardStats {
  total_texts: number;
  pending_texts: number;
  in_annotation_texts: number;
  awaiting_review_texts: number;
  completed_texts: number;
  submitted_tasks: number;
  skipped_count: number;
  trashed_count: number;
  last_updated: string;
}
