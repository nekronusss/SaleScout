# Вход через Google и Apple

Интеграция работает на сервере: браузер получает только адрес авторизации. Ключи остаются в `.env`, который исключён из Git. Без ключей кнопка соответствующего провайдера отключена; регистрация по почте продолжает работать. Заполняйте все переменные выбранного провайдера: неполная конфигурация останавливает запуск с понятной ошибкой.

## Google

1. В [Google Cloud Console](https://console.cloud.google.com/) создайте проект и настройте Google Auth Platform: название, контактную почту, аудиторию и необходимые сведения о приложении.
2. Создайте OAuth client типа **Web application**.
3. Добавьте точный **Authorized redirect URI**:
   - Vite: `http://localhost:5173/api/auth/oauth/google/callback`.
   - Локальный Docker: `http://localhost:3001/api/auth/oauth/google/callback` (либо порт `APP_PORT`).
   - Публичный сайт: `https://ваш-домен/api/auth/oauth/google/callback`.
4. В `.env` задайте `GOOGLE_CLIENT_ID` и `GOOGLE_CLIENT_SECRET`.
5. В режиме Testing добавьте свои адреса в Test users. Перед публичным запуском настройте production audience и выполните требования консоли к публикации приложения.

Используются только `openid email profile`. Доступ к Gmail, Drive и другим данным не запрашивается. Сервер использует authorization code flow с PKCE S256, state и nonce. [Документация Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

## Apple

Нужен аккаунт Apple Developer с возможностью настроить Sign in with Apple для вашего приложения, App ID с этой возможностью и связанный **Services ID** для веб-сайта. `localhost` и HTTP для Apple не подходят: используйте собственный тестовый HTTPS-домен или публичное окружение.

1. В [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) настройте App ID с Sign in with Apple и Services ID; выберите связанный primary App ID.
2. В конфигурации Services ID укажите домен сайта и Return URL: `https://ваш-домен/api/auth/oauth/apple/callback`.
3. Создайте ключ с возможностью Sign in with Apple, выберите соответствующий primary App ID и скачайте `.p8`.
4. Заполните `.env`:

```dotenv
APPLE_CLIENT_ID=ваш.Services.ID
APPLE_TEAM_ID=ваш.Team.ID
APPLE_KEY_ID=ваш.Key.ID
APPLE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nСОДЕРЖИМОЕ_ВАШЕГО_P8\n-----END PRIVATE KEY-----'
```

`\n` в примере — буквальные обратная косая черта и n. Сервер превращает их в переводы строк. Храните значение в одинарных кавычках, чтобы Docker Compose не обрабатывал переносы; не включайте файл `.p8` в Git. Сервер создаёт короткоживущий ES256 client secret сам, готовый JWT вручную обновлять не требуется. При отзыве ключа замените `.env` и перезапустите приложение.

Вне production Compose также задайте `APP_ORIGIN=https://ваш-домен`. Apple использует `response_mode=form_post`. Обратный POST сохраняет код на время до 10 минут и перенаправляет браузер на GET, который проверяет исходную сессию; SameSite=Lax основной cookie сохраняется. Код одноразовый и удаляется при завершении входа. Истёкшие записи удаляет обслуживание БД.

Запрашивается только email. Для имени аккаунта используется часть подтверждённой почты до `@`; неподписанные данные формы Apple не принимаются как доказательство личности. При Hide My Email пользователь получит адрес Apple relay. Для писем восстановления настройте отправителя в Apple Private Email Relay и проверьте доставку на скрытый адрес.

Официальные источники: [Sign in with Apple REST API](https://developer.apple.com/documentation/signinwithapplerestapi), [настройка для других платформ](https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms).

## Применение настроек и проверка

После изменения `.env` перезапустите dev-сервер или пересоздайте контейнер приложения:

```sh
docker compose up -d --build app
# Для публичного окружения:
docker compose -f compose.prod.yaml up -d --build app
```

Используйте тот же hostname, что указан в `APP_ORIGIN`, в течение всего входа. Не начинайте на `127.0.0.1`, если callback зарегистрирован на `localhost`: браузерная cookie привязана к имени хоста.

Проверьте новый аккаунт, повторный вход с сохранением каталога, отмену входа, привязку из кабинета и Apple Hide My Email. Callback URL должен совпадать посимвольно с настройками провайдера и не перенаправляться внешним прокси на другой домен.

Если адрес уже зарегистрирован, сначала войдите по паролю (при необходимости восстановите его), откройте «Аккаунт и данные → Способы входа» и подключите Google или Apple. Автоматического объединения по email нет. Одна идентичность провайдера принадлежит только одному аккаунту. Для OAuth-аккаунта без пароля в этом разделе есть «Установить пароль по почте»; пароль понадобится для удаления аккаунта. Удаление аккаунта удаляет локальную привязку; разрешения приложения у Google/Apple пользователь может отозвать в настройках провайдера.

Автоматические тесты проверяют подписи и claims JWT локальными тестовыми ключами, одноразовость callback, привязку к браузеру, Apple POST→GET, повторный вход и защиту от захвата аккаунта. **Реальный вход в Google/Apple требует ваших ключей и проверки на зарегистрированном домене; локальные тесты не подтверждают настройку внешних кабинетов.**
