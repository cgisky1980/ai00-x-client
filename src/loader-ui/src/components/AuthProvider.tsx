import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getCurrentUser, logout } from "@/lib/auth";
import { tokenManager } from "@/lib/tokenManager";
import { isTokenExpired } from "@/lib/auth";

interface AuthContextType {
  isLoggedIn: boolean;
  isLoading: boolean;
  username: string | null;
}

const AuthContext = createContext<AuthContextType>({
  isLoggedIn: false,
  isLoading: true,
  username: null,
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    let settled = false;

    // 超时兜底：5s 后无论结果如何都结束 loading，避免永久卡死
    const timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        setIsLoading(false);
      }
    }, 5000);

    const autoVerify = async () => {
      try {
        // 先检查本地是否有 token，无 token 直接结束 loading
        const user = await getCurrentUser();
        if (!user || !user.token) {
          if (!settled) {
            settled = true;
            setIsLoading(false);
          }
          return;
        }

        // 启动时策略:
        // - access 未过期 → 直接进主页
        // - access 过期 + 有 refresh_token → 调 tokenManager.refreshIfNeeded() 拿新 access → 进主页
        // - access 过期 + 无 refresh_token → logout(旧用户首次升级)
        // - refresh 也过期(401 from server) → 由 onRefreshFailed 监听器触发 logout
        if (!isTokenExpired(user.token, 60)) {
          // access 未过期,直接进主页
          if (!settled) {
            settled = true;
            setIsLoggedIn(true);
            setUsername(user.username);
            setIsLoading(false);
          }
          return;
        }

        // access 即将过期或已过期,尝试 refresh
        if (!user.refresh_token) {
          // 旧用户(无 refresh_token),触发 logout 让用户重新登录获取 token 对
          console.info("[AuthProvider] no refresh_token, clearing (legacy user)");
          if (!settled) {
            settled = true;
            setIsLoading(false);
          }
          await logout();
          return;
        }

        const newToken = await tokenManager.refreshIfNeeded();
        if (!settled) {
          settled = true;
          if (newToken) {
            setIsLoggedIn(true);
            setUsername(user.username);
            setIsLoading(false);
          } else {
            // refresh 失败,由 onRefreshFailed 监听器处理跳登录页
            setIsLoading(false);
          }
        }
      } catch (e) {
        console.warn("[AuthProvider] auto verify failed:", e);
        if (!settled) {
          settled = true;
          setIsLoading(false);
        }
      }
    };

    autoVerify();

    // 注册 refresh 失败监听:任何请求触发 refresh 失败时,自动 logout
    const unregister = tokenManager.onRefreshFailed(async (_err) => {
      if (!settled) {
        settled = true;
        setIsLoading(false);
      }
      setIsLoggedIn(false);
      await logout();
    });

    // 仍监听 ai00-login-success 事件（登录/注册/免登录进入成功后触发）
    const handleLoginSuccess = async () => {
      setIsLoggedIn(true);
      setIsLoading(false);
      try {
        const user = await getCurrentUser();
        if (user) setUsername(user.username);
      } catch {
        // ignore — 用户刚登录,token 应有效
      }
    };

    window.addEventListener("ai00-login-success", handleLoginSuccess);
    return () => {
      clearTimeout(timeoutId);
      unregister();
      window.removeEventListener("ai00-login-success", handleLoginSuccess);
    };
  }, []);

  return (
    <AuthContext.Provider value={{ isLoggedIn, isLoading, username }}>
      {children}
    </AuthContext.Provider>
  );
}

export function AuthGuard({ children }: { children: ReactNode }) {
  const { isLoggedIn, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--page-bg)' }}>
        <div className="animate-spin w-8 h-8 border-2 rounded-full" style={{ borderColor: 'rgb(var(--primary))', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (!isLoggedIn) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
}

export function GuestGuard({ children }: { children: ReactNode }) {
  const { isLoggedIn, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'var(--page-bg)' }}>
        <div className="animate-spin w-8 h-8 border-2 rounded-full" style={{ borderColor: 'rgb(var(--primary))', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (isLoggedIn) {
    const from = (location.state as { from?: Location })?.from?.pathname || "/";
    return <Navigate to={from} replace />;
  }

  return <>{children}</>;
}
