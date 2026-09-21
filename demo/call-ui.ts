const paths = {
  mic: `
    <rect x="9" y="2" width="6" height="12" rx="3"/>
    <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>
  `,
  micOff: `
    <path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4
      M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8"/>
  `,
  camera: `
    <rect x="3" y="5" width="12" height="14" rx="3"/>
    <path d="m15 10 6-4v12l-6-4"/>
  `,
  cameraOff: `
    <path d="m3 3 18 18M10 5h2a3 3 0 0 1 3 3v2l6-4v12l-3-2
      M15 15v1a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8"/>
  `,
  sound: `
    <path d="m11 5-6 4H2v6h3l6 4zM15 8a6 6 0 0 1 0 8
      M18 5a10 10 0 0 1 0 14"/>
  `,
  copy: `
    <rect x="8" y="8" width="12" height="13" rx="2"/>
    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>
  `,
  leave: `
    <path d="M3 15v-4c5-5 13-5 18 0v4l-5-1v-3
      a13 13 0 0 0-8 0v3z"/>
  `,
};

function icon(name: keyof typeof paths) {
  return `<svg viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${paths[name]}</svg>`;
}

function control(
  id: string,
  name: keyof typeof paths,
  label: string,
  off = false,
  pressed?: boolean,
) {
  const button = document.getElementById(id) as HTMLButtonElement | null;
  if (!button) return;

  button.innerHTML = icon(name);
  button.title = label;
  button.setAttribute("aria-label", label);
  button.classList.toggle("is-off", off);

  if (pressed !== undefined) {
    button.setAttribute("aria-pressed", String(pressed));
  }
}

export function syncCallUI(stream?: MediaStream, joined = false) {
  const mic = !!stream?.getAudioTracks().some(
    (track) => track.enabled && track.readyState === "live",
  );
  const camera = !!stream?.getVideoTracks().some(
    (track) => track.enabled && track.readyState === "live",
  );

  control("mic", mic ? "mic" : "micOff",
    mic ? "Mute microphone" : "Unmute microphone", !mic, mic);

  control("camera", camera ? "camera" : "cameraOff",
    camera ? "Turn camera off" : "Turn camera on", !camera, camera);

  control("sound", "sound", "Enable sound");
  control("copy", "copy", "Copy room ID");
  control("leave", "leave", "Leave meeting");

  document.body.classList.toggle("in-call", joined);

  const local = document.getElementById("peer-local");
  if (local) {
    local.classList.toggle("camera-off", !camera);
    if (!mic) local.classList.remove("speaking");

    const label = local.querySelector(":scope > span");
    if (label) label.textContent = mic ? "You" : "You · muted";
  }
}

type Meter = {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  media: MediaStream;
  element: HTMLElement;
  local: boolean;
  lastVoice: number;
};

let context: AudioContext | undefined;
let frame = 0;
const meters = new Map<string, Meter>();

export function resumeAudioUI() {
  if (context?.state === "suspended") {
    void context.resume().catch(() => {
      // Audio playback and calling remain independent of this visual meter.
    });
  }
}

function animate() {
  frame = 0;

  for (const meter of meters.values()) {
    const track = meter.media.getAudioTracks()[0];
    const usable = !!track &&
      track.readyState === "live" &&
      !track.muted &&
      (!meter.local || track.enabled);

    let speaking = false;

    if (usable && context?.state === "running") {
      meter.analyser.getFloatTimeDomainData(meter.samples);

      let sum = 0;
      for (const sample of meter.samples) sum += sample * sample;
      const rms = Math.sqrt(sum / meter.samples.length);

      if (rms > 0.025) meter.lastVoice = performance.now();
      speaking = performance.now() - meter.lastVoice < 220;
    }

    meter.element.classList.toggle("speaking", speaking);
  }

  if (meters.size) frame = requestAnimationFrame(animate);
}

export function releaseTileUI(id: string) {
  const meter = meters.get(id);
  if (!meter) return;

  meter.source.disconnect();
  meter.analyser.disconnect();
  meter.element.classList.remove("speaking");
  meters.delete(id);

  if (!meters.size && frame) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
}

export function resetCallUI() {
  for (const id of [...meters.keys()]) releaseTileUI(id);

  const previous = context;
  context = undefined;

  if (previous && previous.state !== "closed") {
    void previous.close().catch(() => {
      // Closing a visual meter should never interrupt application cleanup.
    });
  }

  document.body.classList.remove("in-call");
}

export function decorateTile(
  id: string,
  media: MediaStream,
  local: boolean,
) {
  const element = document.getElementById(`peer-${id}`);
  if (!element) return;

  if (!element.querySelector(".tile-avatar")) {
    const avatar = document.createElement("div");
    avatar.className = "tile-avatar";
    avatar.setAttribute("aria-hidden", "true");

    const initial = document.createElement("b");
    initial.textContent = local ? "Y" : "P";
    avatar.append(initial);

    const indicator = document.createElement("div");
    indicator.className = "voice-indicator";
    indicator.setAttribute("aria-hidden", "true");

    for (let index = 0; index < 3; index++) {
      indicator.append(document.createElement("i"));
    }

    element.append(avatar, indicator);
  }

  element.classList.toggle(
    "camera-off",
    !media.getVideoTracks().some(
      (track) => track.readyState === "live" && (!local || track.enabled),
    ),
  );

  const audio = media.getAudioTracks()[0];
  if (!audio || meters.has(id)) return;

  // Metering is optional. Unsupported Web Audio must not prevent calling.
  try {
    if (typeof AudioContext === "undefined") return;
    context ??= new AudioContext();

    const source = context.createMediaStreamSource(
      new MediaStream([audio]),
    );
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;

    // Deliberately not connected to speakers: avoids local microphone echo.
    source.connect(analyser);

    meters.set(id, {
      source,
      analyser,
      samples: new Float32Array(new ArrayBuffer(512 * 4)),
      media,
      element,
      local,
      lastVoice: -Infinity,
    });

    resumeAudioUI();
    if (!frame) frame = requestAnimationFrame(animate);
  } catch {
    releaseTileUI(id);
  }
}