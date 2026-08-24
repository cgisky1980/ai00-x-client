import React from "react";
import ReactDOM from "react-dom/client";
// design-system 全量样式走 JS 副作用导入（字体 url 走 Vite 资产管线——Step18 纪律）
import "@ai00-x/design-system/styles";
import App from "./App";
// registry 演示依赖的 preview 布局样式（demo 卡片）
import "./preview.css";
import "./docs.scss";

// 主题预置（tokens.css :root 默认暗色；入口先同步 data-theme-type，防首帧闪烁）
{
  const saved = localStorage.getItem("ai00-ui-theme");
  const theme =
    saved === "light" || saved === "dark"
      ? saved
      : window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.themeType = theme;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
