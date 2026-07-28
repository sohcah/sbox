@echo off
setlocal

call pnpm build >nul
if errorlevel 1 exit /b %errorlevel%
node "%~dp0packages\sbox\dist\cli.js" %*
