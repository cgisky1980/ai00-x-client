import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { setLoggedInPair, getCurrentUser, logout, downloadProfile } from "@/lib/auth";
import { authApi, DeviceBindError, DEVICE_BIND_ERROR_CODES } from "@/lib/api";
import { tokenManager } from "@/lib/tokenManager";
import { useI18n } from "@/lib/i18n";
import { storage } from "@/lib/storage";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadAvatarLocal } from "@/lib/avatar/avatarStorage";
import { AvatarCustomizer, type AvatarValue } from "@/lib/avatar/AvatarCustomizer";

type Mode = "login" | "register" | "success";

interface SavedAuth {
  username: string;
  token: string;
  nickname?: string | null;
  hasAvatar: boolean;
  avatarSelection?: AvatarValue | null;
}

export function LoginPage() {
  const navigate = useNavigate();
  const { t, locale, setLocale } = useI18n();
  const [mode, setMode] = useState<Mode>("login");
  const [loggedInUser, setLoggedInUser] = useState("");

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [inviteCode, setInviteCode] = useState("");
  const [registrationId, setRegistrationId] = useState("");
  const [regUsername, setRegUsername] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState(0);

  // 免登录：检测到已登录态时显示快速入口
  const [savedAuth, setSavedAuth] = useState<SavedAuth | null>(null);
  const [quickEntering, setQuickEntering] = useState(false);

  // 启动时检测已登录态（Tauri invoke get_auth_info）
  useEffect(() => {
    let cancelled = false;
    const detect = async () => {
      try {
        const user = await getCurrentUser();
        if (!user || !user.token) return;
        // 尝试获取 profile（昵称 + avatar_data）
        let nickname: string | null = null;
        let hasAvatar = false;
        let avatarSelection: AvatarValue | null = null;
        try {
          const profile = await authApi.getMemberProfile(user.token);
          nickname = profile.member.nickname ?? null;
          const avatarData = profile.member.avatar_data;
          if (avatarData && typeof avatarData === "string") {
            try {
              const parsed = JSON.parse(avatarData) as AvatarValue;
              if (parsed && parsed.parts && parsed.colors) {
                avatarSelection = parsed;
                hasAvatar = true;
                // 同步到 Rust KV 存储（underlay-ui 可读取）
                await storage.set("ai00-x-avatar", avatarData);
              }
            } catch { /* ignore parse error */ }
          }
        } catch (e) {
          // token 可能过期，但仍显示免登录入口（点击时会再验证）
          console.warn("[LoginPage] getMemberProfile failed:", e);
        }
        // 服务端没有 avatar_data 时，尝试本地缓存
        if (!hasAvatar) {
          const local = await loadAvatarLocal();
          if (local && local.parts && local.colors) {
            avatarSelection = local;
            hasAvatar = true;
          }
        }
        if (cancelled) return;
        setSavedAuth({
          username: user.username,
          token: user.token,
          nickname,
          hasAvatar,
          avatarSelection,
        });
      } catch (e) {
        console.warn("[LoginPage] detect saved auth failed:", e);
      }
    };
    detect();
    return () => { cancelled = true; };
  }, []);

  // 点击"免登录进入"：通过 tokenManager 自动处理 access 过期 + refresh
  const handleQuickEnter = async () => {
    if (!savedAuth || quickEntering) return;
    setQuickEntering(true);
    setError("");
    try {
      // tokenManager.getAccessToken():本地 exp 预判,过期则自动 refresh
      const token = await tokenManager.getAccessToken();
      if (!token) {
        throw new Error("no valid access token");
      }
      // 标记本次会话已通过登录，通知 AuthProvider 设置 isLoggedIn=true
      await storage.set("login_passed", "1");
      window.dispatchEvent(new CustomEvent("ai00-login-success"));
      navigate("/");
    } catch (e) {
      // token 无效且 refresh 失败：清除已登录态，显示登录表单
      console.warn("[LoginPage] quick enter failed:", e);
      setError(t("tokenExpired") || "登录已过期，请重新登录");
      try {
        await logout();
      } catch { /* ignore */ }
      setSavedAuth(null);
    } finally {
      setQuickEntering(false);
    }
  };

  // 切换到正常登录表单（隐藏免登录卡片）
  const handleSwitchToLogin = () => {
    setSavedAuth(null);
    setMode("login");
    setError("");
  };

  const completeLogin = async (
    accessToken: string,
    refreshToken: string,
    username: string,
    memberId?: number
  ) => {
    let planTier: string | undefined;
    try {
      const profile = await authApi.getMemberProfile(accessToken);
      planTier = profile.member.plan_tier;
    } catch {
      // tier fetch is optional, proceed without it
    }
    await setLoggedInPair(username, accessToken, refreshToken, planTier, memberId);
    setLoggedInUser(username);
    setMode("success");
    // 标记本次会话已通过登录验证
    await storage.set("login_passed", "1");
    window.dispatchEvent(new CustomEvent("ai00-login-success"));

    // 后台拉取服务端 profile（新设备恢复配置，非阻塞，失败不影响登录）
    downloadProfile()
      .then((result) => {
        if (result.downloaded > 0) {
          console.log(`[Login] profile restored: ${result.downloaded} items downloaded`);
        }
      })
      .catch((e) => {
        console.warn("[Login] profile download failed (non-fatal):", e);
      });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      // 步骤 1: 脚本路径 login(触发设备绑定,返回 username + member_id)
      const scriptResult = await authApi.login({
        identifier,
        password,
      });
      // 步骤 2: Rust API login 拿 access + refresh token 对
      // 用 username 而非 identifier(Rust API 只接受 username,不接受 email)
      const loginUsername = scriptResult.username;
      const rustResult = await authApi.loginRust({
        username: loginUsername,
        password,
      });
      await completeLogin(
        rustResult.access_token,
        rustResult.refresh_token,
        loginUsername,
        scriptResult.member_id
      );
    } catch (err) {
      if (err instanceof DeviceBindError) {
        // 设备绑定错误：给出明确提示，引导用户解绑
        if (err.code === DEVICE_BIND_ERROR_CODES.ACCOUNT_BOUND_OTHER_DEVICE) {
          setError(t("accountBoundOtherDevice") || "该账号已绑定其他设备，请先在原设备上解绑");
        } else if (err.code === DEVICE_BIND_ERROR_CODES.DEVICE_BOUND_OTHER_ACCOUNT) {
          setError(t("deviceBoundOtherAccount") || "该设备已绑定其他账号，请先解绑原账号");
        } else if (err.code === DEVICE_BIND_ERROR_CODES.MACHINE_BIND_LIMIT) {
          // 4024: 单台机器历史绑定账号总数超限
          // loader-ui 的 t() 不支持插值参数，手动替换 {{used}}/{{limit}} 占位符
          const used = err.data?.used ?? 0;
          const limit = err.data?.limit ?? 0;
          const template =
            t("machineBindLimitExceeded") ||
            `该设备已绑过其他账号（${used}/${limit}），请联系管理员处理`;
          setError(
            template
              .replace("{{used}}", String(used))
              .replace("{{limit}}", String(limit))
          );
        } else {
          setError(err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : "Login failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleInviteLock = async () => {
    if (!inviteCode.trim()) {
      setError(t("inviteCode") + " required");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const result = await authApi.inviteLock(inviteCode);
      setRegistrationId(result.registration_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite code invalid");
    } finally {
      setLoading(false);
    }
  };

  const handleSendEmailCode = async () => {
    if (!registrationId || !regEmail.trim()) return;
    setError("");
    try {
      await authApi.emailSendCode(regEmail);
      setEmailCodeSent(true);
      setEmailCooldown(60);
      const timer = setInterval(() => {
        setEmailCooldown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send code failed");
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (regPassword !== confirmPassword) {
      setError(t("passwordMismatch"));
      return;
    }
    setLoading(true);
    try {
      // 步骤 1: 脚本路径 register(只创建账号,不返回 token)
      await authApi.register({
        registration_id: registrationId,
        email: regEmail,
        code: emailCode,
        username: regUsername,
        password: regPassword,
      });
      // 步骤 2: Rust API login 拿 access + refresh token 对(注册即登录)
      const rustResult = await authApi.loginRust({
        username: regUsername,
        password: regPassword,
      });
      await completeLogin(
        rustResult.access_token,
        rustResult.refresh_token,
        regUsername,
        rustResult.member.id
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Register failed");
    } finally {
      setLoading(false);
    }
  };

  const handleContinue = () => {
    navigate("/");
  };

  return (
    <div className="h-screen w-screen flex items-center justify-center bg-transparent">
      <div
        className="w-full h-full relative overflow-hidden rounded-xl border shadow-2xl"
        style={{ borderColor: "var(--border)", backgroundColor: "var(--card-bg)" }}
      >
        <div className="absolute top-0 left-0 right-0 h-10 z-0" data-tauri-drag-region />
        <div className="absolute top-2 right-4 z-50 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
            className="btn-plain rounded-md px-2 py-1 text-xs font-medium"
            style={{ color: "var(--text-50)" }}
          >
            {locale === "zh" ? "EN" : "中"}
          </button>
          <button
            type="button"
            onClick={async () => {
              const currentWindow = await getCurrentWindow();
              await currentWindow.close();
            }}
            className="btn-plain rounded-lg h-7 w-7 p-0 flex items-center justify-center hover:opacity-70"
            aria-label={t("exit")}
          >
            ✕
          </button>
        </div>

        <div className="h-full flex flex-col items-center justify-center px-8">
          <div className="w-full max-w-md">
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold mb-2" style={{ color: "var(--text-90)" }}>
                {t("appName")}
              </h1>
              <p style={{ color: "var(--text-50)" }}>{t("appDescription")}</p>
            </div>

            {mode === "success" ? (
              <div className="text-center">
                <div className="text-2xl font-light mb-4" style={{ color: "var(--text-90)" }}>
                  {t("welcomeBack")}, {loggedInUser}
                </div>
                <button className="btn-primary w-full" onClick={handleContinue}>
                  {t("continue")}
                </button>
              </div>
            ) : savedAuth ? (
              <div className="text-center space-y-5">
                {/* 免登录卡片：显示用户形象占位 + 昵称 */}
                <div
                  className="mx-auto rounded-2xl p-6 flex flex-col items-center gap-3 border"
                  style={{
                    borderColor: "var(--border)",
                    backgroundColor: "var(--bg-secondary, rgba(255,255,255,0.04))",
                  }}
                >
                  {/* Spine 头像预览（复用 AvatarCustomizer previewOnly 模式） */}
                  <div
                    className="w-24 h-24 rounded-full overflow-hidden flex items-center justify-center"
                    style={{ backgroundColor: "rgb(var(--primary) / 0.15)" }}
                  >
                    {savedAuth.avatarSelection ? (
                      <AvatarCustomizer value={savedAuth.avatarSelection} previewOnly onChange={() => {}} />
                    ) : (
                      <span className="text-4xl">👤</span>
                    )}
                  </div>
                  <div>
                    <div className="text-lg font-medium" style={{ color: "var(--text-90)" }}>
                      {savedAuth.nickname || savedAuth.username}
                    </div>
                    <div className="text-xs" style={{ color: "var(--text-50)" }}>
                      @{savedAuth.username}
                    </div>
                  </div>
                </div>

                {error && (
                  <p className="text-sm" style={{ color: "var(--destructive)" }}>
                    {error}
                  </p>
                )}

                <button
                  className="btn-primary w-full"
                  onClick={handleQuickEnter}
                  disabled={quickEntering}
                >
                  {quickEntering ? "..." : t("quickEnter") || "免登录进入"}
                </button>

                <div className="text-center">
                  <button
                    type="button"
                    className="btn-plain text-sm"
                    style={{ color: "rgb(var(--primary))" }}
                    onClick={handleSwitchToLogin}
                  >
                    {t("switchAccount") || "切换账号登录"}
                  </button>
                </div>
              </div>
            ) : mode === "login" ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <input
                    type="text"
                    placeholder={t("username")}
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <input
                    type="password"
                    placeholder={t("password")}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </div>
                {error && (
                  <p className="text-sm" style={{ color: "var(--destructive)" }}>
                    {error}
                  </p>
                )}
                <button type="submit" className="btn-primary w-full" disabled={loading}>
                  {loading ? "..." : t("login")}
                </button>
                <div className="text-right">
                  <button
                    type="button"
                    className="btn-plain text-sm"
                    style={{ color: "rgb(var(--primary))" }}
                    onClick={() => navigate("/forgot-password")}
                  >
                    {t("forgotPassword") || "忘记密码？"}
                  </button>
                </div>
                <div className="text-center">
                  <span style={{ color: "var(--text-50)" }}>{t("noAccount")} </span>
                  <button
                    type="button"
                    className="btn-plain text-sm"
                    style={{ color: "rgb(var(--primary))" }}
                    onClick={() => {
                      setMode("register");
                      setError("");
                    }}
                  >
                    {t("goRegister")}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                {!registrationId ? (
                  <>
                    <div>
                      <input
                        type="text"
                        placeholder={t("inviteCode")}
                        value={inviteCode}
                        onChange={(e) => setInviteCode(e.target.value)}
                        required
                      />
                    </div>
                    {error && (
                      <p className="text-sm" style={{ color: "var(--destructive)" }}>
                        {error}
                      </p>
                    )}
                    <button
                      type="button"
                      className="btn-primary w-full"
                      disabled={loading}
                      onClick={handleInviteLock}
                    >
                      {loading ? "..." : t("continue")}
                    </button>
                  </>
                ) : (
                  <>
                    <div>
                      <input
                        type="text"
                        placeholder={t("username")}
                        value={regUsername}
                        onChange={(e) => setRegUsername(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <input
                        type="email"
                        placeholder={t("email")}
                        value={regEmail}
                        onChange={(e) => setRegEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <input
                        type="password"
                        placeholder={t("password")}
                        value={regPassword}
                        onChange={(e) => setRegPassword(e.target.value)}
                        required
                      />
                    </div>
                    <div>
                      <input
                        type="password"
                        placeholder={t("confirmPassword")}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        required
                      />
                    </div>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        placeholder={t("emailCode")}
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value)}
                        className="flex-1"
                        required
                      />
                      <button
                        type="button"
                        className="btn-primary text-sm px-3 whitespace-nowrap"
                        disabled={emailCooldown > 0 || !regEmail.trim()}
                        onClick={handleSendEmailCode}
                      >
                        {emailCooldown > 0
                          ? `${emailCooldown}s`
                          : emailCodeSent
                          ? t("emailCodeSent")
                          : t("sendEmailCode")}
                      </button>
                    </div>
                    {error && (
                      <p className="text-sm" style={{ color: "var(--destructive)" }}>
                        {error}
                      </p>
                    )}
                    <button type="submit" className="btn-primary w-full" disabled={loading}>
                      {loading ? "..." : t("register")}
                    </button>
                  </>
                )}
                <div className="text-center">
                  <span style={{ color: "var(--text-50)" }}>{t("hasAccount")} </span>
                  <button
                    type="button"
                    className="btn-plain text-sm"
                    style={{ color: "rgb(var(--primary))" }}
                    onClick={() => {
                      setMode("login");
                      setError("");
                      setRegistrationId("");
                    }}
                  >
                    {t("goLogin")}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
