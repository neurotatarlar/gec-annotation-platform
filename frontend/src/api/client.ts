import axios from "axios";
import { useMemo } from "react";

import { useAuth } from "../context/AuthContext";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:8000",
  headers: { "Content-Type": "application/json" }
});

export const useAuthedApi = () => {
  const { token, logout } = useAuth();
  return useMemo(() => {
    const instance = axios.create({ baseURL: api.defaults.baseURL });
    instance.interceptors.request.use((config) => {
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    });
    instance.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error?.response?.status === 401) {
          logout("session-expired");
        }
        return Promise.reject(error);
      }
    );
    return instance;
  }, [token, logout]);
};
