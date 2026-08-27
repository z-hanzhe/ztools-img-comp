@echo off
setlocal
cd /d "%~dp0"

REM 构建 img-comp ZTools 插件。
REM 输出 dist\img-comp.zpx 和供检查使用的 dist\img-comp.asar。

call node build-zpx.js
if errorlevel 1 exit /b 1

endlocal
