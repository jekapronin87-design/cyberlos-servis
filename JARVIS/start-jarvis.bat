@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js не найден. Установите LTS с https://nodejs.org и запустите снова. & pause & exit /b 1)
if not exist node_modules (
  echo Первая установка зависимостей, это займёт несколько минут...
  call npm install || (echo Ошибка установки & pause & exit /b 1)
)
call npm start
