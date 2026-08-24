/**
 * Ai00-UI 组件文档站
 * 结构（antd/shadcn 文档范式）：顶栏（灵印 lockup + 组件搜索 + 主题切换 + GitHub）
 * + 分组侧边栏 + 单组件文档页（演示 / 何时使用 / API 表 / 代码示例）。
 * 路由：hash（#/overview | #/g/{groupId}/{componentId}）。
 */
import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "@ai00-x/design-system/react";
import { Search, ToastProvider } from "@ai00-x/design-system/web";
import { DOC_GROUPS } from "./docData";
import type { ComponentDoc } from "./docData";
import { DEMO_MAP, NoDemo } from "./demos";
import { DesignShowcase } from "./DesignShowcase";
import "./docs.scss";

type ThemeId = "light" | "dark";

const GITHUB = "https://github.com/cgisky1980/ai00-ui";

function resolveInitialTheme(): ThemeId {
  const saved = localStorage.getItem("ai00-ui-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/* hash 路由解析 */
function parseHash(): { group?: string; comp?: string } {
  const m = /^#\/g\/([\w-]+)\/([\w-]+)/.exec(location.hash);
  return m ? { group: m[1], comp: m[2] } : {};
}

export default function App() {
  const [theme, setTheme] = useState<ThemeId>(resolveInitialTheme);
  const [query, setQuery] = useState("");
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const applyTheme = (next: ThemeId) => {
    setTheme(next);
    document.documentElement.dataset.themeType = next;
    localStorage.setItem("ai00-ui-theme", next);
  };
  if (document.documentElement.dataset.themeType !== theme) {
    document.documentElement.dataset.themeType = theme;
  }

  /* 当前组件文档（含所在组） */
  const current = useMemo(() => {
    if (!route.comp) return null;
    for (const g of DOC_GROUPS) {
      const c = g.components.find((x) => x.id === route.comp);
      if (c) return { group: g, doc: c };
    }
    return null;
  }, [route.comp]);

  /* 搜索过滤侧边栏 */
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DOC_GROUPS;
    return DOC_GROUPS.map((g) => ({
      ...g,
      components: g.components.filter(
        (c) =>
          c.title.toLowerCase().includes(q) ||
          c.en.toLowerCase().includes(q) ||
          c.desc.toLowerCase().includes(q)
      ),
    })).filter((g) => g.components.length > 0);
  }, [query]);

  const navigate = (group: string, comp: string) => {
    location.hash = `#/g/${group}/${comp}`;
  };
  void navigate;

  return (
    <>
      <ToastProvider />
      <div className="uikit">
        {/* ---------- 顶栏 ---------- */}
        <header className="uikit-header">
          <a className="uikit-brand" href="#/overview" aria-label="Ai00-UI 首页">
            <BrandMark variant="seal" size={30} />
            <span className="uikit-brand__text">
              <span className="uikit-brand__name">Ai00-UI</span>
              <span className="uikit-brand__sub">设计系统 · 组件文档</span>
            </span>
          </a>
          <div className="uikit-header__actions">
            <div className="uikit-theme-switch" role="radiogroup" aria-label="主题">
              {([["light", "宣纸"], ["dark", "松烟墨"]] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={theme === id}
                  className={`uikit-theme-switch__btn ${theme === id ? "is-active" : ""}`}
                  onClick={() => applyTheme(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <a className="uikit-gh" href={GITHUB} target="_blank" rel="noopener noreferrer">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
              </svg>
              GitHub
            </a>
          </div>
        </header>

        <div className="uikit-body">
          {/* ---------- 侧边栏 ---------- */}
          <aside className="uikit-sider">
            <div className="uikit-sider__search">
              <Search
                placeholder="搜索组件…"
                value={query}
                onChange={(v) => setQuery(typeof v === "string" ? v : (v as any)?.target?.value ?? "")}
                onClear={() => setQuery("")}
                clearable
              />
            </div>
            <nav>
              <a
                href="#/overview"
                className={`uikit-sider__item uikit-sider__item--top ${!route.comp ? "is-active" : ""}`}
              >
                设计语言总览
              </a>
              {filteredGroups.map((g) => (
                <div key={g.id} className="uikit-sider__group">
                  <div className="uikit-sider__group-title">{g.title}</div>
                  {g.components.map((c) => (
                    <a
                      key={c.id}
                      href={`#/g/${g.id}/${c.id}`}
                      className={`uikit-sider__item ${route.comp === c.id ? "is-active" : ""}`}
                    >
                      {c.title}
                    </a>
                  ))}
                </div>
              ))}
            </nav>
          </aside>

          {/* ---------- 内容区 ---------- */}
          <main className="uikit-content">
            {current ? (
              <DocPage group={current.group.title} doc={current.doc} />
            ) : (
              <Overview />
            )}
          </main>
        </div>
      </div>
    </>
  );
}

/* ---------- 总览（设计语言长卷，自带门面 hero） ---------- */
const Overview = () => <DesignShowcase />;

/* ---------- 单组件文档页 ---------- */
const DocPage = ({ group, doc }: { group: string; doc: ComponentDoc }) => {
  const demos = DEMO_MAP[doc.id] ?? [];
  return (
    <article className="uikit-doc">
      <nav className="uikit-doc__crumb">{group}</nav>
      <h1>
        {doc.title} <span className="uikit-doc__en">{doc.en}</span>
      </h1>
      <p className="uikit-doc__desc">{doc.desc}</p>

      {demos.length > 0 ? (
        <section className="uikit-doc__section">
          <h2>演示</h2>
          <div className="uikit-demo-card">
            {demos.map((D, i) => (
              <div key={i} className="uikit-demo-card__item">
                <D />
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="uikit-doc__section">
          <h2>演示</h2>
          <div className="uikit-demo-card"><NoDemo /></div>
        </section>
      )}

      {doc.usage && doc.usage.length > 0 && (
        <section className="uikit-doc__section">
          <h2>何时使用</h2>
          <ul className="uikit-doc__usage">
            {doc.usage.map((u, i) => <li key={i}>{u}</li>)}
          </ul>
        </section>
      )}

      {doc.api && doc.api.length > 0 && (
        <section className="uikit-doc__section">
          <h2>API</h2>
          <table className="uikit-api-table">
            <thead>
              <tr><th>参数</th><th>说明</th><th>类型</th><th>默认值</th></tr>
            </thead>
            <tbody>
              {doc.api.map((r) => (
                <tr key={r.param}>
                  <td className="uikit-api-table__param">{r.param}</td>
                  <td>{r.desc}{r.required && <em className="uikit-api-table__req"> 必填</em>}</td>
                  <td className="uikit-api-table__type">{r.type}</td>
                  <td>{r.default ?? (r.required ? "—" : "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="uikit-doc__section">
        <h2>使用示例</h2>
        <CodeBlock code={doc.code} />
      </section>
    </article>
  );
};

/* ---------- 代码块（复制按钮） ---------- */
const CodeBlock = ({ code }: { code: string }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="uikit-code ds-hover-glow">
      <button type="button" className="uikit-code__copy" onClick={() => void copy()}>
        {copied ? "已复制" : "复制"}
      </button>
      <pre><code>{code}</code></pre>
    </div>
  );
};
