import React from "react";
import ReactDOM from "react-dom/client";
// design-system 全量樣式走 JS 副作用導入（字體 url 走 Vite 資產管線——Step18 紀律）
import "@ai00-x/design-system/styles";
import App from "./App";
import "./app.scss";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
