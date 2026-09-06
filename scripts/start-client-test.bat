@echo off
rem 启动客户端 —— 连接【测试服务器】(https://ai00-x.com / 老机 101.132.79.234)
rem --server=test 仅覆盖本次进程内存，不写回配置文件
setlocal
set "EXE_DIR=%~dp0..\target\release"
if not exist "%EXE_DIR%\ai00-x-desktop.exe" (
  echo [错误] 未找到 %EXE_DIR%\ai00-x-desktop.exe
  echo 请先执行: cargo build --release -p ai00-x-desktop
  pause
  exit /b 1
)
cd /d "%EXE_DIR%"
start "" "ai00-x-desktop.exe" --server=test
endlocal
