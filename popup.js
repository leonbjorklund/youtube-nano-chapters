const button = document.querySelector("#create");
const label = document.querySelector("#label");
const again = document.querySelector("#again");
const status = document.querySelector("#status");
const offer = document.querySelector("#offer");
const optIn = document.querySelector("#opt-in");
let generationStarted = false;
let adTimer;
let popupClosed = false;
// With the model already on the device, it loads early and the popup offers to name the chapters again.
let modelReady = false;
let downloadNote = "";
window.addEventListener(
  "pagehide",
  () => {
    popupClosed = true;
    clearTimeout(adTimer);
  },
  { once: true },
);

// Generation runs in the service worker (background.js), so it goes on and draws the chapters after the popup
// closes. Over this connection the popup asks whether its video is being worked on and hears how a run it follows
// ends; the connection closes with the popup, which lets the worker release a model loaded for a click that never came.
let worker = null;
const replies = {};
function send(message) {
  if (!worker) {
    worker = chrome.runtime.connect();
    worker.onMessage.addListener((reply) => {
      for (const [key, value] of Object.entries(reply)) {
        replies[key]?.(value);
        delete replies[key];
      }
    });
    // An idle worker stops after 30 seconds and takes the connection with it; the next message opens a new one. A
    // worker that stops before it answers leaves nothing to follow, and one that stops mid-run ends that run.
    worker.onDisconnect.addListener(() => {
      worker = null;
      replies.running?.(false);
      replies.ended?.({ error: "Couldn't generate chapters" });
      delete replies.running;
      delete replies.ended;
    });
  }
  worker.postMessage(message);
}
// The worker's next reply under this key.
const reply = (key) =>
  new Promise((resolve) => {
    replies[key] = resolve;
  });

// One read of the model per popup. The switch appears wherever Chrome can run the model; a device that can't is
// never told so. It keeps the user's choice, and without one starts on only where the model is already on the device,
// so nothing downloads unasked.
let availability = "unavailable";
const modelState = (async () => {
  availability = await modelAvailability();
  modelReady = availability === "available";
  const saved = localStorage.getItem("nanoTitles");
  optIn.checked = saved ? saved === "on" : modelReady;
  offer.hidden = availability === "unavailable";
  // A download Chrome is already running reports no progress to a popup that didn't start it.
  if (optIn.checked && availability === "downloading") downloadNote = "Downloading model";
})();

// Nano names the chapters only where the model is on the device and the switch is on.
const nanoOn = () => modelReady && optIn.checked;

// When the popup shows a video that can generate and Nano will name its chapters, the worker starts loading the
// model at once, so the click pays no startup. The worker keeps at most one such model per popup.
function warmModel() {
  if (nanoOn()) send({ warmUp: true });
}

function showState(state, text, message = "") {
  clearTimeout(adTimer);
  document.body.dataset.state = state;
  button.disabled =
    ["working", "unavailable", "blocked"].includes(state) || (state === "success" && !nanoOn());
  label.textContent = text;
  // An SVG element has no hidden property, so the attribute is toggled directly.
  const hideAgain = again.toggleAttribute("hidden", !(state === "success" && nanoOn()));
  // The arrow carries no text, so the button says what a second click would do.
  if (hideAgain) button.removeAttribute("aria-label");
  else button.setAttribute("aria-label", "Generate chapters again");
  status.textContent = message;
}

function showDownload(loaded) {
  if (!optIn.checked) return;
  downloadNote = `Downloading model ${Math.round(loaded * 100)}%`;
  if (!popupClosed && ["idle", "success"].includes(document.body.dataset.state))
    status.textContent = downloadNote;
}

// Switching on starts the download where the model isn't on the device yet; Chrome allows that only from the click
// itself. Switching off can't stop a started download, so it only stops using Nano and hides the progress.
optIn.addEventListener("change", () => {
  const previousNote = downloadNote;
  localStorage.setItem("nanoTitles", optIn.checked ? "on" : "off");
  if (optIn.checked && ["downloadable", "downloading"].includes(availability)) {
    downloadNote = "Downloading model";
    startModelDownload(showDownload);
  } else if (!optIn.checked) downloadNote = "";
  // Idle and success repaint for the new choice; a notice such as "Video already has chapters" stays.
  const state = document.body.dataset.state;
  if (state === "idle" || state === "success") {
    const note = status.textContent;
    showState(state, label.textContent, note === previousNote ? downloadNote : note);
    if (state === "idle") warmModel();
  }
});

button.addEventListener("click", () => {
  if (button.disabled) return;
  // A click in the popup's first moment waits for the model read, which sets the switch.
  return follow(
    Promise.all([activeVideo(), modelState]).then(([video]) => {
      const ended = reply("ended");
      send({ generate: video, useModel: optIn.checked });
      return ended;
    }),
  );
});

async function follow(run) {
  generationStarted = true;
  showState("working", "Generating chapters");
  try {
    const { error } = await run;
    if (error) throw new Error(error);
    // Whether Nano can name the chapters again comes from the model read, which a click in the popup's first moment
    // can beat.
    await modelState;
    showState("success", "Chapters added", downloadNote);
  } catch (error) {
    showError(error);
  }
}

function showError(error) {
  if (error.message === "Open a YouTube video") {
    showState("unavailable", "Open a YouTube video");
    // A device that can't run Gemini Nano is never told so: the popup names only reasons the user can act on.
  } else if (
    ["Video too short", "Wait for the ad to finish", "Live videos aren't supported"].includes(
      error.message,
    )
  ) {
    showState("blocked", "Generate chapters", error.message);
    if (error.message === "Wait for the ad to finish" && !popupClosed) {
      adTimer = setTimeout(() => showVideoState(true), 750);
    }
  } else {
    const messages = ["Video changed", "Video still loading", "Can't access this video"];
    showState(
      "error",
      "Try again",
      messages.includes(error.message) ? error.message : "Couldn't generate chapters",
    );
  }
}

async function activeVideo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  if (
    !tab?.id ||
    !url ||
    url.protocol !== "https:" ||
    !(url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) ||
    url.pathname !== "/watch" ||
    !url.searchParams.get("v")
  ) {
    throw new Error("Open a YouTube video");
  }
  return { tabId: tab.id, videoId: url.searchParams.get("v") };
}

async function showVideoState(recoveringFromAd = false) {
  const canUpdate = () =>
    !popupClosed &&
    (!generationStarted ||
      (recoveringFromAd &&
        document.body.dataset.state === "blocked" &&
        status.textContent === "Wait for the ad to finish"));
  try {
    const video = await activeVideo();
    if (!canUpdate()) return;
    // A popup that opens while its video is being worked on follows that run.
    const running = reply("running");
    const ended = reply("ended");
    send({ watch: video });
    const [injection, , working] = await Promise.all([
      chrome.scripting.executeScript({
        target: { tabId: video.tabId },
        world: "MAIN",
        func: readChapterState,
        args: [video.videoId],
      }),
      modelState,
      running,
    ]);
    const result = injection[0];
    if (canUpdate()) {
      if (working) follow(ended);
      else if (result?.result?.blocked) showError(new Error(result.result.blocked));
      // The page still shows chapters from an earlier run, whose popup has closed.
      else if (result?.result?.added) showState("success", "Chapters added", downloadNote);
      else if (result?.result?.transcript === false)
        showState("unavailable", "Video has no transcript");
      else {
        showState(
          "idle",
          "Generate chapters",
          result?.result?.native ? "Video already has chapters" : downloadNote,
        );
        warmModel();
      }
    }
  } catch (error) {
    if (canUpdate()) {
      console.error(error);
      showError(
        error.message === "Open a YouTube video" ? error : new Error("Can't access this video"),
      );
    }
  }
}

function readChapterState(expectedVideoId) {
  if (new URL(location.href).searchParams.get("v") !== expectedVideoId) return null;
  const player = document.querySelector("#movie_player");
  const response = player?.getPlayerResponse?.();
  const duration = Number(player?.getDuration?.());
  const current = response?.videoDetails?.videoId === expectedVideoId;
  const blocked = player?.classList?.contains("ad-showing")
    ? "Wait for the ad to finish"
    : current && duration > 0 && duration < 4
      ? "Video too short"
      : "";
  // The transcript is read from the captions the player lists, so a video that lists none has no transcript. A player
  // still showing another video says nothing about this one.
  const transcript =
    !current || Boolean(response.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length);
  // Read the current player's chapter data, not the shared "In this video" button.
  const next = player?.getWatchNextResponse?.();
  const markers =
    next?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer
      ?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;
  const native =
    current &&
    next?.currentVideoEndpoint?.watchEndpoint?.videoId === expectedVideoId &&
    Array.isArray(markers) &&
    markers.some((marker) => {
      const chapters = marker?.value?.chapters;
      return (
        Array.isArray(chapters) &&
        chapters.length > 1 &&
        chapters.every((entry, index) => {
          const chapter = entry?.chapterRenderer;
          const title = chapter?.title;
          const text =
            title?.simpleText ??
            (Array.isArray(title?.runs)
              ? title.runs.map((run) => (typeof run?.text === "string" ? run.text : "")).join("")
              : "");
          const start = chapter?.timeRangeStartMillis;
          return (
            typeof text === "string" &&
            text.trim().length > 0 &&
            Number.isSafeInteger(start) &&
            (index === 0
              ? start === 0
              : start > chapters[index - 1].chapterRenderer.timeRangeStartMillis)
          );
        })
      );
    });
  // Chapters this extension drew stay on the page until the tab leaves the video.
  return { blocked, native, transcript, added: Boolean(window.__nanoChaptersCleanup) };
}

const initialState = showVideoState();
