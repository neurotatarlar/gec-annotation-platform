/**
 * Logo/wordmark component used in the application header.
 */
import { Link } from "react-router-dom";

interface AppLogoProps {
  className?: string;
}

export const AppLogo = ({ className }: AppLogoProps) => (
  <Link
    to="/"
    className={`flex items-center gap-2 rounded-full bg-emerald-500/10 px-3 py-1 text-left ${className ?? ""}`}
  >
    <span className="flex h-8 w-8 items-center justify-center rounded-full border border-emerald-400/60 bg-emerald-500/20 text-lg font-semibold text-emerald-200">
      Т
    </span>
    <span className="text-base font-bold uppercase tracking-wider text-emerald-200">Тамгадар</span>
  </Link>
);
