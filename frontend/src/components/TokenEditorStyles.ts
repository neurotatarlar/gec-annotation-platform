/**
 * Shared style tokens and class helpers for token editor visuals.
 */
import type { CSSProperties } from "react";

export const chipBase: CSSProperties = {
  padding: "0px",
  display: "inline-flex",
  alignItems: "center",
  gap: 0,
  border: "none",
  background: "transparent",
  transition: "color 0.15s ease, text-decoration 0.15s ease",
};

export const chipStyles: Record<string, CSSProperties> = {
  word: { ...chipBase, color: "#e2e8f0", padding: "0px" },
  punct: {
    ...chipBase,
    color: "#e2e8f0",
    padding: 0,
    gap: 0,
    margin: 0,
    justifyContent: "center",
  },
  special: { ...chipBase, color: "#cbd5e1", borderBottom: "1px dotted rgba(148,163,184,0.8)" },
  empty: { ...chipBase, color: "#cbd5e1" },
  previous: {
    ...chipBase,
    color: "#64748b",
    fontSize: 12,
    textShadow: "0 0 6px rgba(100,116,139,0.45)",
    fontStyle: "italic",
  },
  changed: { color: "#e2e8f0" },
  selected: {
    background: "rgba(14,165,233,0.15)",
    border: "1px solid rgba(14,165,233,0.6)",
    borderRadius: 10,
  },
};

export const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background: "#0b1120",
  color: "#e2e8f0",
  padding: 16,
  boxSizing: "border-box",
  fontFamily: "Inter, system-ui, -apple-system, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

export const twoColumnLayoutStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  flexWrap: "wrap",
};

export const mainColumnStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  flex: 1,
  minWidth: 0,
};

export const workspaceStyle: CSSProperties = {
  background: "rgba(15,23,42,0.9)",
  borderRadius: 14,
  padding: 8,
  border: "1px solid rgba(51,65,85,0.7)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  position: "relative",
};

export const rowLabelStyle: CSSProperties = {
  color: "#cbd5e1",
  fontSize: 12,
  marginBottom: 8,
};

export const tokenRowStyleBase: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-start",
  background: "rgba(15,23,42,0.6)",
  padding: "8px 12px",
  borderRadius: 12,
  border: "1px solid rgba(51,65,85,0.6)",
  position: "relative",
};

export const actionBarStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "6px 0",
};

export const toolbarRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: 10,
};

export const actionGroupStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
  marginLeft: "auto",
};

export const spacingRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

export const actionFeedbackStyle: CSSProperties = {
  minHeight: 2,
  marginTop: 2,
  fontSize: 12,
};

export const actionDividerStyle: CSSProperties = {
  width: 1,
  height: 28,
  background: "rgba(148,163,184,0.35)",
};

export const categoryPanelStyle: CSSProperties = {
  background: "rgba(15,23,42,0.9)",
  borderRadius: 14,
  padding: 12,
  border: "1px solid rgba(51,65,85,0.7)",
};

export const categoryChipStyle: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  color: "#e2e8f0",
  fontWeight: 600,
  minWidth: 0,
  width: "auto",
  textAlign: "left",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  lineHeight: 1.2,
  cursor: "pointer",
};

export const categoryColors = [
  "rgba(120,53,15,0.35)",
  "rgba(17,94,89,0.45)",
  "rgba(37,99,235,0.35)",
  "rgba(76,29,149,0.35)",
  "rgba(30,64,175,0.35)",
  "rgba(153,27,27,0.35)",
];

export const miniOutlineButton: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(236,72,153,0.5)",
  color: "#f9a8d4",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
};

export const miniNeutralButton: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid rgba(148,163,184,0.6)",
  color: "#e2e8f0",
  background: "rgba(15,23,42,0.6)",
  cursor: "pointer",
  fontSize: 12,
};

export const primaryActionStyle: CSSProperties = {
  padding: "8px 14px",
  borderRadius: 10,
  border: "1px solid rgba(16,185,129,0.6)",
  background: "rgba(16,185,129,0.2)",
  color: "#a7f3d0",
  fontWeight: 700,
  cursor: "pointer",
  fontSize: 13,
};

export const secondaryActionStyle: CSSProperties = {
  ...primaryActionStyle,
  border: "1px solid rgba(148,163,184,0.6)",
  background: "rgba(148,163,184,0.15)",
  color: "#e2e8f0",
};

export const dangerActionStyle: CSSProperties = {
  ...primaryActionStyle,
  border: "1px solid rgba(248,113,113,0.6)",
  background: "rgba(248,113,113,0.15)",
  color: "#fecdd3",
};

export const modalOverlayStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  zIndex: 50,
};

export const modalContentStyle: CSSProperties = {
  background: "rgba(15,23,42,0.95)",
  border: "1px solid rgba(51,65,85,0.8)",
  borderRadius: 14,
  padding: 16,
  maxWidth: 360,
  width: "100%",
};
