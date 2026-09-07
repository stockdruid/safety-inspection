@echo off
title 안전보건 순회점검 서버
cd /d "%~dp0"

echo.
echo   안전보건 순회점검 서버를 시작합니다...
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [설치 필요] 이 컴퓨터에 Node.js 가 설치되어 있지 않습니다.
    echo.
    echo   잠시 후 다운로드 페이지가 열립니다.
    echo   "LTS" 라고 적힌 버튼을 눌러 설치한 뒤,
    echo   이 파일을 다시 실행해 주세요.
    echo.
    timeout /t 5 > nul
    start "" https://nodejs.org/ko/download
    echo   아무 키나 누르면 창이 닫힙니다.
    pause > nul
    exit /b 1
)

set OPEN_BROWSER=1
node server.mjs

echo.
echo   서버가 종료되었습니다. 아무 키나 누르면 창이 닫힙니다.
pause > nul
