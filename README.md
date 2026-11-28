# programu-sistemu-projektavimas

TeamChat base platform implementation.

The implementation follows `TeamChat_specifikacijos_ivertinimas.pdf` and the
TeamChat REST contract in `openapi.yaml` (copied into this environment by the
project operator).

## Run locally

```powershell
npm.cmd start
```

Open `http://localhost:8080`. Demo sign-in:

- email: `anna@teamchat.local`
- password: `teamchat123`

## Docker

Docker is not available in the current environment, but the project includes:

```powershell
docker compose up --build
```

## Included baseline

- JWT sign-in and demo account
- Public/private channels and direct messages
- Channel membership
- Server-sequenced messages with idempotent send support
- Read state
- File upload/download
- Workflows
- Notifications
- Presence
- WebSocket ticket handshake and event frames
