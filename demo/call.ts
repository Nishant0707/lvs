import { io, type Socket } from "socket.io-client";
import {
  decorateTile,
  releaseTileUI,
  resetCallUI,
  resumeAudioUI,
  syncCallUI,
} from "./call-ui.js";

const el = (id: string) => document.getElementById(id)!;
const btn = (id: string) => el(id) as HTMLButtonElement;
const field = (id: string) => el(id) as HTMLInputElement;

type RoomData = {
  id: string;
  name: string;
  mode: string;
  host: string;
};

type Peer = {
  pc: RTCPeerConnection;
  ice: RTCIceCandidateInit[];
  queue: Promise<void>;
  roomId: string;
};

type Signal = {
  roomId: string;
  from: string;
  signal: {
    description?: RTCSessionDescriptionInit;
    candidate?: RTCIceCandidateInit;
  };
};

type LogKind =
  | "info"
  | "success"
  | "warning"
  | "error"
  | "user"
  | "mic"
  | "camera";

const logIcons: Record<LogKind, string> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
  user: "👤",
  mic: "🎙️",
  camera: "📷",
};

let token = "";
let userId = "";
let roomId = "";
let busy = false;
let isHost = false;
let generation = 0;

let socket: Socket | undefined;
let stream: MediaStream | undefined;

const peers = new Map<string, Peer>();

// Local testing configuration.
// Connections across different networks can require a STUN/TURN server.
const ICE_SERVERS: RTCIceServer[] = [];

function log(message: string, kind: LogKind = "info") {
  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const previous = el("log").textContent ?? "";
  el("log").textContent =
    `${time}  ${logIcons[kind]}  ${message}\n${previous}`.slice(0, 10000);
}

function error(value: unknown) {
  const message =
    value instanceof Error ? value.message : String(value);

  el("error").textContent = message;
  el("error").hidden = false;
  log(message, "error");
}

function hint(message: string) {
  el("hint").textContent = message;
}

function render() {
  const connected = !!socket?.connected;
  const joined = !!roomId && !!stream;

  for (const id of ["create", "join"]) {
    btn(id).disabled = busy || !connected;
  }

  for (const id of ["sound", "copy", "leave"]) {
    btn(id).disabled = busy || !joined;
  }

  btn("mic").disabled =
    busy || !joined || !stream?.getAudioTracks().length;

  btn("camera").disabled =
    busy || !joined || !stream?.getVideoTracks().length;

  for (const id of ["login", "register", "logout"]) {
    btn(id).disabled = busy;
  }

  btn("end").hidden = !isHost;
  btn("end").disabled = busy || !joined;

  el("empty").hidden = joined;

  const connectedPeers = [...peers.values()].filter(
    (entry) => entry.pc.connectionState === "connected",
  ).length;

  el("count").textContent =
    `${connectedPeers + (joined ? 1 : 0)} connected`;

  syncCallUI(stream, joined);
}

function action(fn: () => Promise<unknown>) {
  return () => {
    if (busy) return;

    resumeAudioUI();
    busy = true;
    el("error").hidden = true;
    render();

    void fn()
      .catch(error)
      .finally(() => {
        busy = false;
        render();
      });
  };
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(12000),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === "TimeoutError") {
      throw new Error("The server took too long to respond. Try again.");
    }

    throw new Error(
      "Cannot reach the backend. Check that the server is running.",
    );
  }

  const result = (await response.json()) as {
    success: boolean;
    data: T;
    error?: { message?: string };
  };

  if (!response.ok || !result.success) {
    throw new Error(
      `${result.error?.message ?? "Request failed"} (${response.status})`,
    );
  }

  return result.data;
}

function emit<T>(event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error("Connection offline. Sign in again to reconnect."));
      return;
    }

    socket.timeout(8000).emit(
      event,
      payload,
      (
        issue: Error | null,
        response: {
          success: boolean;
          data: T;
          error?: { message: string };
        },
      ) => {
        if (issue) {
          reject(new Error(`The ${event} request timed out. Try again.`));
          return;
        }

        if (!response?.success) {
          reject(
            new Error(response?.error?.message ?? "Call request failed"),
          );
          return;
        }

        resolve(response.data);
      },
    );
  });
}

function tile(
  id: string,
  media: MediaStream,
  label: string,
  local = false,
) {
  let element = document.getElementById(`peer-${id}`);

  if (!element) {
    element = document.createElement("div");
    element.id = `peer-${id}`;
    element.className = `tile${local ? " local" : ""}`;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = local;

    const text = document.createElement("span");
    text.textContent = label;

    element.append(video, text);
    el("videos").append(element);
  }

  const video = element.querySelector("video")!;
  video.srcObject = media;

  decorateTile(id, media, local);

  void video.play().catch(() => {
    hint("Press the speaker icon to enable audio playback.");
  });
}

function drop(id: string) {
  releaseTileUI(id);

  const entry = peers.get(id);
  peers.delete(id);

  if (entry) {
    entry.pc.ontrack = null;
    entry.pc.onicecandidate = null;
    entry.pc.onconnectionstatechange = null;
    entry.pc.close();
  }

  document.getElementById(`peer-${id}`)?.remove();
  render();
}

function cleanup() {
  generation++;
  resetCallUI();

  for (const id of [...peers.keys()]) {
    drop(id);
  }

  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;

  document.getElementById("peer-local")?.remove();

  roomId = "";
  isHost = false;
  render();
}

function isCurrentPeer(id: string, entry: Peer) {
  return (
    peers.get(id) === entry &&
    roomId === entry.roomId &&
    entry.pc.signalingState !== "closed"
  );
}

function peer(id: string): Peer {
  const existing = peers.get(id);
  if (existing) return existing;

  if (!stream || !roomId) {
    throw new Error("Join a meeting before connecting participants.");
  }

  const localStream = stream;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const entry: Peer = {
    pc,
    ice: [],
    queue: Promise.resolve(),
    roomId,
  };

  peers.set(id, entry);

  for (const track of localStream.getTracks()) {
    pc.addTrack(track, localStream);
  }

  const remote = new MediaStream();

  pc.ontrack = (event) => {
    if (!isCurrentPeer(id, entry)) return;

    if (!remote.getTracks().some((track) => track.id === event.track.id)) {
      remote.addTrack(event.track);
    }

    tile(id, remote, `Participant ${id.slice(0, 5)}`);
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate || !isCurrentPeer(id, entry)) return;

    void emit("call:signal", {
      roomId: entry.roomId,
      target: id,
      signal: { candidate: event.candidate.toJSON() },
    }).catch((cause: unknown) => {
      if (isCurrentPeer(id, entry)) error(cause);
    });
  };

  pc.onconnectionstatechange = () => {
    if (!isCurrentPeer(id, entry)) return;

    const state = pc.connectionState;

    log(
      `Participant ${id.slice(0, 5)} · ${state}`,
      state === "connected" ? "success" : "info",
    );

    if (state === "connected") {
      hint("You’re connected. Unmute when you’re ready to speak.");
    }

    if (state === "failed") {
      error(
        new Error(
          "Could not connect to a participant. Leave and rejoin. " +
          "Calls across different networks may require a TURN server.",
        ),
      );
    }

    render();
  };

  return entry;
}

async function startPeer(id: string) {
  if (!roomId || !stream || peers.has(id)) return;

  const entry = peer(id);
  const ownId = socket?.id;

  // One deterministic offerer prevents both peers sending offers at once.
  if (ownId && ownId < id) {
    entry.queue = entry.queue.then(async () => {
      if (!isCurrentPeer(id, entry)) return;

      const offer = await entry.pc.createOffer();
      if (!isCurrentPeer(id, entry)) return;

      await entry.pc.setLocalDescription(offer);
      if (!isCurrentPeer(id, entry)) return;

      await emit("call:signal", {
        roomId: entry.roomId,
        target: id,
        signal: {
          description: entry.pc.localDescription!.toJSON(),
        },
      });
    });

    await entry.queue;
  }
}

function receiveSignal(data: Signal) {
  if (data.roomId !== roomId || !stream) return;

  const entry = peer(data.from);

  entry.queue = entry.queue
    .then(async () => {
      if (!isCurrentPeer(data.from, entry)) return;

      if (data.signal.description) {
        await entry.pc.setRemoteDescription(data.signal.description);
        if (!isCurrentPeer(data.from, entry)) return;

        for (const candidate of entry.ice) {
          await entry.pc.addIceCandidate(candidate);
          if (!isCurrentPeer(data.from, entry)) return;
        }

        entry.ice = [];

        if (data.signal.description.type === "offer") {
          const answer = await entry.pc.createAnswer();
          if (!isCurrentPeer(data.from, entry)) return;

          await entry.pc.setLocalDescription(answer);
          if (!isCurrentPeer(data.from, entry)) return;

          await emit("call:signal", {
            roomId: entry.roomId,
            target: data.from,
            signal: {
              description: entry.pc.localDescription!.toJSON(),
            },
          });
        }
      } else if (data.signal.candidate) {
        if (entry.pc.remoteDescription) {
          await entry.pc.addIceCandidate(data.signal.candidate);
        } else {
          entry.ice.push(data.signal.candidate);
        }
      }
    })
    .catch((cause: unknown) => {
      if (isCurrentPeer(data.from, entry)) error(cause);
    });
}

async function authenticate(register: boolean) {
  if (!(el("auth") as HTMLFormElement).reportValidity()) return;

  if (register && !field("name").value.trim()) {
    throw new Error("Enter your name to create an account.");
  }

  const data = await api<{
    token: string;
    user: { id: string; name: string };
  }>(register ? "/auth/register" : "/auth/login", {
    email: field("email").value.trim(),
    password: field("password").value,
    ...(register ? { name: field("name").value.trim() } : {}),
  });

  cleanup();
  socket?.removeAllListeners();
  socket?.disconnect();

  token = data.token;
  userId = data.user.id;

  el("auth").hidden = true;
  btn("logout").hidden = false;
  el("account").textContent = data.user.name;
  field("password").value = "";

  el("status").textContent = "Connecting…";
  log(register ? "Account created" : "Signed in", "success");

  socket = io({
    transports: ["websocket"],
    auth: { token },
  });

  socket.on("connect", () => {
    el("status").textContent = "Connected";
    log("Meeting connection ready", "success");
    render();
  });

  socket.on("disconnect", (reason: string) => {
    const wasInRoom = !!roomId;
    cleanup();

    el("status").textContent = "Disconnected";
    el("auth").hidden = false;

    if (wasInRoom) {
      el("room-title").textContent = "Connection interrupted.";
    }

    hint("Reconnect, then join your meeting again.");
    log(`Connection closed · ${reason}`, "warning");
  });

  socket.on("connect_error", (cause: Error) => {
    el("status").textContent = "Connection unavailable";
    el("auth").hidden = false;
    error(cause);
    render();
  });

  socket.on("call:peer-joined", ({ peerId }: { peerId: string }) => {
    if (!roomId || !stream) return;

    log(`Participant ${peerId.slice(0, 5)} joined`, "user");
    void startPeer(peerId).catch(error);
  });

  socket.on("call:peer-left", ({ peerId }: { peerId: string }) => {
    if (peers.has(peerId)) {
      log(`Participant ${peerId.slice(0, 5)} left`, "user");
      drop(peerId);
    }
  });

  socket.on("room:status", (data: { roomId: string; status: string }) => {
    if (data.roomId === roomId && data.status === "ended") {
      cleanup();
      el("room-title").textContent = "This meeting has ended.";
      hint("Create another meeting whenever you’re ready.");
      log("The host ended the meeting", "info");
    }
  });

  socket.on(
    "participant:left",
    (data: { roomId: string; userId: string }) => {
      if (data.roomId === roomId && data.userId === userId && !busy) {
        cleanup();
        el("room-title").textContent = "You left the meeting.";
        log("Your room membership ended", "info");
      }
    },
  );

  socket.on("call:signal", (data: Signal) => {
    try {
      receiveSignal(data);
    } catch (cause) {
      error(cause);
    }
  });

  render();
}

async function join(id: string) {
  if (!/^[a-fA-F0-9]{24}$/.test(id)) {
    throw new Error("Paste a valid room ID.");
  }

  if (!socket?.connected) {
    throw new Error("Sign in and wait for the connection to become ready.");
  }

  if (roomId) await leave();

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera and microphone access requires localhost or HTTPS.");
  }

  const attempt = generation;
  log("Requesting camera and microphone access", "info");

  const media = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: field("camera-choice").checked
      ? { width: { ideal: 640 }, height: { ideal: 480 } }
      : false,
  });

  if (attempt !== generation || !socket?.connected) {
    media.getTracks().forEach((track) => track.stop());
    throw new Error("The connection changed. Please join again.");
  }

  stream = media;

  for (const track of stream.getAudioTracks()) {
    track.enabled = false;
  }

  let membershipJoined = false;

  try {
    const room = await emit<RoomData>("room:join", { roomId: id });
    membershipJoined = true;

    if (attempt !== generation) {
      throw new Error("The connection changed. Please join again.");
    }

    if (room.mode !== "call") {
      throw new Error("Create a video meeting on this page to use this room.");
    }

    roomId = room.id;
    isHost = room.host === userId;

    field("room-id").value = roomId;
    el("room-title").textContent = room.name;

    tile("local", stream, "You · muted", true);
    render();

    const result = await emit<{ peers: string[] }>("call:join", { roomId });

    if (attempt !== generation || !stream || roomId !== room.id) {
      throw new Error("The meeting closed while connecting.");
    }

    const outcomes = await Promise.allSettled(result.peers.map(startPeer));

    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        log("A participant could not connect. Try rejoining.", "warning");
      }
    }

    if (attempt !== generation) return;

    hint("Your microphone is muted. Press the microphone icon to speak.");
    log(`Joined ${room.name}`, "success");
    log("Microphone muted", "mic");
  } catch (cause) {
    await emit("call:leave", {}).catch(() => undefined);

    if (membershipJoined) {
      await api(`/rooms/${id}/leave`, {}).catch(() => {
        log("Could not confirm room membership cleanup", "warning");
      });
    }

    cleanup();
    throw cause;
  }

  render();
}

async function leave() {
  const id = roomId;
  if (!id) return;

  // Stop capturing immediately while the server processes the leave request.
  cleanup();
  el("room-title").textContent = "You left the meeting.";
  hint("Create or join another meeting whenever you’re ready.");

  await emit("call:leave", {}).catch(() => undefined);
  await api(`/rooms/${id}/leave`, {});

  log("Left the meeting", "success");
}

el("auth").onsubmit = (event) => {
  event.preventDefault();
  action(() => authenticate(false))();
};

btn("register").onclick = action(() => authenticate(true));

btn("create").onclick = action(async () => {
  const name = field("room-name").value.trim();

  if (name.length < 2) {
    throw new Error("Enter a meeting name with at least two characters.");
  }

  const room = await api<{ id: string }>("/rooms", {
    name,
    mode: "call",
  });

  field("room-id").value = room.id;
  log("Meeting created", "success");
  await join(room.id);
});

btn("join").onclick = action(() =>
  join(field("room-id").value.trim()),
);

btn("mic").onclick = () => {
  if (busy || !stream || !roomId) return;

  resumeAudioUI();

  const tracks = stream.getAudioTracks();
  const enabled = !tracks.some((track) => track.enabled);

  for (const track of tracks) {
    track.enabled = enabled;
  }

  log(enabled ? "Microphone on" : "Microphone muted", "mic");
  hint(
    enabled
      ? "You’re unmuted. Your tile lights up when audio is detected."
      : "You’re muted. Press the microphone icon to speak.",
  );

  render();
};

btn("camera").onclick = () => {
  if (busy || !stream || !roomId) return;

  const tracks = stream.getVideoTracks();
  const enabled = !tracks.some((track) => track.enabled);

  for (const track of tracks) {
    track.enabled = enabled;
  }

  log(enabled ? "Camera on" : "Camera off", "camera");
  render();
};

btn("sound").onclick = action(async () => {
  resumeAudioUI();

  await Promise.all(
    [...document.querySelectorAll("video")].map((video) => video.play()),
  );

  hint("Audio playback enabled. Headphones help prevent echo.");
  log("Audio playback enabled", "success");
});

btn("copy").onclick = action(async () => {
  if (!roomId) return;

  if (!navigator.clipboard?.writeText) {
    throw new Error("Clipboard unavailable. Copy the ID from the Room ID field.");
  }

  await navigator.clipboard.writeText(roomId);
  hint("Room ID copied. Share it with someone you want to invite.");
  log("Room ID copied", "success");
});

btn("leave").onclick = action(leave);

btn("end").onclick = action(async () => {
  if (!roomId || !isHost) return;

  const id = roomId;
  await api(`/rooms/${id}/end`, {});

  cleanup();
  el("room-title").textContent = "Meeting ended.";
  hint("The meeting has ended for everyone.");
  log("Meeting ended for everyone", "success");
});

btn("logout").onclick = action(async () => {
  try {
    if (roomId) await leave();
  } finally {
    cleanup();

    socket?.removeAllListeners();
    socket?.disconnect();
    socket = undefined;

    token = "";
    userId = "";

    el("auth").hidden = false;
    btn("logout").hidden = true;
    el("account").textContent = "";
    el("status").textContent = "Signed out";
    el("room-title").textContent = "Ready when you are.";

    hint("Sign in to start your next conversation.");
    log("Signed out", "success");
  }
});

document.addEventListener("click", resumeAudioUI);

window.addEventListener("pagehide", () => {
  cleanup();
  socket?.disconnect();
});

const initialRoom = new URLSearchParams(window.location.search).get("room");

if (initialRoom) {
  field("room-id").value = initialRoom;
}

render();
log("LVS Meet ready. Sign in to continue.", "info");