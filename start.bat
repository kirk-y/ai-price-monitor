@echo off
chcp 65001 >nul
title AI价格监控
cd /d "%~dp0"

:: 加载 .env 配置
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        if not "%%b"=="" set "%%a=%%b"
    )
)

echo 正在启动AI价格监控...
echo.
if not exist "node_modules\" (
    echo 尚未安装依赖，请先运行 setup.bat
    pause
    exit /b 1
)
if not exist "data\" mkdir data

if "%PORT%"=="" set "PORT=3000"
if "%HOST%"=="" set "HOST=127.0.0.1"

echo 端口: %PORT%
echo 监听地址: %HOST%
if not "%AUTH_TOKEN%"=="" (
    echo 认证: 已启用
) else (
    echo 认证: 未启用
)
echo.
echo 服务启动后请访问 http://%HOST%:%PORT%
echo 关闭此窗口不会影响服务运行。
echo.
start "AI价格监控" node server.js
echo 服务已在后台启动。
