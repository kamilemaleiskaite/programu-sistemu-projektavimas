using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var chatRoom = new ChatRoom();

app.UseWebSockets();
app.UseDefaultFiles();
app.UseStaticFiles();
app.Map("/chat", chatRoom.HandleAsync);

app.Run();

sealed class ChatRoom
{
    private const int MaxFrameBytes = 4096;
    private const int MaxNameLength = 24;
    private const int MaxMessageLength = 500;
    private readonly ConcurrentDictionary<Guid, ChatPeer> _peers = new();

    public async Task HandleAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        ChatPeer? peer = null;
        Guid peerId = default;

        try
        {
            var joinFrame = await ReceiveTextAsync(socket, context.RequestAborted);
            if (joinFrame is null ||
                !TryReadText(joinFrame, "name", out var name) ||
                string.IsNullOrWhiteSpace(name) ||
                name.Trim().Length > MaxNameLength)
            {
                await SendAsync(socket, new ChatEvent("error", "Enter a name of 1–24 characters."));
                await CloseAsync(socket, WebSocketCloseStatus.PolicyViolation, "Invalid name");
                return;
            }

            name = name.Trim();
            peerId = Guid.NewGuid();
            peer = new ChatPeer(name, socket);
            _peers.TryAdd(peerId, peer);

            await peer.SendAsync(new ChatEvent("system", $"Welcome, {name}!"));
            await BroadcastAsync(new ChatEvent("system", $"{name} joined the chat."));

            while (socket.State == WebSocketState.Open && !context.RequestAborted.IsCancellationRequested)
            {
                var frame = await ReceiveTextAsync(socket, context.RequestAborted);
                if (frame is null)
                {
                    break;
                }

                if (!TryReadText(frame, "text", out var text))
                {
                    await peer.SendAsync(new ChatEvent("error", "Invalid message."));
                    continue;
                }

                text = text.Trim();
                if (text.Length == 0)
                {
                    continue;
                }

                if (text.Length > MaxMessageLength)
                {
                    await peer.SendAsync(new ChatEvent("error", "Messages must be 500 characters or fewer."));
                    continue;
                }

                await BroadcastAsync(new ChatEvent("message", text, name, DateTimeOffset.UtcNow));
            }
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
        }
        catch (WebSocketException)
        {
        }
        finally
        {
            if (peer is not null)
            {
                if (_peers.TryRemove(peerId, out _))
                {
                    await BroadcastAsync(new ChatEvent("system", $"{peer.Name} left the chat."));
                }

                await peer.CloseAsync();
            }
            else if (socket.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                await CloseAsync(socket, WebSocketCloseStatus.NormalClosure, "Disconnected");
            }
        }
    }

    private async Task BroadcastAsync(ChatEvent chatEvent)
    {
        foreach (var peer in _peers.Values)
        {
            try
            {
                await peer.SendAsync(chatEvent);
            }
            catch (WebSocketException)
            {
                peer.Abort();
            }
            catch (ObjectDisposedException)
            {
                peer.Abort();
            }
        }
    }

    private static bool TryReadText(string json, string propertyName, out string value)
    {
        value = string.Empty;
        try
        {
            using var document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind == JsonValueKind.Object &&
                document.RootElement.TryGetProperty(propertyName, out var property) &&
                property.ValueKind == JsonValueKind.String)
            {
                value = property.GetString() ?? string.Empty;
                return true;
            }
        }
        catch (JsonException)
        {
        }

        return false;
    }

    private static async Task<string?> ReceiveTextAsync(WebSocket socket, CancellationToken cancellationToken)
    {
        var buffer = new byte[1024];
        using var message = new MemoryStream();

        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            if (result.MessageType != WebSocketMessageType.Text)
            {
                await CloseAsync(socket, WebSocketCloseStatus.InvalidMessageType, "Text messages only");
                return null;
            }

            if (message.Length + result.Count > MaxFrameBytes)
            {
                await CloseAsync(socket, WebSocketCloseStatus.MessageTooBig, "Invalid message");
                return null;
            }

            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return Encoding.UTF8.GetString(message.ToArray());
            }
        }
    }

    internal static Task SendAsync(WebSocket socket, ChatEvent chatEvent) =>
        socket.SendAsync(
            JsonSerializer.SerializeToUtf8Bytes(chatEvent),
            WebSocketMessageType.Text,
            true,
            CancellationToken.None);

    private static async Task CloseAsync(WebSocket socket, WebSocketCloseStatus status, string description)
    {
        try
        {
            await socket.CloseAsync(status, description, CancellationToken.None);
        }
        catch (WebSocketException)
        {
        }
    }
}

sealed class ChatPeer(string name, WebSocket socket)
{
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    public string Name { get; } = name;

    public async Task SendAsync(ChatEvent chatEvent)
    {
        await _sendLock.WaitAsync();
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await ChatRoom.SendAsync(socket, chatEvent);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public async Task CloseAsync()
    {
        await _sendLock.WaitAsync();
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await socket.CloseAsync(
                    WebSocketCloseStatus.NormalClosure,
                    "Disconnected",
                    CancellationToken.None);
            }
            else if (socket.State == WebSocketState.CloseReceived)
            {
                await socket.CloseOutputAsync(
                    WebSocketCloseStatus.NormalClosure,
                    "Disconnected",
                    CancellationToken.None);
            }
        }
        catch (WebSocketException)
        {
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public void Abort() => socket.Abort();
}

sealed record ChatEvent(string Type, string Text, string? Name = null, DateTimeOffset? SentAt = null);
