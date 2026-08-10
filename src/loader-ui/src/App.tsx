import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider, AuthGuard, GuestGuard } from "@/components/AuthProvider";
import { I18nProvider } from "@/lib/i18n";
import { LoginPage } from "@/pages/Login";
import { ForgotPasswordPage } from "@/pages/ForgotPassword";
import { HomePage } from "@/pages/Home";

function App() {
  return (
    <BrowserRouter>
      <I18nProvider>
        <AuthProvider>
          <Routes>
            <Route
              path="/login"
              element={
                <GuestGuard>
                  <LoginPage />
                </GuestGuard>
              }
            />
            {/* 忘记密码：公开路由，无需鉴权 */}
            <Route
              path="/forgot-password"
              element={<ForgotPasswordPage />}
            />
            <Route
              path="/"
              element={
                <AuthGuard>
                  <HomePage />
                </AuthGuard>
              }
            />
          </Routes>
        </AuthProvider>
      </I18nProvider>
    </BrowserRouter>
  );
}

export default App;
