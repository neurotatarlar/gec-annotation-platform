/**
 * Small ID utilities for stable keys and temporary identifiers.
 */
export const generateId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
};

