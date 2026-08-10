import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import i18next from "i18next";
import { initReactI18next, useTranslation, I18nextProvider } from "react-i18next";
import en from "./locales/en.json";
import zh from "./locales/zh.json";
import { storage } from "../storage";

type Locale = "en" | "zh";

const LOCALE_KEY = "ai00-x-locale";

// 统一使用 react-i18next（与 web-ui 保持一致）。保留扁平 key 结构，作为默认 translation 命名空间。
const i18nInstance = i18next.createInstance();
void i18nInstance.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: "zh",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
  returnNull: false,
  initImmediate: false,
});

interface I18nContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nContextType>({
  locale: "zh",
  setLocale: () => {},
});

/**
 * 保持与旧实现一致的 API：{ t, locale, setLocale }
 * t 来自 react-i18next 的 useTranslation，locale/setLocale 来自内部 context。
 */
export function useI18n() {
  const { t } = useTranslation();
  const { locale, setLocale } = useContext(I18nContext);
  return { t, locale, setLocale };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={i18nInstance}>
      <I18nProviderInner>{children}</I18nProviderInner>
    </I18nextProvider>
  );
}

function I18nProviderInner({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const locale: Locale = i18n.language.startsWith("zh") ? "zh" : "en";

  // 启动时异步从 Rust KV 存储加载持久化的 locale
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const stored = await storage.get(LOCALE_KEY);
        if (!cancelled && (stored === "en" || stored === "zh")) {
          void i18n.changeLanguage(stored);
        }
      } catch (e) {
        console.warn("[i18n] load locale from storage failed:", e);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [i18n]);

  const setLocale = (newLocale: Locale) => {
    void i18n.changeLanguage(newLocale);
    void storage.set(LOCALE_KEY, newLocale).catch((e) => {
      console.warn("[i18n] persist locale failed:", e);
    });
  };

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}