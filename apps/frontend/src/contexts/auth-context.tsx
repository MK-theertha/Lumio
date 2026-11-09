import type { AuthResult, AuthUser } from '@lumio/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  apiGet,
  apiSend,
  http,
  refreshSession,
  setAccessToken,
  setSessionLostHandler,
} from '@/lib/api-client';

type LoginResponse = AuthResult | { mfaRequired: true; mfaToken: string };

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ mfaToken?: string }>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  switchCompany: (companyId: string) => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  const accept = useCallback((result: AuthResult) => {
    setAccessToken(result.accessToken);
    setUser(result.user);
  }, []);

  useEffect(() => {
    setSessionLostHandler(() => setUser(null));
    refreshSession()
      .then(accept)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [accept]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await apiSend<LoginResponse>('post', '/auth/login', { email, password });
      if ('mfaRequired' in result) return { mfaToken: result.mfaToken };
      accept(result);
      return {};
    },
    [accept],
  );

  const completeMfa = useCallback(
    async (mfaToken: string, code: string) => {
      accept(await apiSend<AuthResult>('post', '/auth/mfa', { mfaToken, code }));
    },
    [accept],
  );

  const logout = useCallback(async () => {
    await http.post('/auth/logout');
    setAccessToken(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const reload = useCallback(async () => {
    setUser(await apiGet<AuthUser>('/auth/me'));
  }, []);

  const switchCompany = useCallback(
    async (companyId: string) => {
      accept(await apiSend<AuthResult>('post', '/auth/switch-company', { companyId }));
      // Nothing cached from the previous company may be shown under the new one.
      queryClient.clear();
    },
    [accept, queryClient],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      completeMfa,
      logout,
      reload,
      switchCompany,
      can: (permission: string) => user?.permissions.includes(permission) ?? false,
    }),
    [user, loading, login, completeMfa, logout, reload, switchCompany],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
