# Simple C# Web Chat

A small ASP.NET Core web chat built with the .NET Web SDK. Multiple people can
join the same live chat from their browsers; no account or external service is
required.

## Run locally

Open a terminal in this directory and run:

```powershell
dotnet run --urls http://localhost:5000
```

Open `http://localhost:5000` in one or more browser tabs, choose a display name,
and start chatting. Use Ctrl+C in the terminal to stop the server.

The app uses WebSockets for live messages and serves its browser interface from
`wwwroot`.
