import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { authApi } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Step = "identifier" | "reset" | "success";

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const { t, locale, setLocale } = useI18n();

  const [step, setStep] = useState<Step>("identifier");
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [emailMasked, setEmailMasked] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // 冷却倒计时
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim()) {
      setError(t("forgotPasswordIdentifierRequired") || "请输入用户名或邮箱");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const result = await authApi.forgotPasswordSendCode(identifier);
      setEmailMasked(result.email_masked);
      setStep("reset");
      setCooldown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send code failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (cooldown > 0 || !identifier.trim()) return;
    setError("");
    try {
      const result = await authApi.forgotPasswordSendCode(identifier);
      setEmailMasked(result.email_masked);
      setCooldown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Resend failed");
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError(t("passwordMismatch"));
      return;
    }
    if (newPassword.length < 8) {
      setError(t("forgotPasswordTooShort") || "密码至少 8 个字符");
      return;
    }
    setLoading(true);
    try {
      await authApi.forgotPasswordReset({
        identifier,
        code,
        new_password: newPassword,
      });
      setStep("success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  };

  const handleBackToLogin = () => {
    navigate("/login");
  };

  // 构建步骤 2 描述（手动替换占位符，loader-ui t() 不支持插值）
  const step2Desc = (() => {
    const template =
      t("forgotPasswordStep2Desc") ||
      "验证码已发送至 {{email}}，请查收";
    return template.replace("{{email}}", emailMasked || "");
  })();

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
                {t("forgotPasswordTitle") || "重置密码"}
              </h1>
            </div>

            {step === "identifier" ? (
              <form onSubmit={handleSendCode} className="space-y-4">
                <p className="text-sm text-center" style={{ color: "var(--text-50)" }}>
                  {t("forgotPasswordStep1Desc") ||
                    "输入用户名或邮箱，我们将发送验证码到绑定邮箱"}
                </p>
                <div>
                  <input
                    type="text"
                    placeholder={t("forgotPasswordIdentifier") || "用户名或邮箱"}
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                  />
                </div>
                {error && (
                  <p className="text-sm" style={{ color: "var(--destructive)" }}>
                    {error}
                  </p>
                )}
                <button type="submit" className="btn-primary w-full" disabled={loading}>
                  {loading ? "..." : t("sendCode") || "发送验证码"}
                </button>
                <div className="text-center">
                  <button
                    type="button"
                    className="btn-plain text-sm"
                    style={{ color: "rgb(var(--primary))" }}
                    onClick={handleBackToLogin}
                  >
                    {t("backToLogin") || "返回登录"}
                  </button>
                </div>
              </form>
            ) : step === "reset" ? (
              <form onSubmit={handleReset} className="space-y-4">
                <p className="text-sm text-center" style={{ color: "var(--text-50)" }}>
                  {step2Desc}
                </p>
                <div>
                  <input
                    type="text"
                    placeholder={t("emailCode") || "邮箱验证码"}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                </div>
                <div className="flex gap-2">
                  <input
                    type="password"
                    placeholder={t("newPassword") || "新密码"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="flex-1"
                    required
                  />
                  <button
                    type="button"
                    className="btn-primary text-sm px-3 whitespace-nowrap"
                    disabled={cooldown > 0}
                    onClick={handleResendCode}
                  >
                    {cooldown > 0
                      ? `${cooldown}s`
                      : t("resend") || "重新发送"}
                  </button>
                </div>
                <div>
                  <input
                    type="password"
                    placeholder={t("confirmNewPassword") || "确认新密码"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                </div>
                {error && (
                  <p className="text-sm" style={{ color: "var(--destructive)" }}>
                    {error}
                  </p>
                )}
                <button type="submit" className="btn-primary w-full" disabled={loading}>
                  {loading ? "..." : t("resetPassword") || "重置密码"}
                </button>
                <div className="text-center">
                  <button
                    type="button"
                    className="btn-plain text-sm"
                    style={{ color: "rgb(var(--primary))" }}
                    onClick={handleBackToLogin}
                  >
                    {t("backToLogin") || "返回登录"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="text-center space-y-5">
                <div className="text-2xl font-light mb-4" style={{ color: "var(--text-90)" }}>
                  {t("passwordReset") || "密码已重置"}
                </div>
                <p className="text-sm" style={{ color: "var(--text-50)" }}>
                  {t("passwordResetSuccess") ||
                    "密码已成功重置，请使用新密码登录"}
                </p>
                <button className="btn-primary w-full" onClick={handleBackToLogin}>
                  {t("backToLogin") || "返回登录"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
