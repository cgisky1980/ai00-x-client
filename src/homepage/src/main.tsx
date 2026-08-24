import React from "react";
import { createRoot } from "react-dom/client";
// design-system 全量样式走 JS 副作用导入（字体 url 走 Vite 资产管线——Step18 纪律）
import "@ai00-x/design-system/styles";
import App from "./App";
import "./home.scss";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
