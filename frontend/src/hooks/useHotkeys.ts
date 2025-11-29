import { useEffect } from "react";

export const useAnnotationHotkeys = (bindings: Record<string, () => void>) => {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const action = bindings[key];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [bindings]);
};
