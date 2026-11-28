const messages = document.querySelector("#messages");
const form = document.querySelector("#message-form");
const input = document.querySelector("#message-input");
const sendButton = document.querySelector("#send-button");
const dialog = document.querySelector("#name-dialog");
const nameForm = document.querySelector("#name-form");
const nameInput = document.querySelector("#name-input");
const dialogError = document.querySelector("#dialog-error");
const connectionStatus = document.querySelector("#connection-status");
const connectionDot = document.querySelector("#connection-dot");
const palette = ["#71866b", "#9d7863", "#71869a", "#9b806f", "#718e83", "#9a7483"];
let socket;
let displayName = "";

function setConnectionStatus(status, connected) {
  connectionStatus.textContent = status;
  connectionDot.classList.toggle("offline", !connected);
  input.disabled = !connected;
  sendButton.disabled = !connected;
}

function addSystemMessage(text) {
  const row = document.createElement("div");
  row.className = "system-message";
  row.textContent = text;
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
}

function addChatMessage(event) {
  const row = document.createElement("article");
  row.className = "message";

  const avatar = document.createElement("span");
  avatar.className = "avatar message-avatar";
  avatar.textContent = Array.from(event.name || "?")[0].toUpperCase();
  avatar.style.backgroundColor = palette[(event.name || "").length % palette.length];

  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const name = document.createElement("span");
  name.className = "message-name";
  name.textContent = event.name;
  const time = document.createElement("time");
  time.className = "message-time";
  const timestamp = event.sentAt ? new Date(event.sentAt) : new Date();
  time.dateTime = timestamp.toISOString();
  time.textContent = timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const text = document.createElement("div");
  text.className = "message-text";
  text.textContent = event.text;

  meta.append(name, time);
  body.append(meta, text);
  row.append(avatar, body);
  messages.append(row);
  messages.scrollTop = messages.scrollHeight;
}

function joinChat(name) {
  displayName = name;
  document.querySelector("#profile-name").textContent = name;
  document.querySelector("#profile-avatar").textContent = Array.from(name)[0].toUpperCase();

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/chat`);
  setConnectionStatus("Connecting", false);

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ name }));
    setConnectionStatus("Connected", true);
  });

  socket.addEventListener("message", (event) => {
    let chatEvent;
    try {
      chatEvent = JSON.parse(event.data);
    } catch {
      return;
    }

    if (chatEvent.type === "message") {
      addChatMessage(chatEvent);
    } else if (chatEvent.type === "system") {
      addSystemMessage(chatEvent.text);
    } else if (chatEvent.type === "error") {
      dialogError.textContent = chatEvent.text;
    }
  });

  socket.addEventListener("close", () => setConnectionStatus("Disconnected", false));
  socket.addEventListener("error", () => setConnectionStatus("Connection error", false));
}

nameForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (!name || name.length > 24) {
    dialogError.textContent = "Please enter a name of 1–24 characters.";
    return;
  }
  dialog.close();
  joinChat(name);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify({ text }));
  input.value = "";
  input.focus();
});

window.addEventListener("beforeunload", () => socket?.close());
dialog.showModal();
nameInput.focus();
