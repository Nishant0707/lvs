// @vitest-environment happy-dom

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

const mocks = vi.hoisted(() => ({
  io: vi.fn(),
  fetch: vi.fn(),
  getUserMedia: vi.fn(),
}));

vi.mock("socket.io-client", () => ({
  io: mocks.io,
}));

const fixture = {
  id: "cccccccccccccccccccccccc",
  name: "Test video room",
  host: "aaaaaaaaaaaaaaaaaaaaaaaa",
  mode: "call",
  participantCount: 1,
  revision: 0,
  status: "active",
};

type Listener = (data?: unknown) => void;

type Ack = (
  error: Error | null,
  result: {
    success: boolean;
    data?: unknown;
    error?: { message: string };
  },
) => void;

function createSocket() {
  const listeners = new Map<string, Listener[]>();

  const socket = {
    id: "local-socket",
    connected: true,

    on(event: string, listener: Listener) {
      const entries = listeners.get(event) ?? [];
      entries.push(listener);
      listeners.set(event, entries);

      if (event === "connect") {
        queueMicrotask(() => {
          if (socket.connected) listener();
        });
      }

      return socket;
    },

    timeout() {
      return socket;
    },

    emit: vi.fn((event: string, _payload: unknown, ack: Ack) => {
      switch (event) {
        case "room:join":
          ack(null, { success: true, data: fixture });
          break;

        case "call:join":
          ack(null, { success: true, data: { peers: [] } });
          break;

        case "call:leave":
          ack(null, { success: true, data: {} });
          break;

        default:
          ack(null, {
            success: false,
            error: { message: `Unexpected socket event: ${event}` },
          });
      }
    }),

    trigger(event: string, data?: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(data);
      }
    },

    disconnect: vi.fn(() => {
      if (!socket.connected) return socket;

      socket.connected = false;
      socket.trigger("disconnect", "io client disconnect");

      return socket;
    }),

    removeAllListeners() {
      listeners.clear();
      return socket;
    },
  };

  return socket;
}

function createTrack(kind: "audio" | "video") {
  const track = {
    id: `test-${kind}`,
    kind,
    enabled: true,
    muted: false,
    readyState: "live" as MediaStreamTrackState,

    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  };

  return track;
}

function createMedia() {
  const audio = createTrack("audio");
  const video = createTrack("video");

  const stream = {
    getTracks: () => [audio, video],
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  } as unknown as MediaStream;

  return { audio, video, stream };
}

let socket: ReturnType<typeof createSocket>;
let media: ReturnType<typeof createMedia>;
let restoreListeners: () => void = () => {};
let originalMediaDevices: PropertyDescriptor | undefined;

function button(id: string) {
  const element = document.getElementById(id);

  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${id}`);
  }

  return element;
}

function input(id: string) {
  const element = document.getElementById(id);

  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Missing input: ${id}`);
  }

  return element;
}

function errorText() {
  return document.getElementById("error")?.textContent ?? "";
}

function assertNoVisibleError() {
  const notice = document.getElementById("error");

  if (notice && !notice.hidden && notice.textContent?.trim()) {
    throw new Error(`Demo error: ${notice.textContent.trim()}`);
  }
}

async function waitForJoined() {
  await vi.waitFor(() => {
    assertNoVisibleError();

    expect(socket.emit).toHaveBeenCalledWith(
      "call:join",
      { roomId: fixture.id },
      expect.any(Function),
    );

    expect(button("mic").disabled).toBe(false);
    expect(document.getElementById("peer-local")).not.toBeNull();
  });
}

async function login() {
  input("email").value = "demo@example.com";
  input("password").value = "StrongPass123!";
  input("name").value = "Demo";

  document.getElementById("auth")!.dispatchEvent(
    new Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );

  await vi.waitFor(() => {
    assertNoVisibleError();

    expect(mocks.io).toHaveBeenCalledTimes(1);
    expect(button("join").disabled).toBe(false);
  });

  // Signing in enables joining, not microphone capture.
  expect(button("mic").disabled).toBe(true);
  expect(mocks.getUserMedia).not.toHaveBeenCalled();
}

async function join() {
  input("room-id").value = fixture.id;
  button("join").click();

  await waitForJoined();
}

beforeEach(async () => {
  vi.resetModules();

  mocks.io.mockReset();
  mocks.fetch.mockReset();
  mocks.getUserMedia.mockReset();

  socket = createSocket();
  media = createMedia();

  mocks.io.mockReturnValue(socket);
  mocks.getUserMedia.mockResolvedValue(media.stream);

  const html = readFileSync("public/call.html", "utf8");
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];

  if (!body) {
    throw new Error("public/call.html must contain a body.");
  }

  document.body.className = "";
  document.body.innerHTML = body.replace(
    /<script\b[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );

  vi.spyOn(
    HTMLFormElement.prototype,
    "reportValidity",
  ).mockReturnValue(true);

  vi.spyOn(
    HTMLMediaElement.prototype,
    "play",
  ).mockResolvedValue(undefined);

  // These tests cover call controls and cleanup, not audio analysis.
  // Keep the actual call-ui module active, with Web Audio unavailable.
  vi.stubGlobal("AudioContext", undefined);

  originalMediaDevices = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: mocks.getUserMedia,
    },
  });

  mocks.fetch.mockImplementation(async (path: string) => {
    let data: unknown;

    if (path === "/auth/login" || path === "/auth/register") {
      data = {
        token: "app-token",
        user: {
          id: fixture.host,
          name: "Demo",
          email: "demo@example.com",
        },
      };
    } else if (
      path === "/rooms" ||
      path === `/rooms/${fixture.id}/leave` ||
      path === `/rooms/${fixture.id}/end`
    ) {
      data = fixture;
    } else {
      throw new Error(`Unexpected API request: ${path}`);
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data,
      }),
    };
  });

  vi.stubGlobal("fetch", mocks.fetch);

  const windowListeners = vi.spyOn(window, "addEventListener");
  const documentListeners = vi.spyOn(document, "addEventListener");

  restoreListeners = () => {
    for (const [type, listener, options] of windowListeners.mock.calls) {
      window.removeEventListener(type, listener, options);
    }

    for (const [type, listener, options] of documentListeners.mock.calls) {
      document.removeEventListener(type, listener, options);
    }
  };

  await import("../demo/call.js");
});

afterEach(() => {
  // Let the application release its media and connection first.
  window.dispatchEvent(new Event("pagehide"));

  restoreListeners();
  socket.removeAllListeners();

  if (originalMediaDevices) {
    Object.defineProperty(
      navigator,
      "mediaDevices",
      originalMediaDevices,
    );
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }

  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  document.body.className = "";
  document.body.innerHTML = "";
});

describe("native call demo", () => {
  it("requires login before joining and starts with media controls disabled", () => {
    expect(button("join").disabled).toBe(true);
    expect(button("create").disabled).toBe(true);
    expect(button("mic").disabled).toBe(true);
    expect(button("camera").disabled).toBe(true);

    expect(mocks.getUserMedia).not.toHaveBeenCalled();
    expect(mocks.io).not.toHaveBeenCalled();
  });

  it("joins through Socket.IO with the microphone initially muted", async () => {
    await login();
    await join();

    expect(socket.emit).toHaveBeenCalledWith(
      "room:join",
      { roomId: fixture.id },
      expect.any(Function),
    );

    expect(socket.emit).toHaveBeenCalledWith(
      "call:join",
      { roomId: fixture.id },
      expect.any(Function),
    );

    expect(media.audio.enabled).toBe(false);
    expect(document.getElementById("peer-local")).not.toBeNull();

    expect(button("mic").querySelector("svg")).not.toBeNull();
    expect(button("mic").getAttribute("aria-label")).toBe(
      "Unmute microphone",
    );

    button("mic").click();

    expect(media.audio.enabled).toBe(true);
    expect(button("mic").getAttribute("aria-label")).toBe(
      "Mute microphone",
    );

    button("mic").click();

    expect(media.audio.enabled).toBe(false);
    expect(button("mic").getAttribute("aria-label")).toBe(
      "Unmute microphone",
    );
  });

  it("creates a native call room and joins it", async () => {
    await login();

    input("room-name").value = "Team meeting";
    button("create").click();

    await waitForJoined();

    const request = mocks.fetch.mock.calls.find(
      ([path]) => path === "/rooms",
    );

    expect(request).toBeDefined();

    const options = request![1] as RequestInit;

    expect(options.method).toBe("POST");
    expect(JSON.parse(String(options.body))).toEqual({
      name: "Team meeting",
      mode: "call",
    });

    expect(options.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer app-token",
      }),
    );
  });

  it("keeps controls disabled while waiting for camera permission", async () => {
    let resolveMedia!: (stream: MediaStream) => void;

    mocks.getUserMedia.mockImplementationOnce(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveMedia = resolve;
        }),
    );

    await login();

    input("room-id").value = fixture.id;
    button("join").click();

    await vi.waitFor(() => {
      expect(mocks.getUserMedia).toHaveBeenCalledTimes(1);
    });

    expect(button("mic").disabled).toBe(true);
    expect(button("camera").disabled).toBe(true);
    expect(socket.emit).not.toHaveBeenCalled();

    resolveMedia(media.stream);

    await waitForJoined();

    expect(media.audio.enabled).toBe(false);
  });

  it("shows permission errors and allows another join attempt", async () => {
    mocks.getUserMedia.mockRejectedValueOnce(
      new Error("Camera permission denied"),
    );

    await login();

    input("room-id").value = fixture.id;
    button("join").click();

    await vi.waitFor(() => {
      expect(errorText()).toContain("Camera permission denied");
      expect(document.getElementById("error")!.hidden).toBe(false);
      expect(button("join").disabled).toBe(false);
    });

    expect(button("mic").disabled).toBe(true);
    expect(socket.emit).not.toHaveBeenCalled();

    await join();

    expect(mocks.getUserMedia).toHaveBeenCalledTimes(2);
    expect(document.getElementById("error")!.hidden).toBe(true);
  });

  it("stops local tracks and removes membership when leaving", async () => {
    await login();
    await join();

    button("leave").click();

    await vi.waitFor(() => {
      assertNoVisibleError();

      expect(mocks.fetch).toHaveBeenCalledWith(
        `/rooms/${fixture.id}/leave`,
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer app-token",
          }),
        }),
      );

      expect(button("join").disabled).toBe(false);
    });

    expect(socket.emit).toHaveBeenCalledWith(
      "call:leave",
      {},
      expect.any(Function),
    );

    expect(media.audio.stop).toHaveBeenCalledTimes(1);
    expect(media.video.stop).toHaveBeenCalledTimes(1);

    expect(media.audio.readyState).toBe("ended");
    expect(media.video.readyState).toBe("ended");

    expect(document.getElementById("peer-local")).toBeNull();
    expect(button("mic").disabled).toBe(true);
    expect(document.body.classList.contains("in-call")).toBe(false);
  });

  it("cleans up media when signaling disconnects", async () => {
    await login();
    await join();

    socket.disconnect();

    expect(media.audio.stop).toHaveBeenCalledTimes(1);
    expect(media.video.stop).toHaveBeenCalledTimes(1);

    expect(button("mic").disabled).toBe(true);
    expect(button("join").disabled).toBe(true);

    expect(document.getElementById("peer-local")).toBeNull();
    expect(document.body.classList.contains("in-call")).toBe(false);
  });
});