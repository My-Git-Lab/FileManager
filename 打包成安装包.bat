@echo off
cd /d "%~dp0"
title 打包成 Windows 安装包

echo ==========================================
echo    打包成 Windows 安装包（.exe）
echo ==========================================
echo.

set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

REM ---- 打包必须用到 node / npm，先找出来 ----
where node >nul 2>nul
if not errorlevel 1 goto :hasnode

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
    goto :hasnode
  )
)

for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if exist "%%~D\node.exe" (
    set "PATH=%%~D;%PATH%"
    goto :hasnode
  )
)

echo.
echo ==========================================
echo 未检测到 Node.js。打包需要它（运行程序本身不需要）。
echo   请到 https://nodejs.org/zh-cn/download
echo   下载安装 18 或更高版本，安装时一路"下一步"，
echo   装完后重新双击本文件。
echo ==========================================
pause
exit /b 1

:hasnode
if not exist "node_modules\electron\dist\electron.exe" (
  echo 正在安装依赖（Electron + electron-builder），需要联网，约 3-10 分钟...
  call npm install --registry=https://registry.npmmirror.com
  if errorlevel 1 goto :fail
)

echo 正在打包，这一步比较慢，大约 3-10 分钟，请耐心等待...
call node_modules\.bin\electron-builder.cmd --win
if errorlevel 1 goto :fail

echo.
echo 打包完成！安装包在本目录下的 release 文件夹里，
echo 文件名类似 LocalFileManager-<版本号>-setup.exe
echo 双击安装后即可使用，以后不再需要 Node.js。
echo.
if exist "release" start "" "release"
pause
exit /b 0

:fail
echo.
echo ==========================================
echo 打包失败。常见原因：
echo   1. 网络不通（需要下载 Electron 与打包工具，约 200MB）
echo   2. 杀毒软件拦截
echo   3. 依赖损坏 —— 可删除 node_modules 文件夹后重试
echo ==========================================
pause
exit /b 1
