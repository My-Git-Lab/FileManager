@echo off
cd /d "%~dp0"
title 本地文件管理器

echo ==========================================
echo    本地文件管理器
echo ==========================================
echo.

REM ---- 关键：防止被当成普通 Node 启动 ----
REM 若父进程（某些 IDE/终端）带着 ELECTRON_RUN_AS_NODE=1 或 NODE_OPTIONS，
REM Electron 会以纯 Node 模式跑，require('electron') 拿到的是路径字符串，
REM 于是报 "Cannot read properties of undefined (reading 'handle')"。
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

set "ELEXE=%~dp0node_modules\electron\dist\electron.exe"

REM ---- 依赖已就绪：直接启动，这一步完全不需要 Node.js ----
if exist "%ELEXE%" goto :run

echo [首次运行] 需要安装依赖并下载 Electron（约 100MB，需联网）。
echo            期间可能长时间无输出，属正常现象，请勿关闭窗口。
echo            若长时间没反应，多半是网络慢，可换手机热点再试。
echo.

REM ---- 只有下面安装依赖这一步才需要 node / npm ----
where node >nul 2>nul
if not errorlevel 1 goto :install

REM 系统 PATH 里没有，就到常见安装位置找一遍
for %%D in (
  "%ProgramFiles%\nodejs"
  "%ProgramFiles(x86)%\nodejs"
  "%LOCALAPPDATA%\Programs\nodejs"
  "%APPDATA%\nvm"
  "%USERPROFILE%\.nvm"
  "%USERPROFILE%\AppData\Roaming\fnm"
) do (
  if exist "%%~D\node.exe" (
    set "PATH=%%~D;%PATH%"
    goto :install
  )
)

REM 某些工具自带的 Node（版本号目录，逐个试）
for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if exist "%%~D\node.exe" (
    set "PATH=%%~D;%PATH%"
    goto :install
  )
)

goto :nonode

:install
call npm install --registry=https://registry.npmmirror.com
if errorlevel 1 goto :fail

REM Electron 二进制有时不会随 npm install 落地（网络/镜像抖动），补一次
if not exist "%ELEXE%" (
  echo [补充下载] Electron 运行包未就绪，正在重新下载...
  call node node_modules\electron\install.js
  if errorlevel 1 goto :fail
)

:run
if not exist "%ELEXE%" goto :fail
echo [启动中] 正在打开程序...
call "%ELEXE%" . --no-sandbox
if errorlevel 1 goto :fail
goto :end

:nonode
echo.
echo ==========================================
echo 未检测到 Node.js。
echo   说明：只有"首次安装依赖"才需要它；
echo        依赖装好后，日常双击本文件不再需要 Node.js。
echo.
echo   请到 https://nodejs.org/zh-cn/download
echo   下载安装 18 或更高版本（安装时一路"下一步"），
echo   装完后重新双击本文件。
echo ==========================================
pause
exit /b 1

:fail
echo.
echo ==========================================
echo 启动失败，常见原因：
echo   1. 网络不通
echo      首次运行需要联网下载 Electron（约 100MB）。
echo      可尝试手机热点，或稍后重试。
echo   2. 杀毒软件拦截
echo      360/火绒可能拦截 Electron，允许放行后重试。
echo   3. 依赖损坏
echo      可删除本目录下的 node_modules 文件夹后重新双击本文件。
echo ==========================================
pause
exit /b 1

:end
