@echo off
chcp 65001 >nul
title AI价格监控
echo 正在启动AI价格监控...
echo.
echo 首次使用请先运行: npm install
echo.
if not exist "node_modules\" (
    echo 正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo 依赖安装失败，请运行 npm install 查看错误
        pause
        exit /b 1
    )
    echo 依赖安装完成。
)
node server.js
if errorlevel 1 (
    echo.
    echo 启动失败，请检查端口 3000 是否被占用
    pause
)
