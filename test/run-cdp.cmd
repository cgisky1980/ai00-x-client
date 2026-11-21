@echo off
rem 启动 Ai00-X 客户端并打开 WebView2 远程调试端口（供 test/cdp-drive.mjs 使用）
rem 端口用 9223：9222 常被其它 WebView2 应用（输入法等）占用，WebView2 绑定失败会静默跳过调试端口。
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
start "" "c:\work\ai00-x-dev\client\target\release\ai00-x-desktop.exe"
