@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   凡尘·需求台 -- 启动
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node

if not exist "node_modules\vite\bin\vite.js" goto no_deps

echo 启动中，请稍候……
echo 启动完成后，浏览器打开： http://127.0.0.1:5173
echo 按 Ctrl+C 可以停止。
echo.
call npm run dev
echo.
echo 服务已停止。
pause
exit /b 0

:no_node
echo [x] 没找到 node 命令。
echo     请先安装 Node.js 20 或更高版本： https://nodejs.org/
echo.
pause
exit /b 1

:no_deps
echo [!] 依赖还没有安装。请在当前目录执行下面任意一条：
echo.
echo     有 pnpm ： pnpm install
echo     没 pnpm ： npm install
echo.
pause
exit /b 1
