'use client';

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from 'react';
import type { AuthUser } from '@meridian/types';
import { api, ApiError, LoginPayload, RegisterPayload } from '@/lib/api';

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (payload: LoginPayload) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const requestCurrentUser = useCallback(async () => {
    const res = await api.auth.me();
    return res.data.user;
  }, []);

  useEffect(() => {
    let active = true;

    const initializeUser = async () => {
      try {
        const currentUser = await requestCurrentUser();
        if (active) setUser(currentUser);
      } catch {
        if (active) setUser(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void initializeUser();
    return () => {
      active = false;
    };
  }, [requestCurrentUser]);

  const refreshCurrentUser = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUser(await requestCurrentUser());
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [requestCurrentUser]);

  const login = async (payload: LoginPayload) => {
    setError(null);
    try {
      const res = await api.auth.login(payload);
      setUser(res.data.user);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : 'Login failed. Please try again.';
      setError(message);
      throw err;
    }
  };

  const register = async (payload: RegisterPayload) => {
    setError(null);
    try {
      const res = await api.auth.register(payload);
      setUser(res.data.user);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Registration failed. Please try again.';
      setError(message);
      throw err;
    }
  };

  const logout = async () => {
    setError(null);
    try {
      await api.auth.logout();
    } finally {
      setUser(null);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        login,
        register,
        logout,
        refresh: refreshCurrentUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
