@echo off
chcp 65001 >nul
title AI价格监控 - 安装向导
cd /d "%~dp0"

echo ============================================
echo    AI价格监控 - 一键安装
echo ============================================
echo.

:: 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=2 delims=." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 22 (
    echo [错误] Node.js 版本过低 (当前: %NODE_MAJOR%)，请安装 v22+
    pause
    exit /b 1
)
echo [OK] Node.js %NODE_MAJOR%.x

:: 检查数据目录
if not exist "data\" (
    mkdir data
    echo [OK] 已创建 data/ 目录
)

:: 安装依赖
if not exist "node_modules\" (
    echo 正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
    echo [OK] 依赖安装完成
) else (
    echo [OK] 依赖已安装
)

:: 配置环境变量
set "CONFIG_FILE=.env"
if exist "%CONFIG_FILE%" (
    echo [OK] 配置文件已存在
) else (
    echo.
    echo ===== 首次配置 =====
    echo.
    
    set /p "INPUT_TOKEN=设置访问令牌 (留空则不启用认证): "
    if not "%INPUT_TOKEN%"=="" (
        echo AUTH_TOKEN=%INPUT_TOKEN%> "%CONFIG_FILE%"
        echo [OK] 访问令牌已设置
    ) else (
        echo.> "%CONFIG_FILE%"
        echo [提示] 未设置访问令牌，建议在公网使用时设置
    )
    
    set /p "INPUT_PORT=设置端口号 (默认 3000): "
    if "%INPUT_PORT%"=="" set INPUT_PORT=3000
    echo PORT=%INPUT_PORT%>> "%CONFIG_FILE%"
    echo HOST=127.0.0.1>> "%CONFIG_FILE%"
    echo [OK] 端口已设置为 %INPUT_PORT%
)

echo.
echo ============================================
echo  安装完成！运行 start.bat 启动服务
echo ============================================
pause
