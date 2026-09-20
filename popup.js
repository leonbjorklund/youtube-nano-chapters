const button = document.querySelector("#create");
const label = document.querySelector("#label");
const again = document.querySelector("#again");
const status = document.querySelector("#status");
const offer = document.querySelector("#offer");
const optIn = document.querySelector("#opt-in");
let generationStarted = false;
let adTimer;
let popupClosed = false;
// Nano names the chapters only when the model is already on the device; otherwise they are named in code.
let modelReady = false;
let downloadNote = "";
// One download per popup: an ad or a failed run must not offer the box again and start a second one.
let downloadStarted = false;
// When the popup opens on a video that can generate and the model is already on the device, the model starts
// loading at once, so the click pays no startup.
let warmSession = null;
let warmController = null;
window.addEventListener("pagehide", () => {
  popupClosed = true;
  clearTimeout(adTimer);
  warmController?.abort();
  warmSession?.then((session) => session?.destroy()).catch(() => {});
}, { once: true });

// One read of the model per popup. The offer appears only where ticking it does something: Chrome has the model
// ready to fetch. A finished download makes it "available" and the box never returns; a download that died leaves
// the box for another try.
const modelState = (async () => {
  const availability = await modelAvailability();
  modelReady = availability === "available";
  // A download Chrome is already running reports no progress here, so the popup says nothing about it.
  return { offerDownload: availability === "downloadable" };
})();

function warmModel() {
  if (warmSession || popupClosed || !modelReady) return;
  warmController = new AbortController();
  warmSession = preloadModel(warmController.signal).catch(() => null);
}

function showState(state, text, message = "") {
  clearTimeout(adTimer);
  document.body.dataset.state = state;
  button.disabled = ["working", "unavailable", "blocked"].includes(state) || (state === "success" && !modelReady);
  label.textContent = text;
  // An SVG element has no hidden property, so the attribute is toggled directly.
  const hideAgain = again.toggleAttribute("hidden", !(state === "success" && modelReady));
  // The arrow carries no text, so the button says what a second click would do.
  if (hideAgain) button.removeAttribute("aria-label");
  else button.setAttribute("aria-label", "Generate chapters again");
  status.textContent = message;
}

function showDownload(loaded) {
  downloadNote = `Downloading model ${Math.round(loaded * 100)}%`;
  if (!popupClosed && ["idle", "success"].includes(document.body.dataset.state)) status.textContent = downloadNote;
}

button.addEventListener("click", async () => {
  if (button.disabled) return;
  generationStarted = true;
  // Chrome starts the download only from a click, so this stays ahead of every await in the handler.
  if (!offer.hidden && optIn.checked) {
    offer.hidden = true;
    downloadStarted = true;
    startModelDownload(showDownload);
  }
  const controller = new AbortController();
  const close = () => controller.abort();
  window.addEventListener("pagehide", close, { once: true });
  showState("working", "Generating chapters...");
  const warm = warmSession;
  const warmAbort = warmController;
  warmSession = null;
  warmController = null;
  // Closing the popup during generation also cancels a model still loading for it.
  controller.signal.addEventListener("abort", () => warmAbort?.abort(), { once: true });
  // A click in the popup's first moment can beat the model read; the run waits for it rather than falling back.
  await modelState;
  try {
    await generateChapters({
      resolveVideo: activeVideo,
      executeScript: (injection) => chrome.scripting.executeScript(injection),
      controller, warmSession: warm, useModel: modelReady, fallbackTitles: true,
    });
    showState("success", "Chapters added", downloadNote);
  } catch (error) {
    console.error(error);
    showError(error);
  } finally {
    window.removeEventListener("pagehide", close);
  }
});

function showError(error) {
  if (error.message === "Open a YouTube video") {
    showState("unavailable", "Open a YouTube video");
  // A device that can't run Gemini Nano is never told so: the popup names only reasons the user can act on.
  } else if (["Video too short", "Wait for the ad to finish", "Live videos aren't supported"].includes(error.message)) {
    showState("blocked", "Generate chapters", error.message);
    if (error.message === "Wait for the ad to finish" && !popupClosed) {
      adTimer = setTimeout(() => showVideoState(true), 750);
    }
  } else {
    const messages = [
      "Transcript unavailable", "Video changed", "Video still loading",
      "Can't access this video",
    ];
    showState("error", "Try again", messages.includes(error.message) ? error.message : "Couldn't generate chapters");
  }
}

async function activeVideo() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ? new URL(tab.url) : null;
  if (!tab?.id || !url || url.protocol !== "https:" ||
      !(url.hostname === "youtube.com" || url.hostname.endsWith(".youtube.com")) ||
      url.pathname !== "/watch" || !url.searchParams.get("v")) {
    throw new Error("Open a YouTube video");
  }
  return { tabId: tab.id, videoId: url.searchParams.get("v") };
}

async function showVideoState(recoveringFromAd = false) {
  const canUpdate = () => !popupClosed && (!generationStarted ||
    (recoveringFromAd && document.body.dataset.state === "blocked" && status.textContent === "Wait for the ad to finish"));
  try {
    const { tabId, videoId } = await activeVideo();
    if (!canUpdate()) return;
    const [injection, { offerDownload }] = await Promise.all([
      chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: readChapterState, args: [videoId] }),
      modelState,
    ]);
    const result = injection[0];
    if (canUpdate()) {
      if (result?.result?.blocked) showError(new Error(result.result.blocked));
      else {
        showState("idle", "Generate chapters", result?.result?.native ? "Video already has chapters" : downloadNote);
        offer.hidden = !offerDownload || downloadStarted;
        warmModel();
      }
    }
  } catch (error) {
    if (canUpdate()) {
      console.error(error);
      showError(error.message === "Open a YouTube video" ? error : new Error("Can't access this video"));
    }
  }
}

function readChapterState(expectedVideoId) {
  if (new URL(location.href).searchParams.get("v") !== expectedVideoId) return null;
  const player = document.querySelector("#movie_player");
  const response = player?.getPlayerResponse?.();
  const duration = Number(player?.getDuration?.());
  const blocked = player?.classList?.contains("ad-showing") ? "Wait for the ad to finish" :
    response?.videoDetails?.videoId === expectedVideoId && duration > 0 && duration < 4 ? "Video too short" : "";
  // Read the current player's chapter data, not the shared "In this video" button.
  const next = player?.getWatchNextResponse?.();
  const markers = next?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer
    ?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap;
  const native = response?.videoDetails?.videoId === expectedVideoId &&
    next?.currentVideoEndpoint?.watchEndpoint?.videoId === expectedVideoId &&
    Array.isArray(markers) && markers.some((marker) => {
      const chapters = marker?.value?.chapters;
      return Array.isArray(chapters) && chapters.length > 1 && chapters.every((entry, index) => {
        const chapter = entry?.chapterRenderer;
        const title = chapter?.title;
        const text = title?.simpleText ?? (Array.isArray(title?.runs)
          ? title.runs.map(run => typeof run?.text === "string" ? run.text : "").join("") : "");
        const start = chapter?.timeRangeStartMillis;
        return typeof text === "string" && text.trim().length > 0 && Number.isSafeInteger(start) &&
          (index === 0 ? start === 0 : start > chapters[index - 1].chapterRenderer.timeRangeStartMillis);
      });
    });
  return { blocked, native };
}

const initialState = showVideoState();
