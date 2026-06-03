/**
 * Coordinates annotation decisions that leave the current text.
 */
import { useCallback, useState } from "react";

type FlagAction = "skip" | "trash";
type LastDecision = FlagAction | "submit" | null;

type UseAnnotationDecisionActionsArgs = {
  textId: number;
  categoryId: number;
  get: (url: string, options?: any) => Promise<any>;
  post: (url: string, payload?: any, options?: any) => Promise<any>;
  navigate: (to: string) => void;
  queryClient: { setQueryData: (key: unknown[], value: unknown) => void };
  t: (key: string) => string;
  formatError: (error: any) => string;
  pendingAction: FlagAction | null;
  flagReason: string;
  openFlagConfirm: (flagType: FlagAction) => void;
  closeFlagConfirm: () => void;
  updateFlagError: (message: string | null) => void;
  setLastDecision: (decision: LastDecision) => void;
};

const NO_TEXTS_MESSAGE = "No texts available right now. Please try again.";

export const useAnnotationDecisionActions = ({
  textId,
  categoryId,
  get,
  post,
  navigate,
  queryClient,
  t,
  formatError,
  pendingAction,
  flagReason,
  openFlagConfirm,
  closeFlagConfirm,
  updateFlagError,
  setLastDecision,
}: UseAnnotationDecisionActionsArgs) => {
  const [isSkipping, setIsSkipping] = useState(false);
  const [isTrashing, setIsTrashing] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const requestNextText = useCallback(async () => {
    try {
      const response = await post("/api/texts/assignments/next", null, {
        params: { category_id: categoryId },
      });
      const nextId = response.data?.text?.id;
      if (nextId && nextId !== textId) {
        if (response.data?.text) {
          queryClient.setQueryData(["text", String(nextId)], response.data.text);
        }
        navigate(`/annotate/${nextId}`);
        return true;
      }
      return false;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404) {
        try {
          const categories = await get("/api/categories/");
          const current = (categories.data as Array<{ id: number; remaining_texts: number }>).find(
            (category) => category.id === categoryId
          );
          if (current && current.remaining_texts > 0) {
            setActionMessage(t("categories.noTextsAvailableNow") ?? NO_TEXTS_MESSAGE);
            return false;
          }
          navigate("/");
          return true;
        } catch {
          setActionMessage(t("categories.noTextsAvailableNow") ?? NO_TEXTS_MESSAGE);
          return false;
        }
      }
      setActionError(formatError(error));
    }
    return false;
  }, [categoryId, formatError, get, navigate, post, queryClient, t, textId]);

  const handleFlag = useCallback(
    (flagType: FlagAction) => {
      setActionError(null);
      setActionMessage(null);
      openFlagConfirm(flagType);
    },
    [openFlagConfirm]
  );

  const confirmFlag = useCallback(async () => {
    if (!pendingAction) return;
    const flagType = pendingAction;
    setActionError(null);
    setActionMessage(null);
    updateFlagError(null);
    flagType === "skip" ? setIsSkipping(true) : setIsTrashing(true);
    let succeeded = false;
    try {
      const reason = flagReason.trim();
      await post(`/api/texts/${textId}/${flagType}`, { reason: reason || undefined });
      setLastDecision(flagType);
      await requestNextText();
      succeeded = true;
    } catch (error: any) {
      updateFlagError(formatError(error));
    } finally {
      flagType === "skip" ? setIsSkipping(false) : setIsTrashing(false);
      if (succeeded) {
        closeFlagConfirm();
      }
    }
  }, [
    closeFlagConfirm,
    flagReason,
    formatError,
    pendingAction,
    post,
    requestNextText,
    setLastDecision,
    textId,
    updateFlagError,
  ]);

  const cancelFlag = useCallback(() => {
    closeFlagConfirm();
  }, [closeFlagConfirm]);

  return {
    requestNextText,
    handleFlag,
    confirmFlag,
    cancelFlag,
    isSkipping,
    isTrashing,
    actionMessage,
    setActionMessage,
    actionError,
    setActionError,
  };
};
