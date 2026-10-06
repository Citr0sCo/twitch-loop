# Twitch Loop

<p align="center"><strong>Live priorities. Automatic fallbacks. Keep watching.</strong></p>

A self-hosted Twitch player with an always-on ordered list of preferred streams and automatic live-channel fallbacks. Twitch Loop uses the official Twitch embedded player and keeps one browser player instance while the backend checks stream status every minute.

> Twitch Loop is independent open-source software and is not affiliated with Twitch.

## Features

- One always-on ordered list of Twitch channels, evaluated once per minute.
- Automatic priority handoff to the first live configured channel, then any followed streamer, then any live Twitch streamer.
- Followed-channel selection plus manual Twitch login entry; unknown upstream state never becomes offline.
- Independent browser playback sessions with start, stop, auto-pause, manual selection and reset controls.
- Official Twitch player SDK integration, theatre mode, best-effort native fullscreen and Screen Wake Lock.
- SQLite persistence under `/data`, protected ASP.NET data-protection keys, health checks and a single-container deployment.

## Quick start with Docker Compose

1. Register a Twitch application at the Twitch developer console. Use an exact callback such as `https://twitch-loop.example.com/api/auth/twitch/callback`.
2. Copy `.env.example` to `.env`, then set `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `TWITCH_REDIRECT_URI`, and `APP_ALLOWED_OWNER_TWITCH_LOGIN` to the Twitch login allowed to connect. Keep the client secret only in the deployment environment.
3. Build and start the local image:

   ```sh
   docker compose -f docker-compose.yml build
   docker compose -f docker-compose.yml up -d
   ```

4. Open `http://localhost:8080/connect`. The host port maps to the container's port 80. A secure public origin is required for production OAuth, Wake Lock and reliable embedded playback.

The Compose file passes `.env` with `env_file`; defining values only for Compose interpolation does not inject them into the container. The `twitch-loop-data` volume contains the SQLite database and data-protection keys. Back up SQLite consistently with WAL enabled: stop the service before a simple volume copy, or use SQLite's backup API rather than copying only the main database file while it is live.

For a published-image deployment, copy `examples/docker-compose.yml` and use a matching `.env` file. The example image name follows the organisation's existing Docker Hub convention: `citr0s/twitch-loop:latest`.

## Configuration

Settings are stored in SQLite and edited from the Settings page. Playback preferences, browser polling interval, session duration, and the ordered stream priority list do not need to be supplied through `.env`. The backend checks Twitch live status every 60 seconds. The environment file is reserved for hosting and Twitch OAuth configuration; see `.env.example` for the variables.

`APP_ALLOWED_OWNER_TWITCH_LOGIN` configures the single Twitch login allowed to connect. The callback compares the authenticated Twitch login returned by Twitch case-insensitively and rejects other accounts. Twitch tokens never go to Angular or logs, and the OAuth callback uses a short-lived browser-bound state value.

## Architecture and adopted conventions

The implementation follows the compatible parts of `Citr0sCo/home-app` and `Citr0sCo/citr0s-app`: Angular frontend with npm scripts, .NET 10 SDK/runtime containers, a multi-stage root Dockerfile, `/data` persistence and Actions jobs for frontend/backend checks plus Docker Hub publishing. The workflows use the newer checkout/cache/login action versions from `home-app`, use `npm ci` because the frontend is nested, and only publish after a merged pull request. The reference apps use broader backend examples and do not provide Twitch-specific OAuth/player policy, so this repository keeps a smaller Core/Infrastructure/API split required by the specification.

```text
api/TwitchLoop.Api/            HTTP endpoints, cookie/OAuth gate, hosting
api/TwitchLoop.Core/           stream priority and fallback selection
api/TwitchLoop.Infrastructure/SQLite, Twitch client, protected token utilities
src/twitch-loop-web/           Angular connect, watch and settings routes
tests/TwitchLoop.Core.Tests/   deterministic priority selection tests
deploy/                        generic JSON configuration example
```

## Development

Frontend:

```sh
cd src/twitch-loop-web
npm install
npm run build
npm run lint
npm run test-ci
```

Backend (requires the .NET 10 SDK):

```sh
dotnet restore api/TwitchLoop.sln
dotnet build api/TwitchLoop.sln --configuration Release
dotnet test api/TwitchLoop.sln --configuration Release
```

Docker validation:

```sh
docker build --platform linux/amd64 -t twitch-loop .
```

The acceptance suite should additionally exercise real OAuth, Twitch API rate headers, multi-browser sessions and audible handoffs in current Chrome, Edge, Firefox, Safari and iPad Safari. Browser autoplay, third-party cookie restrictions and Wake Lock are capability-dependent; this project does not promise background playback, ad-free playback or uninterrupted locked-device execution.
