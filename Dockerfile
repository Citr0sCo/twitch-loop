FROM node:22-bookworm-slim AS angular-build
WORKDIR /web-gui
COPY src/twitch-loop-web/package*.json ./
RUN npm ci
COPY src/twitch-loop-web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS backend-build
WORKDIR /src
COPY api/ ./api/
COPY tests/ ./tests/
RUN dotnet restore api/TwitchLoop.sln
RUN dotnet publish api/TwitchLoop.Api/TwitchLoop.Api.csproj --configuration Release --no-restore --output /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
ENV ASPNETCORE_HTTP_PORTS=8080 \
    App__DataDirectory=/data
EXPOSE 8080
RUN apt-get update && apt-get install --yes --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=backend-build /app/publish ./
COPY --from=angular-build /web-gui/dist/twitch-loop-web/browser ./wwwroot
RUN mkdir -p /data/keys && chown -R 1654:1654 /app /data
USER 1654
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD curl --fail http://localhost:8080/health/ready || exit 1
ENTRYPOINT ["dotnet", "TwitchLoop.Api.dll"]
