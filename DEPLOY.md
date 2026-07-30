# Пошаговый план запуска на боевом домене

Ниже — план для типовой схемы: один VPS (Ubuntu 22.04+), один домен (например,
`app.cyberlos.ru`), Nginx как reverse proxy перед бэкендом и раздатчик статики
фронтенда, Postgres вместо SQLite, HTTPS через Let's Encrypt, PM2 как менеджер
процесса Node. Это не единственный вариант (годятся и Docker, и PaaS-хостинги
вроде Render/Railway), но он прозрачный и подходит для старта с одним сервером.

Если у вас уже есть сервер/CI с другой схемой (Docker, Kubernetes, отдельный
хостинг для фронта) — шаги 3, 6 и 8 будут отличаться, остальное (переменные
окружения, Postgres, T-Банк, VAPID) актуально в любом случае.

**Рекомендуемая топология (один домен, без CORS-головной боли):**

```
https://app.cyberlos.ru/          → статика frontend/dist (Nginx)
https://app.cyberlos.ru/api/*     → проксируется на backend :4000
https://app.cyberlos.ru/uploads/* → проксируется на backend :4000
```

Всё на одном домене — значит `CORS_ORIGIN` и `VITE_API_BASE_URL` можно вообще не
трогать (см. README.md, раздел «Смена домена»): фронтенд как ходил на
относительный `/api`, так и продолжит, только теперь через Nginx на тот же порт
443, что и сама страница.

---

## 0. Что нужно подготовить заранее

- Домен, привязанный к IP сервера (A-запись в DNS)
- VPS с Ubuntu 22.04+ (2 ГБ RAM минимум), root/sudo-доступ
- Реквизиты Т-Банк Acquiring (TerminalKey/SecretKey) — если ещё не подключали,
  см. README.md, раздел «Оплата подписки дилера через Т-Банк»
- Домен уже наружу, т.к. Т-Банк и Web Push должны достучаться до вашего backend

## 1. Базовая настройка сервера

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx postgresql postgresql-contrib git ufw

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2 — держит backend живым, автоперезапуск при падении/ребуте
sudo npm install -g pm2

# Файрвол: только SSH + HTTP/HTTPS наружу
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 2. База данных: Postgres вместо SQLite

SQLite в этом прототипе — файл на диске бэкенда, что подходит только для
локальной разработки (нет параллельного доступа, теряется при переезде
контейнера/диска). Для прода — Postgres.

```bash
sudo -u postgres psql -c "CREATE USER cyberloss WITH PASSWORD 'придумайте-длинный-пароль';"
sudo -u postgres psql -c "CREATE DATABASE cyberloss OWNER cyberloss;"
```

Затем **на своей машине** (не обязательно на сервере) переключите схему на
Postgres и пересоздайте миграции — существующие миграции написаны под SQLite и
на Postgres не накатятся:

```bash
cd backend
```

В `prisma/schema.prisma` поменяйте:

```prisma
datasource db {
  provider = "postgresql"   // было "sqlite"
  url      = env("DATABASE_URL")
}
```

```bash
rm -rf prisma/migrations
# DATABASE_URL временно указывает на любую доступную вам Postgres (локальную/тестовую)
DATABASE_URL="postgresql://cyberloss:пароль@localhost:5432/cyberloss" \
  npx prisma migrate dev --name init
git add prisma/schema.prisma prisma/migrations
git commit -m "Переход на PostgreSQL для продакшена"
```

> Если хотите, я могу подготовить это переключение прямо сейчас — скажите, и
> сделаю миграции под Postgres в этой сессии.

## 3. Код на сервере

```bash
sudo mkdir -p /var/www/cyberloss
sudo chown $USER:$USER /var/www/cyberloss
cd /var/www/cyberloss
git clone <URL вашего репозитория> .
```

Если репозиторий пока не на GitHub/GitLab — `rsync -av --exclude node_modules --exclude .git ./ user@server:/var/www/cyberloss/` с локальной машины тоже подойдёт.

## 4. Переменные окружения бэкенда (прод)

```bash
cd /var/www/cyberloss/backend
cp .env .env.local.bak   # на всякий случай сохраните текущий dev-файл
```

Отредактируйте `backend/.env`:

```bash
DATABASE_URL="postgresql://cyberloss:пароль@localhost:5432/cyberloss"

# Обязательно замените на длинную случайную строку (например: openssl rand -hex 32)
JWT_SECRET="сгенерируйте-новый-секрет"

PORT=4000

APP_BASE_URL="https://app.cyberlos.ru"
BACKEND_PUBLIC_URL="https://app.cyberlos.ru"

# Один домен спереди — можно оставить пустым (см. топологию выше). Если фронт и
# бэкенд всё же на разных доменах — впишите домен фронтенда через запятую.
CORS_ORIGIN=""

TBANK_TERMINAL_KEY="ваш реальный TerminalKey"
TBANK_SECRET_KEY="ваш реальный SecretKey"
TBANK_API_URL="https://securepay.tinkoff.ru/v2"

# VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY трогать не нужно — backend/src/lib/push.ts
# сам сгенерирует пару при первом запуске и допишет в этот файл.
```

`openssl rand -hex 32` — быстрый способ сгенерировать `JWT_SECRET` на месте.

## 5. Сборка и запуск бэкенда

```bash
cd /var/www/cyberloss/backend
npm ci
npx prisma migrate deploy   # применяет уже готовые миграции, НЕ создаёт новые
npm run build               # tsc → dist/
npm run seed                 # опционально: создаёт admin@cyberlos.ru и демо-дилера
```

Запуск через PM2:

```bash
pm2 start dist/index.js --name cyberloss-backend
pm2 save
pm2 startup   # выведет команду — выполните её, чтобы PM2 поднимался при перезагрузке сервера
```

Проверка: `curl http://localhost:4000/health` → `{"ok":true}`.

## 6. Сборка фронтенда

```bash
cd /var/www/cyberloss/frontend
npm ci
npm run build   # → frontend/dist (статические файлы)
```

Фронтенд — статика, отдельный процесс не нужен, её отдаёт Nginx (следующий шаг).
При каждом обновлении кода — `npm run build` заново, файлы в `dist/` перезапишутся.

## 7. Nginx: домен, проксирование, SPA-роутинг

`sudo nano /etc/nginx/sites-available/cyberloss`:

```nginx
server {
    listen 80;
    server_name app.cyberlos.ru;

    root /var/www/cyberloss/frontend/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:4000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:4000/uploads/;
        proxy_set_header Host $host;
    }

    # SPA: неизвестные пути отдаём на index.html, React Router разберётся сам
    location / {
        try_files $uri /index.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/cyberloss /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Важный нюанс с этой топологией: `vite.config.ts` в деве проксирует `/api` на
бэкенд и **срезает** префикс (`rewrite: p => p.replace(/^\/api/, "")`) — Nginx
выше делает то же самое (`proxy_pass http://127.0.0.1:4000/` без `/api` на конце
означает «убрать /api/ и передать остаток»). Если поменяете префикс — синхронно
поправьте оба места.

## 8. HTTPS (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.cyberlos.ru
```

Certbot сам допишет `listen 443 ssl` в конфиг и настроит автопродление
сертификата. HTTPS обязателен не для галочки: без него не работают Service
Worker/PWA и Web Push (кроме localhost), и Т-Банк не будет доверять вебхуку.

## 9. Т-Банк: обновить адрес вебхука

В личном кабинете Т-Банк для терминала должен быть указан
`https://app.cyberlos.ru/api/billing/tbank/webhook` как NotificationURL — но это
уже передаётся из кода при каждом `Init` (см. `backend/src/routes/dealer.ts`,
использует `BACKEND_PUBLIC_URL` из `.env`), вручную в кабинете обычно указывать
не нужно — просто убедитесь, что `BACKEND_PUBLIC_URL` в `.env` (шаг 4) настоящий
и доступен извне: `curl https://app.cyberlos.ru/api/health` с любой другой
машины должен отвечать `{"ok":true}`.

## 10. Финальная проверка

- [ ] `https://app.cyberlos.ru` открывается, отдаёт фронтенд
- [ ] Регистрация клиента и вход работают
- [ ] Регистрация дилера → пробный период 14 дней отображается
- [ ] Загрузка фото/файла (паспорт, чат заявки) работает — значит `/uploads`
      проксируется верно
- [ ] Оплата подписки дилера уводит на реальную страницу Т-Банк (не заглушку —
      `devStub` в ответе `/api/dealer/subscription/checkout` должен быть `false`)
- [ ] Push: колокольчик в шапке → браузер спрашивает разрешение → уведомление
      реально приходит (проверьте на двух реальных браузерах/устройствах —
      автоматизированные тестовые браузеры разрешение на push не дают)
- [ ] `pm2 logs cyberloss-backend` — нет повторяющихся ошибок

## 11. Дальнейшая эксплуатация

- **Обновление кода:** `git pull`, затем повторить шаги 5 (без `seed`) и 6,
  `pm2 restart cyberloss-backend`, `sudo systemctl reload nginx` если менялся
  конфиг Nginx
- **Бэкапы БД:** `pg_dump cyberloss > backup-$(date +%F).sql` по расписанию (cron)
- **Логи:** `pm2 logs cyberloss-backend`, `sudo tail -f /var/log/nginx/error.log`
- **Файлы `backend/uploads`** — растут со временем (фото ТО, вложения чата,
  логотипы); либо следите за местом на диске, либо (что правильнее для
  масштабирования) вынесите их в объектное хранилище (S3-совместимое —
  Яндекс Object Storage/Selectel и т.п.) — потребует правки
  `backend/src/routes/uploads.ts`, в текущем прототипе не сделано
  (см. README.md, «Осознанные упрощения»)
- **Мониторинг:** как минимум `pm2` (`pm2 monit`) плюс любой внешний
  uptime-чекер (UptimeRobot и т.п.) на `/api/health`

---

Если что-то из этого хотите, чтобы я сделал прямо сейчас в коде (переключение
на Postgres, docker-compose как альтернатива, CI-пайплайн для автодеплоя по
`git push`) — скажите, какой пункт, и продолжим.
