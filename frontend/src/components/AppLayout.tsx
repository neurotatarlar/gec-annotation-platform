/**
 * Shell layout component that positions the header and page content.
 */
import { ReactNode } from "react";

import { AppHeader } from "./AppHeader";

interface Props {
  children: ReactNode;
}

export const AppLayout = ({ children }: Props) => (
  <div className="min-h-screen bg-slate-950/95 p-6 text-right text-slate-100">
    <AppHeader />
    <div className="mt-4 flex flex-col gap-4">{children}</div>
  </div>
);
