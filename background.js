importScripts("generation.js", "chapters.js");

// Generation runs here rather than in the popup, so it goes on and draws the chapters after the popup closes: the
// activeTab grant stays with the tab until it loads another site. A video has one run at a time, and a popup opened
// during it follows that run instead of starting another.
const runs = new Map();

chrome.runtime.onConnect.addListener((popup) => {
  let open = true;
  // A model loaded when the popup opened on a video, so the click pays no startup.
  let warm = null;
  const follow = (run) =>
    run.then((error) => {
      if (open) popup.postMessage({ ended: { error } });
    });
  popup.onMessage.addListener(({ watch, warmUp, generate, useModel }) => {
    if (watch) {
      const run = runs.get(runKey(watch));
      popup.postMessage({ running: Boolean(run) });
      if (run) follow(run);
    }
    if (warmUp && !warm) {
      const controller = new AbortController();
      warm = { controller, session: preloadModel(controller.signal).catch(() => null) };
    }
    if (generate) {
      let run = runs.get(runKey(generate));
      if (!run) {
        run = startRun(generate, useModel ? warm : null, useModel);
        // A model loaded before the user switched Nano off has no use.
        if (!useModel) release(warm);
        warm = null;
      }
      follow(run);
    }
  });
  // A popup that closes without a click leaves no use for its model.
  popup.onDisconnect.addListener(() => {
    open = false;
    release(warm);
  });
});

function release(warm) {
  warm?.controller.abort();
  warm?.session.then((session) => session?.destroy()).catch(() => {});
}

const runKey = ({ tabId, videoId }) => `${tabId} ${videoId}`;

// A reloaded tab gets back the chapters it kept for its video (see injectChapters). Chrome reports the URL only of a
// tab the extension may still reach, and YouTube builds the player after the page loads, so drawing waits for it.
chrome.tabs.onUpdated.addListener(async (tabId, { status }, { url }) => {
  if (status !== "complete" || !url) return;
  for (let attempt = 0; attempt < 20; attempt++) {
    const [injection] = await chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        func: injectChapters,
        args: [null],
      })
      .catch(() => []);
    if (injection?.result?.error !== "Video still loading") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
});

// Resolves with the error message, or "" once the chapters are drawn.
function startRun(video, warm, useModel) {
  const controller = new AbortController();
  // Generation's cleanup also cancels a model still loading for it.
  controller.signal.addEventListener("abort", () => warm?.controller.abort(), { once: true });
  const run = generateChapters({
    ...video,
    executeScript: (injection) => chrome.scripting.executeScript(injection),
    controller,
    warmSession: warm?.session,
    useModel,
    fallbackTitles: true,
  })
    .then(
      () => "",
      (error) => {
        console.error(error);
        return error?.message || "Couldn't generate chapters";
      },
    )
    .finally(() => runs.delete(runKey(video)));
  runs.set(runKey(video), run);
  return run;
}
