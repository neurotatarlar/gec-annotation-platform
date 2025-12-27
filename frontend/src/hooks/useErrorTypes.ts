import { useCallback, useEffect, useState } from "react";

import { ErrorType } from "../types";

type UseErrorTypesArgs = {
  enabled: boolean;
  loadErrorTypes: () => Promise<ErrorType[]>;
};

export const useErrorTypes = ({ enabled, loadErrorTypes }: UseErrorTypesArgs) => {
  const [errorTypes, setErrorTypes] = useState<ErrorType[]>([]);
  const [isLoadingErrorTypes, setIsLoadingErrorTypes] = useState(false);
  const [errorTypesError, setErrorTypesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoadingErrorTypes(true);
    setErrorTypesError(null);
    try {
      const raw = await loadErrorTypes();
      const filtered = raw.filter((item) => (item.en_name ?? "").trim().toLowerCase() !== "noop");
      setErrorTypes(filtered);
    } catch (error: any) {
      setErrorTypesError(error?.response?.data?.detail ?? error?.message ?? String(error));
    } finally {
      setIsLoadingErrorTypes(false);
    }
  }, [loadErrorTypes]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const run = async () => {
      await load();
      if (cancelled) return;
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [enabled, load]);

  return { errorTypes, isLoadingErrorTypes, errorTypesError, reload: load };
};
