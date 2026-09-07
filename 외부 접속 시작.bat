@echo off
title 안전보건 순회점검 - 외부 접속
cd /d "%~dp0"

echo.
echo   ====================================================
echo    외부(다른 네트워크) 접속용 주소를 만듭니다.
echo   ====================================================
echo.
echo   이 기능을 켜면 회사 밖에서도 인터넷만 되면 접속할 수 있습니다.
echo   접속하려면 비밀번호가 필요하며, 비밀번호는 검은 창에 표시됩니다.
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [설치 필요] Node.js 가 설치되어 있지 않습니다.
    echo   먼저 "서버 시작" 파일을 실행해 안내를 따라 주세요.
    echo.
    pause > nul
    exit /b 1
)

set "CF=cloudflared.exe"
where cloudflared >nul 2>nul
if not errorlevel 1 set "CF=cloudflared"

if "%CF%"=="cloudflared.exe" if not exist "cloudflared.exe" (
    echo   외부 접속에 필요한 프로그램(cloudflared.exe)이 없습니다.
    echo.
    echo   내려받을 곳 : github.com/cloudflare/cloudflared  (Cloudflare 공식 배포처)
    echo   크기        : 약 70MB
    echo.
    echo   내려받으려면 아무 키나 누르세요. 원하지 않으면 이 창을 닫으세요.
    pause > nul
    echo.
    echo   내려받는 중입니다. 1~2분 정도 걸립니다...
    curl -L -o "cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
    if errorlevel 1 (
        echo.
        echo   [실패] 내려받지 못했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.
        pause > nul
        exit /b 1
    )
    echo   완료되었습니다.
    echo.
)

echo   점검 서버를 켭니다. (새 창이 하나 더 열립니다)
start "안전보건 순회점검 서버" cmd /c "node server.mjs & pause"

echo   서버가 준비될 때까지 잠시 기다립니다...
timeout /t 4 > nul

echo.
echo   ----------------------------------------------------
echo    아래에 나오는 https://... 로 시작하는 주소를
echo    휴대폰이나 다른 컴퓨터에 입력하면 접속됩니다.
echo   ----------------------------------------------------
echo.

%CF% tunnel --url http://localhost:5180

echo.
echo   외부 접속이 종료되었습니다. 아무 키나 누르면 창이 닫힙니다.
pause > nul
