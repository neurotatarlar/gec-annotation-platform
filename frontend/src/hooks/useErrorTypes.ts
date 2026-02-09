/**
 * Hook to fetch and cache error types from the API.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ErrorType } from "../types";

type UseErrorTypesArgs = {
  enabled: boolean;
  loadErrorTypes: () => Promise<ErrorType[]>;
};

export const useErrorTypes = ({ enabled, loadErrorTypes }: UseErrorTypesArgs) => {
  const query = useQuery({
    queryKey: ["error-types"],
    queryFn: loadErrorTypes,
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnMount: true,
  });

  const errorTypes = useMemo(
    () =>
      (query.data ?? []).filter(
        (item) => (item.en_name ?? "").trim().toLowerCase() !== "noop"
      ),
    [query.data]
  );
  const errorTypesError =
    (query.error as any)?.response?.data?.detail ??
    (query.error as any)?.message ??
    (query.error ? String(query.error) : null);

  return {
    errorTypes,
    isLoadingErrorTypes: query.isLoading,
    errorTypesError,
    reload: query.refetch,
  };
};
