@echo off
rem 启动客户端 —— 连接【正式服务器】(https://app.ai00-x.com / 新机 103.143.231.160)
rem 无参数默认即正式服；此脚本显式传 --server=prod 语义相同
setlocal
set "EXE_DIR=%~dp0..\target\release"
if not exist "%EXE_DIR%\ai00-x-desktop.exe" (
  echo [错误] 未找到 %EXE_DIR%\ai00-x-desktop.exe
  echo 请先执行: cargo build --release -p ai00-x-desktop
  pause
  exit /b 1
)
cd /d "%EXE_DIR%"
start "" "ai00-x-desktop.exe" --server=prod
endlocal
