/**
 * Context for save status tracking and UI indicators.
 */
import React, { createContext, useContext, useState } from "react";

import { SaveStatus } from "../types";

type SaveStatusContextValue = {
  status: SaveStatus | null;
  setStatus: (status: SaveStatus | null) => void;
};

const SaveStatusContext = createContext<SaveStatusContextValue | undefined>(undefined);

export const SaveStatusProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [status, setStatus] = useState<SaveStatus | null>(null);
  return <SaveStatusContext.Provider value={{ status, setStatus }}>{children}</SaveStatusContext.Provider>;
};

export const useSaveStatus = () => {
  const ctx = useContext(SaveStatusContext);
  if (!ctx) throw new Error("useSaveStatus must be used within SaveStatusProvider");
  return ctx;
};
