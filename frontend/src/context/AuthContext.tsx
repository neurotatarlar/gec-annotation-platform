import { ReactNode, createContext, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

interface AuthContextState {
  token: string | null;
  login: (token: string) => void;
  logout: (reason?: string) => void;
}

const AuthContext = createContext<AuthContextState | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
  const navigate = useNavigate();

  useEffect(() => {
    if (token) {
      localStorage.setItem("token", token);
    } else {
      localStorage.removeItem("token");
    }
  }, [token]);

  const value = useMemo(
    () => ({
      token,
      login: (newToken: string) => {
        setToken(newToken);
        navigate("/", { replace: true });
      },
      logout: (reason?: string) => {
        setToken(null);
        navigate("/login", {
          replace: true,
          state: reason ? { reason } : undefined
        });
      }
    }),
    [token, navigate]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
};
