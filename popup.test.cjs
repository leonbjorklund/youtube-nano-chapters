const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const generated = {
  chapter1: { timestamp: 0, title: "  Generated opening  " },
  chapter2: { timestamp: 180, title: "Generated architecture" },
  chapter3: { timestamp: 360, title: "Generated tradeoffs of battery & comfort" }, // 40 characters, the longest label the schema allows
  chapter4: { timestamp: 540, title: "Generated conclusion" },
};
// Messages between the popup and the service worker arrive in later tasks, as in Chrome, so settling takes a few.
const tick = async () => {
  for (let task = 0; task < 8; task++) await new Promise((resolve) => setImmediate(resolve));
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const source = (file) => readFileSync(path.join(__dirname, file), "utf8");

function popup(options = {}) {
  const calls = [];
  const inspections = [];
  const errors = [];
  const sessions = [];
  const clones = [];
  const downloads = [];
  const creations = [];
  const createCalls = [];
  const reads = [];
  const prompts = [];
  const timers = new Map();
  let timerId = 0;
  let now = 1_000;
  class Clock extends Date {
    static now() {
      return now;
    }
  }
  const tab =
    options.tab === undefined
      ? { id: 42, url: "https://www.youtube.com/watch?v=original-video" }
      : options.tab;
  // The popup's saved choices, kept across popups like the extension's own storage.
  const stored = new Map(Object.entries(options.stored ?? {}));
  const globals = {
    URL,
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, String(value)),
    },
    AbortController,
    Date: Clock,
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    console: { error: (error) => errors.push(error) },
    ...(options.missingApi
      ? {}
      : {
          LanguageModel: {
            availability: async () => {
              if (options.availabilityReady) await options.availabilityReady;
              reads.push("availability");
              if (options.availabilityError) throw options.availabilityError;
              // A model that goes away after the popup's read.
              return (
                (reads.length > 1 && options.availabilityAfter) ||
                options.availability ||
                "available"
              );
            },
            create(modelOptions) {
              createCalls.push(modelOptions);
              modelOptions.monitor?.({
                addEventListener: (type, listener) => {
                  assert.equal(type, "downloadprogress");
                  downloads.push(listener);
                },
              });
              // Code chooses the starts; each batch of titles is asked in its own copy of the created session.
              const session = {
                destroyed: 0,
                signal: modelOptions.signal,
                async clone({ signal }) {
                  signal.throwIfAborted();
                  const copy = { ...this, destroyed: 0 };
                  clones.push(copy);
                  return copy;
                },
                // Like Chrome's stream, the answer arrives in chunks and ends with an error once its signal aborts.
                async *promptStreaming(text, promptOptions) {
                  prompts.push({ text, options: promptOptions });
                  const { signal } = promptOptions;
                  const aborted = new Promise((_, reject) =>
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
                  );
                  aborted.catch(() => {});
                  if (options.promptReady) await Promise.race([options.promptReady, aborted]);
                  signal.throwIfAborted();
                  if (options.titleError) throw options.titleError;
                  // A string arrives as one chunk; an array arrives chunk by chunk.
                  yield* [
                    options.titleRaw ??
                      JSON.stringify(
                        Object.fromEntries(
                          promptOptions.responseConstraint.required.map((key) => [
                            key,
                            generated[key]?.title ?? `Generated part ${key.slice(7)}`,
                          ]),
                        ),
                      ),
                  ].flat();
                },
                destroy() {
                  this.destroyed++;
                },
              };
              // A create Chrome refuses: no space for the download, or a model that went away.
              if (options.createError) {
                const failure = Promise.resolve(options.modelReady).then(() => {
                  throw options.createError;
                });
                creations.push(failure);
                return failure;
              }
              sessions.push(session);
              const creation = options.modelReady
                ? options.modelReady.then(() => session)
                : Promise.resolve(session);
              creations.push(creation);
              return creation;
            },
          },
        }),
  };
  const tabs = {
    query: async () => {
      if (options.tabReady) await options.tabReady;
      return tab ? [tab] : [];
    },
  };
  const scripting = {
    async executeScript(injection) {
      if (injection.func.name === "readChapterState") {
        inspections.push(injection);
        if (options.inspectionReady) await options.inspectionReady;
        if (options.inspectionError) throw options.inspectionError;
        return [{ result: options.chapterState || { native: false } }];
      }
      calls.push(injection);
      if (injection.func.name === "fetchTranscript") {
        if (options.transcriptReady) await options.transcriptReady;
        if (options.transcriptError) throw options.transcriptError;
        if (options.transcriptResultError)
          return [{ result: { error: options.transcriptResultError } }];
        if (Object.hasOwn(options, "transcriptResult"))
          return [{ result: options.transcriptResult }];
        // A later tab URL must not replace the identity captured on click.
        tab.url = "https://www.youtube.com/watch?v=different-video";
        return [
          {
            result: {
              duration: 720,
              // Announced topics at 180, 360 and 540 become the generated starts.
              cues: [
                { time: 0, text: "Transcript about architecture." },
                { time: 180, text: "Next, the architecture itself." },
                { time: 360, text: "Next, tradeoffs between battery life and comfort." },
                { time: 540, text: "Next, the conclusion." },
              ],
              title: "Architecture talk",
            },
          },
        ];
      }
      // A reloaded tab's chapters are drawn from what the page kept, so the worker sends none.
      if (injection.args[0] === null) return [{ result: options.restoreResults.shift() }];
      if (options.rendererError) throw options.rendererError;
      if (options.rendererResultError) return [{ result: { error: options.rendererResultError } }];
      return [{ result: { count: injection.args[0].length } }];
    },
  };

  // The service worker, where generation runs. It lives on while popups open and close.
  const onConnect = [];
  const onUpdated = [];
  const workerEnds = [];
  const worker = vm.createContext({
    ...globals,
    chrome: {
      scripting,
      runtime: { onConnect: { addListener: (listener) => onConnect.push(listener) } },
      tabs: { onUpdated: { addListener: (listener) => onUpdated.push(listener) } },
    },
    importScripts: (...files) =>
      files.forEach((file) => vm.runInContext(source(file), worker, { filename: file })),
  });
  vm.runInContext(source("background.js"), worker, { filename: "background.js" });

  // A connection whose ends each hear the other's messages and closing a task later, as in Chrome.
  function connect() {
    const ends = [
      { message: [], disconnect: [] },
      { message: [], disconnect: [] },
    ];
    let connected = true;
    const end = (own, other) => ({
      onMessage: { addListener: (listener) => ends[own].message.push(listener) },
      onDisconnect: { addListener: (listener) => ends[own].disconnect.push(listener) },
      postMessage(message) {
        if (!connected) throw new Error("Attempting to use a disconnected port object");
        const copy = JSON.parse(JSON.stringify(message));
        setImmediate(() => {
          if (connected) ends[other].message.forEach((listener) => listener(copy));
        });
      },
      disconnect() {
        if (!connected) return;
        connected = false;
        setImmediate(() => ends[other].disconnect.forEach((listener) => listener()));
      },
    });
    setImmediate(() => {
      const workerEnd = end(1, 0);
      workerEnds.push(workerEnd);
      onConnect.forEach((listener) => listener(workerEnd));
    });
    return end(0, 1);
  }

  function open() {
    const window = new EventTarget();
    const body = { dataset: { state: "idle" } };
    const status = { textContent: "" };
    const labels = ["Generate chapters"];
    const ports = [];
    let click;
    const attributes = {};
    const button = {
      disabled: false,
      addEventListener(event, listener) {
        assert.equal(event, "click");
        click = listener;
      },
      setAttribute(name, value) {
        attributes[name] = value;
      },
      removeAttribute(name) {
        delete attributes[name];
      },
    };
    // The button's words live in their own span, beside the circular arrow that offers another naming.
    const label = {
      get textContent() {
        return labels.at(-1);
      },
      set textContent(value) {
        if (value !== labels.at(-1)) labels.push(value);
      },
    };
    // The arrow is an SVG element: no hidden property, only the attribute.
    const again = {
      attributes: new Set(["hidden"]),
      hasAttribute(name) {
        return this.attributes.has(name);
      },
      toggleAttribute(name, force) {
        if (force) this.attributes.add(name);
        else this.attributes.delete(name);
        return force;
      },
    };
    const offer = { hidden: true };
    let change;
    const optIn = {
      checked: false,
      addEventListener(event, listener) {
        assert.equal(event, "change");
        change = listener;
      },
    };
    const elements = {
      "#create": button,
      "#label": label,
      "#again": again,
      "#status": status,
      "#offer": offer,
      "#opt-in": optIn,
    };
    const queried = new Set();
    const context = vm.createContext({
      ...globals,
      window,
      document: {
        body,
        querySelector(selector) {
          assert.ok(Object.hasOwn(elements, selector), selector);
          queried.add(selector);
          return elements[selector];
        },
      },
      chrome: { tabs, scripting, runtime: { connect: () => ports[ports.push(connect()) - 1] } },
    });

    // Load the production scripts in the same order as the popup.
    const html = source("popup.html");
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(scripts, ["generation.js", "popup.js"]);
    for (const script of scripts) vm.runInContext(source(script), context, { filename: script });
    // Every element the popup reaches for must exist in the markup under that id, and the popup must reach for all
    // of them: a renamed id would otherwise break the popup without breaking a test.
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    assert.deepEqual([...queried].sort(), Object.keys(elements).sort());
    for (const selector of queried)
      assert.ok(ids.has(selector.slice(1)), `${selector} is missing from popup.html`);
    // The button's words change under the pointer, so a screen reader is told when they do.
    assert.match(html, /<span id="label"[^>]*aria-live="polite"/);

    return {
      button,
      label,
      again,
      offer,
      optIn,
      status,
      body,
      attributes,
      labels,
      ready: vm.runInContext("initialState", context),
      readChapterState: vm.runInContext("readChapterState", context),
      click: () => click(),
      // The user flips the Gemini Nano titles switch.
      flip(on) {
        optIn.checked = on;
        change();
      },
      // Closing the popup ends its page and, with it, its connections to the worker.
      close() {
        window.dispatchEvent(new Event("pagehide"));
        ports.forEach((port) => port.disconnect());
      },
    };
  }

  return {
    ...open(),
    createCalls,
    calls,
    inspections,
    errors,
    sessions,
    clones,
    prompts,
    timers,
    // Another popup on the same tab, beside the same worker.
    reopen: open,
    // Chrome stops the worker, which closes its connections.
    stopWorker: () => workerEnds.forEach((port) => port.disconnect()),
    // Chrome reports a change to the video's tab.
    tabUpdated: (change, tabInfo) => onUpdated.forEach((listener) => listener(42, change, tabInfo)),
    renderer: vm.runInContext("injectChapters", worker),
    fetchTranscript: vm.runInContext("fetchTranscript", worker),
    buildTitlePrompt: vm.runInContext("buildTitlePrompt", worker),
    selectStarts: vm.runInContext("selectStarts", worker),
    splitAtStarts: vm.runInContext("splitAtStarts", worker),
    nameChapters: vm.runInContext("nameChapters", worker),
    sectionCues: vm.runInContext("sectionCues", worker),
    tidyTitle: vm.runInContext("tidyTitle", worker),
    withKeywords: vm.runInContext("withKeywords", worker),
    generateChapterData: vm.runInContext("generateChapterData", worker),
    destroyed: () => sessions.reduce((total, session) => total + session.destroyed, 0),
    prompted: () => prompts.length,
    modelCreated: (index = 0) => creations[index],
    reportProgress: (loaded, index = 0) => downloads[index]({ loaded }),
    advance: (milliseconds) => {
      now += milliseconds;
    },
    async checkAd() {
      const entry = [...timers].find(([, timer]) => timer.delay === 750);
      assert.ok(entry, "ad state schedules a recheck");
      timers.delete(entry[0]);
      await entry[1].callback();
    },
    // Fires the running title batch's deadline, the end of the click's budget.
    expireTitles() {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      timers.delete(id);
      now += timer.delay;
      timer.callback();
    },
  };
}

function assertRetry(app, message) {
  assert.equal(app.body.dataset.state, "error");
  assert.equal(app.label.textContent, "Try again");
  assert.equal(app.button.disabled, false);
  if (message) assert.match(app.status.textContent, message);
  assert.equal(app.attributes["aria-label"], undefined);
  assert.equal(app.timers.size, 0);
}

// One success state for every titler. Only a device that has the model can name the chapters again, so the button
// stays clickable and shows the circular arrow there alone.
function assertSuccess(app, { modelOnDevice = true, message = "" } = {}) {
  assert.equal(app.body.dataset.state, "success");
  assert.equal(app.label.textContent, "Chapters added");
  assert.equal(app.button.disabled, !modelOnDevice);
  assert.equal(app.again.hasAttribute("hidden"), !modelOnDevice);
  // The arrow has no words of its own, so the button borrows some.
  assert.equal(app.attributes["aria-label"], modelOnDevice ? "Generate chapters again" : undefined);
  assert.equal(app.status.textContent, message);
}

// The harness transcript, as the production reader returns it.
const harnessTranscript = {
  duration: 720,
  cues: [
    { time: 0, text: "Transcript about architecture." },
    { time: 180, text: "Next, the architecture itself." },
    { time: 360, text: "Next, tradeoffs between battery life and comfort." },
    { time: 540, text: "Next, the conclusion." },
  ],
  title: "Architecture talk",
};

// The chapters the code names when the model does not name them. `model` holds the titles the model did write, by
// chapter; the other chapters keep their keyword titles.
function assertKeywordChapters(app, model = []) {
  const chapters = JSON.parse(JSON.stringify(app.calls.at(-1).args[0]));
  assert.deepEqual(
    chapters.map((chapter) => chapter.timestamp),
    [0, 180, 360, 540],
  );
  const named = app.nameChapters(
    app.sectionCues(harnessTranscript, [0, 180, 360, 540]),
    harnessTranscript.title,
  );
  assert.deepEqual(
    chapters.map((chapter) => chapter.title),
    named.map((title, index) => model[index] ?? title),
  );
  assert.ok(chapters.every((chapter) => chapter.title.length >= 3 && chapter.title.length <= 60));
}

for (const [chapterState, message] of [
  [{ native: false }, ""],
  [{ native: true }, "Video already has chapters"],
]) {
  test(`opening popup with ${JSON.stringify(chapterState)} shows its chapter state without generation`, async () => {
    const app = popup({ chapterState });
    await app.ready;
    assert.equal(app.label.textContent, "Generate chapters");
    assert.equal(app.status.textContent, message);
    assert.equal(app.button.disabled, false);
    await tick();
    // The model starts loading on open, but nothing is generated.
    assert.equal(app.sessions.length, 1);
    assert.equal(app.prompted(), 0);
    assert.equal(app.inspections.length, 1);
    assert.equal(app.inspections[0].args[0], "original-video");
    assert.equal(app.inspections[0].func, app.readChapterState);
  });
}

test("opening the popup on a video starts the model early and the click reuses it", async () => {
  const app = popup();
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 1);
  assert.equal(app.prompted(), 0);
  assert.equal(app.destroyed(), 0);
  await app.click();
  assert.equal(app.body.dataset.state, "success");
  assert.equal(app.sessions.length, 1);
  assert.equal(app.prompted(), 1);
  assert.equal(app.sessions[0].destroyed, 1);
  assert.equal(app.clones[0].destroyed, 1);
  // Generation's cleanup aborts the early session's controller too, after the session was used.
  assert.equal(app.sessions[0].signal.aborted, true);
});

test("closing the popup without a click destroys the early session", async () => {
  const app = popup();
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 1);
  app.close();
  await tick();
  assert.equal(app.destroyed(), 1);
});

// Generation runs in the service worker, so a popup closed at any point of a run still gets its chapters.
for (const [stage, option] of [
  ["the early session loads", "modelReady"],
  ["the transcript loads", "transcriptReady"],
  ["Nano writes titles", "promptReady"],
]) {
  test(`closing the popup while ${stage} still draws the chapters`, async () => {
    const wait = deferred();
    const app = popup({ [option]: wait.promise });
    await app.ready;
    app.click();
    await tick();
    app.close();
    await tick();
    assert.equal(app.sessions[0].signal.aborted, false, "the run keeps the model it waits for");
    wait.resolve();
    await tick();
    assert.equal(app.calls.length, 2);
    assert.equal(app.calls[1].func, app.renderer);
    assert.equal(JSON.parse(JSON.stringify(app.calls[1].args[0]))[0].title, "Generated opening");
    assert.equal(app.sessions.length, 1);
    assert.equal(app.destroyed(), 1);
    assert.equal(app.timers.size, 0);
  });
}

test("a popup opened during a run shows it working, follows it to the end and starts no second run", async () => {
  const titles = deferred();
  const app = popup({ promptReady: titles.promise, transcriptResult: harnessTranscript });
  await app.ready;
  app.click();
  await tick();
  app.close();
  const watching = app.reopen();
  await watching.ready;
  assert.equal(watching.body.dataset.state, "working");
  assert.equal(watching.button.disabled, true);
  assert.equal(watching.label.textContent, "Generating chapters");
  // A click before the popup has read the tab joins the run too.
  const clicking = app.reopen();
  clicking.click();
  await tick();
  titles.resolve();
  await tick();
  assertSuccess(watching);
  assertSuccess(clicking);
  assert.equal(app.calls.filter((call) => call.func === app.renderer).length, 1);
  assert.equal(app.prompted(), 1);
  assert.equal(app.sessions.length, 1, "a popup that finds a run loads no model of its own");
});

test("a popup opened on chapters an earlier run drew shows them added and names them again", async () => {
  const app = popup({ chapterState: { native: false, added: true } });
  await app.ready;
  assertSuccess(app);
  await app.click();
  assertSuccess(app);
  assert.equal(app.prompted(), 1);
});

test("a reloaded tab draws its kept chapters again once YouTube has built the player", async () => {
  const app = popup({ restoreResults: [{ error: "Video still loading" }, { count: 4 }] });
  await app.ready;
  const restores = () => app.calls.filter((call) => call.args[0] === null);
  app.tabUpdated({ status: "loading" }, { url: "https://www.youtube.com/watch?v=original-video" });
  // Chrome gives no URL for a tab the extension can no longer reach.
  app.tabUpdated({ status: "complete" }, {});
  await tick();
  assert.equal(restores().length, 0);
  app.tabUpdated({ status: "complete" }, { url: "https://www.youtube.com/watch?v=original-video" });
  await tick();
  assert.equal(restores().length, 1);
  assert.equal(restores()[0].func, app.renderer);
  assert.equal(restores()[0].world, "MAIN");
  assert.equal(restores()[0].target.tabId, 42);
  const [id, retry] = [...app.timers].find(([, timer]) => timer.delay === 500);
  app.timers.delete(id);
  retry.callback();
  await tick();
  assert.equal(restores().length, 2);
  assert.ok(
    ![...app.timers.values()].some((timer) => timer.delay === 500),
    "drawn chapters end the retries",
  );
});

test("a worker that stops mid-run ends the popup's run with the general error", async () => {
  const transcript = deferred();
  const app = popup({ transcriptReady: transcript.promise });
  await app.ready;
  const run = app.click();
  await tick();
  assert.equal(app.body.dataset.state, "working");
  app.stopWorker();
  await run;
  assertRetry(app, /Couldn't generate chapters/);
});

test("closing the popup without a click while the early session loads aborts it", async () => {
  const model = deferred();
  const app = popup({ modelReady: model.promise });
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 1);
  app.close();
  await tick();
  assert.equal(app.sessions[0].signal.aborted, true);
  model.resolve();
  await tick();
  assert.equal(app.destroyed(), 1);
});

for (const [name, options] of [
  ["a blocked video", { chapterState: { blocked: "Video too short" } }],
  ["a downloadable model", { availability: "downloadable" }],
  ["an unavailable model", { availability: "unavailable" }],
  ["a missing Prompt API", { missingApi: true }],
]) {
  test(`opening the popup on ${name} does not start the model`, async () => {
    const app = popup(options);
    await app.ready;
    await tick();
    assert.equal(app.sessions.length, 0);
  });
}

test("an early session that fails to name chapters falls back to keyword titles", async () => {
  const app = popup();
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 1);
  app.sessions[0].promptStreaming = async function* () {
    throw new Error("stale");
  };
  await app.click();
  assert.equal(app.sessions.length, 1, "the failed session is not replaced by a second one");
  assertSuccess(app);
  assertKeywordChapters(app);
  assert.equal(app.destroyed(), 1);
});

test("late chapter inspection cannot replace generation or its result", async () => {
  const inspection = deferred();
  const prompt = deferred();
  const app = popup({
    inspectionReady: inspection.promise,
    promptReady: prompt.promise,
    chapterState: { native: true },
  });
  const run = app.click();
  assert.equal(app.button.disabled, true);
  assert.equal(app.label.textContent, "Generating chapters");
  assert.equal(app.status.textContent, "");
  await tick();
  prompt.resolve();
  await run;
  inspection.resolve();
  await app.ready;
  assertSuccess(app);
});

test("chapter inspection failures show concise feedback and allow retry", async () => {
  const app = popup({
    inspectionError: new Error("Cannot access contents of the page. Long browser explanation."),
  });
  await app.ready;
  assertRetry(app, /Can't access this video/);
  await app.click();
  assert.equal(app.body.dataset.state, "success");
});

test("chapter detection requires structured chapters for the current video", () => {
  const app = popup();
  const chapters = [
    { chapterRenderer: { title: { simpleText: "Introduction" }, timeRangeStartMillis: 0 } },
    {
      chapterRenderer: {
        title: { runs: [{ text: "Main " }, { text: "topic" }] },
        timeRangeStartMillis: 65000,
      },
    },
  ];
  const watchNext = (markersMap, videoId = "original-video") => ({
    currentVideoEndpoint: { watchEndpoint: { videoId } },
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: { multiMarkersPlayerBarRenderer: { markersMap } },
          },
        },
      },
    },
  });
  const markers = (value = chapters, key = "DESCRIPTION_CHAPTERS") => [
    { key, value: { chapters: value } },
  ];
  const detect = ({
    next = watchNext(markers()),
    playerId = "original-video",
    videoId = "original-video",
    title = "In this video",
    drawn = false,
  } = {}) =>
    vm.runInNewContext(`(${app.readChapterState.toString()})("original-video")`, {
      URL,
      location: { href: `https://www.youtube.com/watch?v=${videoId}` },
      // Chapters this extension drew leave their cleanup on the page.
      window: drawn ? { __nanoChaptersCleanup() {} } : {},
      document: {
        querySelector: (selector) =>
          selector === "#movie_player"
            ? {
                getPlayerResponse: () => ({
                  videoDetails: { videoId: playerId },
                  captions: { playerCaptionsTracklistRenderer: { captionTracks: [{}] } },
                }),
                ...(next === null ? {} : { getWatchNextResponse: () => next }),
              }
            : null,
        querySelectorAll: () => [{ textContent: title, closest: () => ({ disabled: false }) }],
      },
    });

  assert.equal(
    detect({ next: watchNext(undefined) }).native,
    false,
    "Timeline-only video is not chaptered",
  );
  assert.equal(
    detect({ title: "" }).native,
    true,
    "chapters do not depend on a visible player title",
  );
  assert.equal(detect({ next: watchNext(markers(chapters, "AUTO_CHAPTERS")) }).native, true);
  // Chapters this extension drew are reported apart from the video's own.
  assert.deepEqual(JSON.parse(JSON.stringify(detect())), {
    native: true,
    blocked: "",
    transcript: true,
    added: false,
  });
  assert.equal(detect({ drawn: true }).added, true);
  assert.equal(
    detect({ next: watchNext(markers(), "previous-video") }).native,
    false,
    "stale watch data",
  );
  assert.equal(detect({ playerId: "previous-video" }).native, false, "stale player data");
  assert.equal(detect({ videoId: "different-video" }), null);

  for (const next of [
    null,
    {},
    watchNext({}),
    watchNext([null]),
    watchNext([{ key: "HEATSEEKER", value: { heatmap: {} } }]),
  ]) {
    assert.equal(
      detect({ next }).native,
      false,
      "missing or unrelated metadata is not chapter evidence",
    );
  }
  for (const invalid of [
    undefined,
    {},
    [],
    chapters.slice(0, 1),
    [null, null],
    chapters.toReversed(),
    [chapters[0], chapters[0]],
    [chapters[0], { chapterRenderer: { title: { simpleText: " " }, timeRangeStartMillis: 65000 } }],
    [chapters[0], { chapterRenderer: { title: { runs: {} }, timeRangeStartMillis: 65000 } }],
    [
      chapters[0],
      { chapterRenderer: { title: { simpleText: "Topic" }, timeRangeStartMillis: "65000" } },
    ],
    [
      chapters[0],
      { chapterRenderer: { title: { simpleText: "Topic" }, timeRangeStartMillis: NaN } },
    ],
  ]) {
    assert.equal(
      detect({ next: watchNext([{ value: { chapters: invalid } }]) }).native,
      false,
      "invalid chapter list",
    );
  }
});

test("a video without a transcript disables generation before a click", async () => {
  const app = popup({ chapterState: { blocked: "", native: false, transcript: false } });
  await app.ready;
  await tick();
  assert.equal(app.body.dataset.state, "unavailable");
  assert.equal(app.label.textContent, "Video has no transcript");
  assert.equal(app.button.disabled, true);
  assert.equal(app.status.textContent, "");
  await app.click();
  assert.equal(app.sessions.length, 0, "no model loads for a video it cannot name");
  assert.equal(app.calls.length, 0);
});

test("a short video disables generation before a click", async () => {
  const app = popup({ chapterState: { blocked: "Video too short" } });
  await app.ready;
  assert.equal(app.label.textContent, "Generate chapters");
  assert.equal(app.button.disabled, true);
  assert.equal(app.status.textContent, "Video too short");
  assert.equal(app.body.dataset.state, "blocked");
  await app.click();
  assert.equal(app.sessions.length, 0);
  assert.equal(app.timers.size, 0);
});

test("a short video discovered during generation disables another attempt", async () => {
  const app = popup({ transcriptResult: { duration: 3, cues: [{ time: 0, text: "Short" }] } });
  await app.ready;
  await app.click();
  assert.equal(app.label.textContent, "Generate chapters");
  assert.equal(app.button.disabled, true);
  assert.equal(app.status.textContent, "Video too short");
  assert.equal(app.prompted(), 0);
  assert.equal(app.destroyed(), 1);
});

test("ad completion restores generation and the native chapter notice without generating", async () => {
  const chapterState = { blocked: "Wait for the ad to finish", native: true };
  const app = popup({ chapterState });
  await app.ready;
  assert.equal(app.button.disabled, true);
  assert.equal(app.label.textContent, "Generate chapters");
  assert.equal(app.body.dataset.state, "blocked");
  await app.checkAd();
  assert.equal(app.button.disabled, true);
  chapterState.blocked = "";
  await app.checkAd();
  assert.equal(app.button.disabled, false);
  assert.equal(app.label.textContent, "Generate chapters");
  assert.equal(app.status.textContent, "Video already has chapters");
  await tick();
  // The model starts early once the ad ends, without generating.
  assert.equal(app.sessions.length, 1);
  assert.equal(app.prompted(), 0);
  assert.equal(app.timers.size, 0);
});

test("an ad encountered on click recovers after model cleanup", async () => {
  const app = popup({ transcriptResultError: "Wait for the ad to finish" });
  await app.ready;
  await app.click();
  assert.equal(app.button.disabled, true);
  assert.equal(app.body.dataset.state, "blocked");
  assert.equal(app.label.textContent, "Generate chapters");
  assert.match(app.status.textContent, /ad to finish/);
  assert.equal(app.prompted(), 0);
  assert.equal(app.calls.length, 1);
  assert.equal(app.destroyed(), 1);
  await app.checkAd();
  assert.equal(app.button.disabled, false);
  assert.equal(app.label.textContent, "Generate chapters");
  assert.equal(app.timers.size, 0);
  await tick();
  // The first click used the early model, so the next click gets a fresh one.
  assert.equal(app.sessions.length, 2);
});

for (const checkingAd of [false, true]) {
  test(`closing during ${checkingAd ? "ad recheck" : "startup"} tab lookup prevents page inspection`, async () => {
    const lookup = deferred();
    const options = checkingAd
      ? { chapterState: { blocked: "Wait for the ad to finish" } }
      : { tabReady: lookup.promise };
    const app = popup(options);
    if (checkingAd) {
      await app.ready;
      options.tabReady = lookup.promise;
    }
    const checking = checkingAd ? app.checkAd() : app.ready;
    await tick();
    const inspectionsBeforeClose = app.inspections.length;
    app.close();
    lookup.resolve();
    await checking;
    assert.equal(app.inspections.length, inspectionsBeforeClose);
    assert.equal(app.sessions.length, 0);
    assert.equal(app.timers.size, 0);
  });
}

test("closing the popup stops pending and in-flight ad rechecks", async () => {
  const options = { chapterState: { blocked: "Wait for the ad to finish" } };
  const app = popup(options);
  await app.ready;
  const inspection = deferred();
  options.inspectionReady = inspection.promise;
  const checking = app.checkAd();
  await tick();
  app.close();
  inspection.resolve();
  await checking;
  assert.equal(app.timers.size, 0);

  const pending = popup({ chapterState: { blocked: "Wait for the ad to finish" } });
  await pending.ready;
  pending.close();
  assert.equal(pending.timers.size, 0);
});

test("the production detector distinguishes ad duration from a short loaded video", () => {
  const app = popup();
  const detect = (
    ad,
    duration,
    videoId = "original-video",
    captions = { playerCaptionsTracklistRenderer: { captionTracks: [{}] } },
  ) =>
    vm.runInNewContext(`(${app.readChapterState.toString()})("original-video")`, {
      URL,
      location: { href: "https://www.youtube.com/watch?v=original-video" },
      window: {},
      document: {
        querySelector: (selector) =>
          selector === "#movie_player"
            ? {
                classList: { contains: () => ad },
                getDuration: () => duration,
                getPlayerResponse: () => ({ videoDetails: { videoId }, captions }),
              }
            : null,
        querySelectorAll: () => [],
      },
    });
  assert.equal(detect(true, 3).blocked, "Wait for the ad to finish");
  assert.equal(detect(false, 3).blocked, "Video too short");
  assert.equal(detect(false, 4).blocked, "");
  assert.equal(detect(false, 0).blocked, "");
  assert.equal(detect(false, 3, "previous-video").blocked, "");
  // Only the player's data for this video can say it has no captions; a player still on another video blocks nothing.
  assert.equal(detect(false, 600).transcript, true);
  assert.equal(detect(false, 600, "original-video", null).transcript, false);
  assert.equal(
    detect(false, 600, "original-video", { playerCaptionsTracklistRenderer: { captionTracks: [] } })
      .transcript,
    false,
  );
  assert.equal(detect(false, 600, "previous-video", null).transcript, true);
});

test("a click sends validated model output to the production renderer for the original video", async () => {
  const app = popup();
  await app.ready;
  await app.click();
  assert.equal(app.prompted(), 1);
  assert.match(app.prompts[0].text, /Transcript about architecture/);
  assert.equal(app.sessions.length, 1);
  assert.equal(app.calls.length, 2);
  const [transcript, injection] = app.calls;
  assert.equal(transcript.args[0], "original-video");
  assert.equal(injection.func, app.renderer);
  assert.equal(injection.world, "MAIN");
  assert.equal(injection.target.tabId, 42);
  assert.equal(injection.args[1], "original-video");
  assert.deepEqual(JSON.parse(JSON.stringify(injection.args[0])), [
    { timestamp: 0, title: "Generated opening" },
    { timestamp: 180, title: "Generated architecture" },
    { timestamp: 360, title: "Generated tradeoffs of battery & comfort" },
    { timestamp: 540, title: "Generated conclusion" },
  ]);
  assertSuccess(app);
  assert.equal(app.errors.length, 0);
  // The titles came from a copy of the session, released after use; the early session's loading was cancelled with the run.
  assert.equal(app.clones.length, 1);
  assert.equal(app.clones[0].destroyed, 1);
  assert.equal(app.sessions[0].signal.aborted, true);
  assert.deepEqual(
    [...app.prompts[0].options.responseConstraint.required],
    ["chapter1", "chapter2", "chapter3", "chapter4"],
  );
  assert.equal(app.prompts[0].options.responseConstraint.properties.chapter1.maxLength, 40);
  assert.equal(app.prompts[0].options.omitResponseConstraintInput, true);
  assert.match(app.prompts[0].text, /The video is titled "Architecture talk"/);
  assert.equal(app.sessions[0].destroyed, 1);
  assert.equal(app.timers.size, 0);
});

test("popup reports a renderer rejection and releases the model for retry", async () => {
  const app = popup({ rendererError: new Error("Video changed") });
  await app.ready;
  await app.click();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[1].func, app.renderer);
  assertRetry(app, /Video changed/);
  assert.equal(app.errors.length, 1);
  assert.equal(app.destroyed(), 1);
});

test("transcript rejection releases an already created model without prompting", async () => {
  const app = popup({ transcriptError: new Error("The video tab closed") });
  await app.ready;
  await app.click();
  assert.equal(app.calls.length, 1);
  assert.equal(app.prompted(), 0);
  assertRetry(app, /Couldn't generate chapters/);
  assert.equal(app.destroyed(), 1);
});

test("a failure without a message still reports failure", async () => {
  const app = popup({ transcriptError: new Error("") });
  await app.ready;
  await app.click();
  assertRetry(app, /Couldn't generate chapters/);
});

for (const [name, transcriptResult, message] of [
  ["serialized error", { error: "Wait for the ad to finish" }, /ad to finish/],
  // The popup names a missing transcript before the click; one found missing after it is an ordinary failure.
  ["missing transcript", null, /Couldn't generate chapters/],
  ["empty transcript", { duration: 2400, cues: [] }, /Couldn't generate chapters/],
]) {
  test(`${name} aborts model preparation before the session is ready`, async () => {
    const model = deferred();
    const app = popup({ modelReady: model.promise, transcriptResult });
    await app.ready;
    await tick();
    assert.equal(app.sessions.length, 1, "the model started loading when the popup opened");
    const run = app.click();
    await tick();
    try {
      if (name === "serialized error") {
        assert.equal(app.body.dataset.state, "blocked");
        assert.equal(app.button.disabled, true);
        assert.match(app.status.textContent, message);
      } else assertRetry(app, message);
      assert.equal(app.prompted(), 0);
      assert.equal(app.destroyed(), 0);
      assert.equal(app.sessions[0].signal.aborted, true);
      assert.equal(
        app.label.textContent,
        name === "serialized error" ? "Generate chapters" : "Try again",
      );
    } finally {
      model.resolve();
      await run;
      await app.modelCreated();
      await tick();
    }
    assert.equal(app.destroyed(), 1);
  });
}

test("serialized renderer error reaches popup feedback and releases the model", async () => {
  const app = popup({ rendererResultError: "Video changed" });
  await app.ready;
  await app.click();
  assertRetry(app, /Video changed/);
  assert.equal(app.calls.length, 2);
  assert.equal(app.destroyed(), 1);
});

test("a late model from a failed attempt cannot overwrite a successful retry", async () => {
  const model = deferred();
  const options = { transcriptError: new Error("The video tab closed"), modelReady: model.promise };
  const app = popup(options);
  await app.ready;
  await tick();
  await app.click();
  assertRetry(app, /Couldn't generate chapters/);
  assert.equal(app.destroyed(), 0);
  delete options.transcriptError;
  delete options.modelReady;
  await app.click();
  assertSuccess(app);
  model.resolve();
  await app.modelCreated();
  await tick();
  // The abandoned session is destroyed when it finally arrives, and only the retry's session named chapters.
  assert.equal(app.destroyed(), 2);
  assert.equal(app.prompted(), 1);
  assertSuccess(app);
});

test("a stalled batch ends 9 seconds after the click and its chapters keep their keyword titles", async () => {
  const prompt = deferred();
  const app = popup({ promptReady: prompt.promise });
  await app.ready;
  const run = app.click();
  await tick();
  assert.equal(app.prompted(), 1);
  assert.equal(app.button.disabled, true);
  assert.equal([...app.timers.values()][0].delay, 9_000);
  app.expireTitles();
  await run;
  assertSuccess(app);
  assertKeywordChapters(app);
  assert.equal(app.prompts[0].options.signal.aborted, true);
  assert.equal(app.clones[0].destroyed, 1);
  assert.equal(app.destroyed(), 1);
  assert.equal(app.calls.length, 2);
  prompt.resolve();
  await tick();
  // The late model output arrives after the chapters were rendered and changes nothing.
  assert.equal(app.calls.length, 2);
  assertSuccess(app);
});

// The run reads the model to decide whether Nano names the chapters, and the popup to decide whether it offers to name
// them again. A click in the popup's first moment waits for both reads rather than deciding without them.
for (const [name, options, usesModel] of [
  ["a model on the device", {}, true],
  ["no model", { availability: "unavailable" }, false],
]) {
  test(`a click during the model reads waits for them, then ${usesModel ? "uses Nano" : "names the chapters in code"}`, async () => {
    const availability = deferred();
    const app = popup({ ...options, availabilityReady: availability.promise });
    const run = app.click();
    await tick();
    assert.equal(app.label.textContent, "Generating chapters");
    assert.equal(app.calls.length, 0, "the run waits for its model read");
    availability.resolve();
    await run;
    assert.equal(app.prompted(), usesModel ? 1 : 0);
    assert.equal(app.calls.length, 2);
    if (usesModel) {
      assert.equal(JSON.parse(JSON.stringify(app.calls[1].args[0]))[0].title, "Generated opening");
    } else assertKeywordChapters(app);
    assertSuccess(app, { modelOnDevice: usesModel });
    assert.deepEqual(app.labels, ["Generate chapters", "Generating chapters", "Chapters added"]);
    await app.ready;
  });
}

for (const availability of ["downloadable", "downloading"]) {
  test(`a ${availability} model is never used, and the chapters are named in code`, async () => {
    const app = popup({ availability });
    await app.ready;
    await tick();
    // A download Chrome is already running reports no progress to this popup, so nothing is said about it.
    assert.equal(app.status.textContent, "");
    assert.equal(app.sessions.length, 0);
    await app.click();
    assert.equal(app.sessions.length, 0);
    assert.equal(app.prompted(), 0);
    assertKeywordChapters(app);
    // Without the model on the device there is nothing to name again, so the button rests.
    assertSuccess(app, { modelOnDevice: false, message: "" });
    assert.equal(app.timers.size, 0, "no generation timeout is armed");
  });
}

// The switch shows wherever Chrome can run the model. Unless the user chose, it is on only where the model is already
// on the device, so nothing downloads unasked.
for (const [name, options, shown, on] of [
  ["a downloadable model", { availability: "downloadable" }, true, false],
  ["a model already on the device", {}, true, true],
  ["a model still downloading", { availability: "downloading" }, true, false],
  ["an unavailable model", { availability: "unavailable" }, false, false],
  ["a missing Prompt API", { missingApi: true }, false, false],
  ["a saved choice to switch off", { stored: { nanoTitles: "off" } }, true, false],
  [
    "a saved choice to switch on",
    { availability: "downloadable", stored: { nanoTitles: "on" } },
    true,
    true,
  ],
]) {
  test(`${name} ${shown ? `shows the switch ${on ? "on" : "off"}` : "hides the switch"}`, async () => {
    const app = popup(options);
    await app.ready;
    await tick();
    assert.equal(app.offer.hidden, !shown);
    assert.equal(app.optIn.checked, on);
    assert.equal(
      app.sessions.length,
      0 + (on && !options.availability ? 1 : 0),
      "only a model on the device warms",
    );
  });
}

test("switching on a downloadable model starts the download and these chapters are still named in code", async () => {
  const app = popup({ availability: "downloadable" });
  await app.ready;
  app.flip(true);
  // Chrome allows the download only from the user's own click on the switch.
  assert.equal(app.sessions.length, 1, "the switch starts the download");
  assert.equal(typeof app.createCalls[0].monitor, "function");
  assert.equal(app.status.textContent, "Downloading model");
  await app.click();
  assert.equal(app.prompted(), 0);
  assertKeywordChapters(app);
  assertSuccess(app, { modelOnDevice: false, message: "Downloading model" });
  await tick();
  assert.equal(app.destroyed(), 1, "the download session is released once Chrome has the model");
});

test("a switch left off downloads nothing", async () => {
  const app = popup({ availability: "downloadable" });
  await app.ready;
  await app.click();
  assert.equal(app.createCalls.length, 0);
  assertSuccess(app, { modelOnDevice: false });
});

test("download progress reaches the status line until the popup closes", async () => {
  const download = deferred();
  const app = popup({ availability: "downloadable", modelReady: download.promise });
  await app.ready;
  app.flip(true);
  const run = app.click();
  app.reportProgress(0.34);
  // A run in progress keeps the screen; the note waits for the state that has room for it.
  assert.equal(app.status.textContent, "");
  await run;
  assertSuccess(app, { modelOnDevice: false, message: "Downloading model 34%" });
  app.reportProgress(0.9);
  assert.equal(app.status.textContent, "Downloading model 90%");
  app.close();
  app.reportProgress(1);
  assert.equal(app.status.textContent, "Downloading model 90%", "a closed popup is not written to");
  // Nothing cancels the download: it must survive the popup that asked for it.
  assert.equal(app.createCalls[0].signal, undefined);
  download.resolve();
  await tick();
  assert.equal(app.destroyed(), 1);
});

test("switching off during the download hides the progress and is remembered", async () => {
  const download = deferred();
  const app = popup({ availability: "downloadable", modelReady: download.promise, stored: {} });
  await app.ready;
  app.flip(true);
  app.reportProgress(0.3);
  assert.equal(app.status.textContent, "Downloading model 30%");
  app.flip(false);
  assert.equal(app.status.textContent, "");
  app.reportProgress(0.4);
  assert.equal(app.status.textContent, "", "late progress is ignored");
  const reopened = app.reopen();
  await reopened.ready;
  assert.equal(reopened.optIn.checked, false, "the choice is remembered");
});

test("download progress never overwrites a failure the user must read", async () => {
  const app = popup({ availability: "downloadable", rendererError: new Error("Video changed") });
  await app.ready;
  app.flip(true);
  await app.click();
  assertRetry(app, /Video changed/);
  app.reportProgress(0.5);
  assert.equal(app.status.textContent, "Video changed", "the error stays on screen");
});

test("switching Nano off with the model on the device names the chapters in code and releases the early model", async () => {
  const app = popup();
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 1);
  app.flip(false);
  await app.click();
  await tick();
  assert.equal(app.prompted(), 0);
  assertKeywordChapters(app);
  // Without Nano a second run would give the same titles, so the button rests.
  assertSuccess(app, { modelOnDevice: false });
  assert.equal(app.destroyed(), 1);
  app.flip(true);
  assertSuccess(app, { modelOnDevice: true });
});

test("a download Chrome refuses fails silently and the chapters are still named", async () => {
  const app = popup({ availability: "downloadable", createError: new Error("Not enough space") });
  await app.ready;
  app.flip(true);
  await app.click();
  assert.equal(app.sessions.length, 0, "no session survived the failed create");
  assert.equal(app.createCalls.length, 1);
  assertKeywordChapters(app);
  assertSuccess(app, { modelOnDevice: false, message: "Downloading model" });
  // A rejected create must not surface as an unhandled rejection or an error on screen.
  await tick();
  assert.equal(app.errors.length, 0);
});

test("a model the browser refuses to start leaves the chapters to the keyword titler", async () => {
  const app = popup({ createError: new Error("Model start failed") });
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 0);
  await app.click();
  assert.equal(app.prompted(), 0);
  assertKeywordChapters(app);
  // The model is on the device, so the button still offers another naming.
  assertSuccess(app);
  assert.equal(app.errors.length, 0);
});

test("a model that goes away after the popup's read leaves the chapters to the keyword titler", async () => {
  const app = popup({ availabilityAfter: "unavailable" });
  await app.ready;
  await tick();
  await app.click();
  assert.equal(app.sessions.length, 0);
  assert.equal(app.prompted(), 0);
  assertKeywordChapters(app);
  assertSuccess(app);
});

test("a failed model availability check still adds keyword chapters", async () => {
  const app = popup({ availabilityError: new Error("Availability check failed") });
  await app.ready;
  assert.equal(app.button.disabled, false);
  await app.click();
  assert.equal(app.sessions.length, 0);
  assert.equal(app.prompted(), 0);
  assert.equal(app.calls.length, 2);
  assertKeywordChapters(app);
  assertSuccess(app, { modelOnDevice: false });
  assert.equal(app.errors.length, 0);
});

// Evaluation runs ask for the model and nothing else, so a missing model stays a failed run.
for (const [name, options] of [
  ["a model that went away", { availability: "unavailable" }],
  ["a missing Prompt API", { missingApi: true }],
  ["a failed availability check", { availabilityError: new Error("Availability check failed") }],
]) {
  test(`${name} fails a run that asked for no keyword titles`, async () => {
    const app = popup(options);
    const run = {
      loadTranscript: async () => harnessTranscript,
      controller: new AbortController(),
      useModel: true,
    };
    await assert.rejects(
      app.generateChapterData(run),
      options.availabilityError || /Gemini Nano unavailable/,
    );
    const { chapters } = await app.generateChapterData({
      ...run,
      controller: new AbortController(),
      fallbackTitles: true,
    });
    assert.deepEqual(
      JSON.parse(JSON.stringify(chapters)).map((chapter) => chapter.timestamp),
      [0, 180, 360, 540],
    );
  });
}

test("model startup and transcript setup spend the click's title budget", async () => {
  const model = deferred();
  const transcript = deferred();
  const prompt = deferred();
  const app = popup({
    modelReady: model.promise,
    transcriptReady: transcript.promise,
    promptReady: prompt.promise,
  });
  await app.ready;
  const run = app.click();
  await tick();
  app.advance(5_000);
  assert.equal(app.timers.size, 0);
  model.resolve();
  await tick();
  assert.equal(app.timers.size, 0);
  transcript.resolve();
  await tick();
  assert.equal(app.prompted(), 1);
  assert.equal([...app.timers.values()][0].delay, 4_000);
  prompt.resolve();
  await run;
  assertSuccess(app);
});

test("duplicate clicks while working start only one generation", async () => {
  const model = deferred();
  const app = popup({ modelReady: model.promise });
  await app.ready;
  const first = app.click();
  await app.click();
  await tick();
  assert.equal(app.sessions.length, 1);
  assert.equal(app.calls.length, 1);
  model.resolve();
  await first;
  assert.equal(app.prompted(), 1);
  assert.equal(app.calls.length, 2);
});

for (const [name, options] of [
  ["missing Prompt API", { missingApi: true }],
  ["unavailable model", { availability: "unavailable" }],
]) {
  test(`${name} names the chapters in code and never mentions Gemini Nano`, async () => {
    const app = popup(options);
    await app.ready;
    assert.equal(app.offer.hidden, true, "nothing to switch on");
    await app.click();
    assertKeywordChapters(app);
    assertSuccess(app, { modelOnDevice: false });
    assert.equal(app.sessions.length, 0);
    assert.equal(app.calls.length, 2);
    assert.equal(app.errors.length, 0);
    assert.ok(!app.labels.some((text) => /Nano|Chrome AI/.test(text)), app.labels.join(" | "));
  });
}

for (const [name, options, message] of [
  ["no active tab", { tab: null }, /Open a YouTube video/],
  [
    "non-YouTube tab",
    { tab: { id: 42, url: "https://example.com/watch?v=test" } },
    /Open a YouTube video/,
  ],
  [
    "empty video id",
    { tab: { id: 42, url: "https://www.youtube.com/watch?v=" } },
    /Open a YouTube video/,
  ],
  [
    "insecure page",
    { tab: { id: 42, url: "http://www.youtube.com/watch?v=test" } },
    /Open a YouTube video/,
  ],
]) {
  test(`${name} disables generation with a readable explanation before model creation`, async () => {
    const app = popup(options);
    await app.ready;
    if (options.tab !== undefined) {
      assert.equal(app.label.textContent, "Open a YouTube video");
      assert.equal(app.button.disabled, true);
      assert.equal(app.status.textContent, "");
      assert.equal(app.inspections.length, 0);
    }
    await app.click();
    if (options.tab !== undefined) {
      assert.equal(app.body.dataset.state, "unavailable");
      assert.equal(app.label.textContent, "Open a YouTube video");
      assert.equal(app.button.disabled, true);
      assert.equal(app.status.textContent, "");
    } else {
      assert.equal(app.body.dataset.state, "blocked");
      assert.equal(app.button.disabled, true);
      assert.equal(app.label.textContent, "Generate chapters");
      assert.match(app.status.textContent, message);
    }
    assert.equal(app.sessions.length, 0);
    assert.equal(app.calls.length, 0);
  });
}

test("sparse captions give fewer chapters instead of invented starts", async () => {
  const app = popup({
    transcriptResult: {
      duration: 720,
      cues: [{ time: 0, text: "Only opening words" }],
      title: "Sparse talk",
    },
  });
  await app.ready;
  await app.click();
  assert.equal(app.body.dataset.state, "success");
  assert.deepEqual([...app.prompts[0].options.responseConstraint.required], ["chapter1"]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[1].args[0])), [
    { timestamp: 0, title: "Generated opening" },
  ]);
  assert.equal(app.destroyed(), 1);
});

const generatedTitles = Object.fromEntries(
  Object.entries(generated).map(([key, chapter]) => [key, chapter.title]),
);
const modelTitles = Object.values(generatedTitles).map((title) => title.trim());
for (const [name, options, keyword] of [
  [
    "missing title key",
    { titleRaw: JSON.stringify({ ...generatedTitles, chapter2: undefined }) },
    [1],
  ],
  [
    "extra title key",
    { titleRaw: JSON.stringify({ ...generatedTitles, chapter5: "Unexpected chapter" }) },
    [],
  ],
  ["wrong title type", { titleRaw: JSON.stringify({ ...generatedTitles, chapter2: 123 }) }, [1]],
  ["blank title", { titleRaw: JSON.stringify({ ...generatedTitles, chapter2: "   " }) }, [1]],
  [
    "oversized title",
    { titleRaw: JSON.stringify({ ...generatedTitles, chapter2: "x".repeat(61) }) },
    [1],
  ],
  [
    "narrative outside JSON",
    { titleRaw: "Here are the chapters: " + JSON.stringify(generatedTitles) },
    [],
  ],
  ["a model failure", { titleError: new Error("Model failed") }, [0, 1, 2, 3]],
]) {
  // Every usable title counts on its own; a chapter without one keeps its keyword title rather than failing the run.
  test(`title step with ${name} keeps the usable model titles and keyword titles for the rest`, async () => {
    const app = popup(options);
    await app.ready;
    await app.click();
    assertSuccess(app);
    assertKeywordChapters(
      app,
      modelTitles.map((title, index) => (keyword.includes(index) ? undefined : title)),
    );
    assert.equal(app.prompted(), 1);
    assert.equal(app.calls.length, 2);
    assert.equal(app.destroyed(), 1);
  });
}

test("a run of whitespace ends the batch and keeps the titles finished before it", async () => {
  const app = popup({
    titleRaw: [
      `{"chapter1": "${modelTitles[0]}", "chapter2": "${modelTitles[1]}",`,
      "\n".repeat(12),
      "\n".repeat(12),
      '"chapter3": "Late title"}',
    ],
  });
  await app.ready;
  await app.click();
  assertSuccess(app);
  // The 24th whitespace character in a row ends the stream, so the title after it is never read.
  assertKeywordChapters(app, modelTitles.slice(0, 2));
  assert.equal(app.prompts[0].options.signal.aborted, true);
  assert.equal(app.clones[0].destroyed, 1);
});

test("titles are asked eight chapters at a time, each batch in its own copy of the session", async () => {
  const transcriptResult = {
    duration: 2400,
    cues: Array.from({ length: 160 }, (_, index) => ({
      time: index * 15,
      text: `Next, topic ${index}.`,
    })),
    title: "Long talk",
  };
  const app = popup({ transcriptResult });
  await app.ready;
  await app.click();
  assertSuccess(app);
  const starts = [...app.selectStarts(transcriptResult)];
  assert.equal(starts.length, 16);
  assert.deepEqual(
    app.prompts.map((prompt) => prompt.options.responseConstraint.required.length),
    [8, 8],
  );
  assert.match(
    app.prompts[0].text,
    new RegExp(`chapter8 contains ONLY ${starts[7]}-${starts[8]} seconds`),
  );
  assert.match(app.prompts[1].text, new RegExp(`chapter1 contains ONLY ${starts[8]}-`));
  assert.deepEqual(
    app.clones.map((clone) => clone.destroyed),
    [1, 1],
  );
  assert.equal(app.destroyed(), 1);
  // The second batch's chapter1 is the video's ninth chapter. Keyword phrases a model title lacks follow a colon.
  const chapters = JSON.parse(JSON.stringify(app.calls[1].args[0]));
  assert.deepEqual(
    chapters.map((chapter) => chapter.timestamp),
    starts,
  );
  const batch = (count) =>
    Array.from(
      { length: count },
      (_, index) => modelTitles[index] ?? `Generated part ${index + 1}`,
    );
  assert.deepEqual(
    chapters.map((chapter) => chapter.title.split(": ")[0]),
    [...batch(8), ...batch(8)],
  );
});

test("a single JSON fence is accepted without repairing title contents", async () => {
  const app = popup({ titleRaw: "```json\n" + JSON.stringify(generatedTitles) + "\n```" });
  await app.ready;
  await app.click();
  assertSuccess(app);
  assert.equal(app.calls[1].args[0][1].title, generated.chapter2.title);
});

test("title sections contain their selected spans and exclude the next section", () => {
  const app = popup();
  const prompt = app.buildTitlePrompt(
    [
      { time: 0, text: "Opening evidence" },
      { time: 50, text: "Transition evidence" },
      { time: 99, text: "Closing evidence" },
    ],
    100,
    [0, 50],
  );
  const firstSection = prompt.split("chapter1 contains ONLY")[1].split("chapter2 contains ONLY")[0];
  assert.match(firstSection, /Opening evidence/);
  assert.doesNotMatch(firstSection, /Transition evidence|Closing evidence/);
  assert.match(
    prompt.split("chapter2 contains ONLY")[1],
    /Transition evidence[\s\S]*Closing evidence/,
  );
});

test("dense transcripts keep a full batch's title prompt bounded", () => {
  const app = popup();
  const cues = Array.from({ length: 7200 }, (_, time) => ({
    time,
    text: "Dense caption content ".repeat(100),
  }));
  const batch = Array.from({ length: 8 }, (_, index) => index * 900);
  assert.ok(app.buildTitlePrompt(cues, 7200, batch).length < 11_000);
});

test("title sections show a short section whole and sample a long one evenly from its start to its end", () => {
  const app = popup();
  const cues = Array.from({ length: 40 }, (_, index) => ({
    time: index * 5,
    text: `Cue ${index}`,
  }));
  const lines = app
    .buildTitlePrompt(cues, 200, [0])
    .split("chapter1 contains ONLY 0-200 seconds:\n")[1]
    .split("\n");
  // A section that fits is shown whole, its captions joined in runs of about the same length.
  const run = (part) => part.map((cue) => cue.text).join(" ");
  assert.deepEqual(lines, [`0s ${run(cues.slice(0, 21))}`, `105s ${run(cues.slice(21))}`]);
  const long = Array.from({ length: 400 }, (_, index) => ({
    time: index * 5,
    text: `Cue ${index} says a few more words about this part`,
  }));
  const times = app
    .buildTitlePrompt(long, 2000, [0])
    .split("seconds:\n")[1]
    .split("\n")
    .map((line) => parseInt(line));
  // A long section shows runs that start at about even steps, so its end reaches the model as often as its start.
  assert.equal(times[0], 0);
  assert.ok(times.at(-1) >= 1900, `${times}`);
  assert.ok(
    times
      .slice(1)
      .every((time, index) => Math.abs(time - times[index] - 2000 / times.length) <= 10),
    `${times}`,
  );
});

test("chapter count follows duration and starts stay half an average chapter apart, with the first allowed from 60 s", () => {
  const app = popup();
  // Every caption announces a topic, so only duration and spacing limit the choice.
  const transcript = (duration) => ({
    duration,
    cues: Array.from({ length: Math.ceil(duration / 15) }, (_, index) => ({
      time: index * 15,
      text: `Next, topic ${index}.`,
    })),
  });
  // 3.86 x minutes^0.355 rounds from 8 to 9 at 555 s. At 2400 s it gives 14, but chapters are added until the average
  // is at most 150 s: 16. From 2880 s that takes 20, the most.
  for (const [duration, count] of [
    [60, 4],
    [554, 8],
    [555, 9],
    [2400, 16],
    [2880, 20],
    [3600, 20],
    [7200, 20],
  ]) {
    const starts = app.selectStarts(transcript(duration));
    assert.equal(starts.length, count, `${duration}`);
    assert.equal(starts[0], 0);
    const gap = duration / count / 2;
    starts.slice(1).forEach((start, index) => {
      assert.ok(
        start - starts[index] >= (index ? gap : Math.min(gap, 60)) && start <= duration - gap,
        `${duration}: ${starts}`,
      );
    });
    // Creators often end an intro at about a minute, so the first start may sit there on long videos.
    if (duration === 3600) assert.equal(starts[1], 60);
  }
});

test("starts prefer announced topic changes over continuing captions", () => {
  const app = popup();
  const filler = [
    "and the same part keeps going here",
    "with more of the same example text",
    "still about the same part of this story",
  ];
  const cues = Array.from({ length: 48 }, (_, index) => ({
    time: index * 15,
    text: filler[index % 3],
  }));
  for (const [time, text] of [
    [165, "Next, let's talk about batteries."],
    [390, "Moving on to the camera."],
    [570, "Finally, the verdict."],
  ]) {
    cues.find((cue) => cue.time === time).text = text;
  }
  // Twelve minutes get nine chapters, so continuing captions fill the starts the announcements leave.
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.equal(starts.length, 9);
  assert.ok(
    [165, 390, 570].every((time) => starts.includes(time)),
    `${starts}`,
  );
});

test("starts ignore captions that only look like announcements or questions", () => {
  const app = popup();
  // Punctuated filler keeps these decoys on the punctuated path; unpunctuated captions ignore line-start openers.
  const filler = [
    "and the same part keeps going here.",
    "with more of the same example text.",
    "still about the same part of this story.",
  ];
  for (const decoy of [
    "Now, if the same part keeps going here",
    "So what is the same part keeps going",
    "and the same part keeps going, right?",
    "[music] and the same part keeps going here",
  ]) {
    const cues = Array.from({ length: 48 }, (_, index) => ({
      time: index * 15,
      text: filler[index % 3],
    }));
    for (const [time, text] of [
      [165, "Next, let's talk about batteries."],
      [390, "Moving on to the camera."],
      [570, decoy],
    ]) {
      cues.find((cue) => cue.time === time).text = text;
    }
    const starts = app.selectStarts({ duration: 720, cues });
    assert.ok(
      starts.includes(165) && starts.includes(390) && !starts.includes(570),
      `${decoy}: ${starts}`,
    );
  }
});

test("a speaker turn that opens with a real question starts a chapter", () => {
  const app = popup();
  // The turn reuses the filler's words, so only its question, not new vocabulary, can make it a start.
  for (const [end, asked] of [
    ["?", true],
    [".", false],
  ]) {
    const cues = Array.from({ length: 48 }, (_, index) => ({
      time: index * 15,
      text: "and the same part keeps going here",
    }));
    for (const [time, text] of [
      [165, "Next, let's talk about batteries."],
      [390, "Moving on to the camera."],
      [495, "- Did pricing change later?"],
      [570, "- Why does the same part keep going"],
      [585, `here after all this time${end}`],
    ]) {
      cues.find((cue) => cue.time === time).text = text;
    }
    const starts = [...app.selectStarts({ duration: 720, cues })];
    assert.ok(starts.includes(570) === asked && !starts.includes(495), `${end}: ${starts}`);
  }
});

test("a section marker inside a long caption starts a chapter at its own sentence", () => {
  const app = popup();
  const cues = Array.from({ length: 48 }, (_, index) => ({
    time: index * 15,
    text: "and the same part keeps going here",
  }));
  for (const [time, text] of [
    [165, "Next, let's talk about batteries."],
    [390, "Moving on to the camera."],
  ]) {
    cues.find((cue) => cue.time === time).text = text;
  }
  // Auto-generated captions hold several sentences; "Part three." sits 30 of 60 characters into a 15-second caption.
  cues.find((cue) => cue.time === 555).text =
    "the same part keeps going. Part three. The verdict here.";
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.ok(
    [165, 390, 562].every((time) => starts.includes(time)) && !starts.includes(555),
    `${starts}`,
  );
  const sections = app
    .splitAtStarts(cues, 720, starts)
    .filter((cue) => cue.time >= 555 && cue.time < 570);
  assert.deepEqual(
    sections.map((cue) => [cue.time, cue.text]),
    [
      [555, "the same part keeps going."],
      [562, "Part three. The verdict here."],
    ],
  );
});

test("step openings and questions inside a caption do not start chapters", () => {
  const app = popup();
  const filler = [
    "and the same part keeps going here",
    "with more of the same example text",
    "still about the same part of this story",
  ];
  for (const inside of [
    "Let's go back to the beginning.",
    "Now I can play it.",
    "So what did he do?",
    "Okay, so we keep going.",
  ]) {
    const cues = Array.from({ length: 48 }, (_, index) => ({
      time: index * 15,
      text: filler[index % 3],
    }));
    for (const [time, text] of [
      [165, "Next, let's talk about batteries."],
      [390, "Moving on to the camera."],
      [555, `the same part keeps going. ${inside}`],
    ]) {
      cues.find((cue) => cue.time === time).text = text;
    }
    const starts = app.selectStarts({ duration: 720, cues });
    assert.ok(
      starts.every((start) => start < 555 || start >= 570),
      `${inside}: ${starts}`,
    );
  }
});

test("in unpunctuated captions a section word or topic turn starts a chapter at its own word, even across lines", () => {
  const app = popup();
  const cues = Array.from({ length: 240 }, (_, index) => ({
    time: index * 3,
    text: "and the same part keeps going here",
  }));
  // "step number two" begins 30 of 34 characters into the 3-second line at 165 and ends on the next line.
  cues.find((cue) => cue.time === 165).text = "and the same part keeps going step";
  cues.find((cue) => cue.time === 168).text = "number two is the battery test";
  cues.find((cue) => cue.time === 390).text = "so speaking of the camera lens";
  cues.find((cue) => cue.time === 570).text = "my final point is the verdict";
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.ok(
    [167, 390, 570].every((time) => starts.includes(time)) &&
      !starts.includes(165) &&
      !starts.includes(168),
    `${starts}`,
  );
});

test("in unpunctuated captions an opener at a line start does not announce", () => {
  const app = popup();
  const cues = Array.from({ length: 240 }, (_, index) => ({
    time: index * 3,
    text: "and the same part keeps going here",
  }));
  cues.find((cue) => cue.time === 165).text = "moving on to the battery";
  cues.find((cue) => cue.time === 390).text = "let's talk about the camera";
  // A width break put "next" at the start of a line in the middle of a sentence.
  cues.find((cue) => cue.time === 567).text = "and the same part keeps going and";
  cues.find((cue) => cue.time === 570).text = "next to it the same part keeps";
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.ok(starts.includes(165) && starts.includes(390) && !starts.includes(570), `${starts}`);
});

test("a topic turn inside a punctuated caption starts a chapter at its own word", () => {
  const app = popup();
  const cues = Array.from({ length: 48 }, (_, index) => ({
    time: index * 15,
    text: "And the same part keeps going here.",
  }));
  for (const [time, text] of [
    [165, "Next, let's talk about batteries."],
    [390, "Moving on to the camera."],
  ]) {
    cues.find((cue) => cue.time === time).text = text;
  }
  // "speaking of" begins 20 of 55 characters into a 15-second caption, mid-sentence.
  cues.find((cue) => cue.time === 555).text =
    "It keeps going, and speaking of the verdict, it's good.";
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.ok(
    [165, 390, 560].every((time) => starts.includes(time)) && !starts.includes(555),
    `${starts}`,
  );
});

test("a caption of only sounds never becomes a start", () => {
  const app = popup();
  for (const sound of ["[Music]", "[music]", "[Applause] [Music]"]) {
    const cues = [];
    for (let time = 0; time < 720; time += 3) {
      if (time === 555 || time === 558) continue;
      cues.push({
        time,
        text:
          time < 552
            ? "and the same part keeps going here"
            : `battery chemistry ${time} changes charging behaviour`,
      });
    }
    cues.find((cue) => cue.time === 165).text = "next let's talk about batteries";
    cues.find((cue) => cue.time === 390).text = "moving on to the camera";
    cues.find((cue) => cue.time === 552).text = sound;
    const starts = [...app.selectStarts({ duration: 720, cues })];
    // The vocabulary dip is measured every 5 seconds, so the start can land on the last line before the break.
    assert.ok(
      !starts.includes(552) && starts.some((start) => start >= 549 && start <= 561),
      `${sound}: ${starts}`,
    );
  }
});

test("a lasting change of vocabulary outranks a question inside a topic", () => {
  const app = popup();
  // Three topics with their own words and no spoken marker; each caption also has words of its own, and a question
  // sits inside each topic.
  const topics = [
    ["battery", "charging", "cable"],
    ["camera", "lens", "sensor"],
    ["speaker", "volume", "bass"],
  ];
  const cues = Array.from({ length: 48 }, (_, index) => {
    const [first, second] = [
      topics[Math.floor(index / 16)][index % 3],
      topics[Math.floor(index / 16)][(index + 1) % 3],
    ];
    return {
      time: index * 15,
      text: `The ${first} and ${second} matter for item${index} and extra${index}.`,
    };
  });
  for (const time of [105, 345, 585])
    cues.find((cue) => cue.time === time).text = `Why does item${time} change it?`;
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.ok(starts.includes(240) && starts.includes(480), `${starts}`);
});

test("captions without an inner section marker keep their title sections", () => {
  const app = popup();
  const cues = [
    { time: 0, text: "Opening. Still opening." },
    { time: 50, text: "Middle. Next, more." },
    { time: 99, text: "Closing." },
  ];
  assert.deepEqual(app.splitAtStarts(cues, 100, [0, 50]), cues);
});

test("no chapter runs longer than 180 s where sixteen chapters allow it", () => {
  const app = popup();
  const cues = Array.from({ length: 48 }, (_, index) => ({
    time: index * 15,
    text: "and the same part keeps going here",
  }));
  for (const [time, text] of [
    [105, "Next, the battery."],
    [210, "Moving on to the camera."],
    [315, "Finally, the verdict."],
  ]) {
    cues.find((cue) => cue.time === time).text = text;
  }
  const edges = [...app.selectStarts({ duration: 720, cues }), 720];
  assert.equal(edges.length, 10);
  // The last chapter is held to the limit only up to its last caption, then runs on to the video's end.
  assert.ok(
    edges.slice(1, -1).every((edge, index) => edge - edges[index] <= 180),
    `${edges}`,
  );
});

test("sparse captions never invent starts", () => {
  const app = popup();
  assert.deepEqual(
    [...app.selectStarts({ duration: 720, cues: [{ time: 0, text: "Only opening words" }] })],
    [0],
  );
  // Captions only in the first half minute of a 12-minute video leave no candidate half an average chapter (40 s) from
  // the start.
  const early = Array.from({ length: 6 }, (_, index) => ({
    time: index * 5,
    text: `Next, part ${index}.`,
  }));
  assert.deepEqual([...app.selectStarts({ duration: 720, cues: early })], [0]);
});

test("title prompt uses the video title only as naming context", () => {
  const app = popup();
  const cues = [
    { time: 0, text: "Opening evidence" },
    { time: 50, text: "Later evidence" },
  ];
  assert.match(
    app.buildTitlePrompt(cues, 100, [0, 50], 'Headset "review"'),
    /The video is titled "Headset \\"review\\""; use that only to identify its product or subject/,
  );
  const untitled = app.buildTitlePrompt(cues, 100, [0, 50]);
  assert.doesNotMatch(untitled, /video is titled/);
  assert.match(untitled, /short label of 2 to 5 words/);
  assert.match(untitled, /Labels are at most 40 characters/);
});

// A video in YouTube's newer transcript view: the description's transcript button names the panel's request, beside
// the chapter panel's.
const modernWatchNext = {
  currentVideoEndpoint: { watchEndpoint: { videoId: "original-video" } },
  engagementPanels: [
    {
      engagementPanelSectionListRenderer: {
        content: {
          structuredDescriptionContentRenderer: {
            items: [
              {
                videoDescriptionTranscriptSectionRenderer: {
                  primaryButton: {
                    buttonRenderer: {
                      command: {
                        commandExecutorCommand: {
                          commands: [
                            {
                              updateEngagementPanelContentCommand: {
                                contentSourcePanelIdentifier: {
                                  tag: "engagement-panel-macro-markers-description-chapters",
                                },
                              },
                            },
                            {
                              updateEngagementPanelContentCommand: {
                                contentSourcePanelIdentifier: { tag: "PAmodern_transcript_view" },
                                globalConfiguration: { params: "modern-params" },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  ],
};

for (const [format, panelLayout] of [
  ["legacy", "legacy"],
  ["modern", "legacy"],
  ["modern", "combined"],
  ["modern", "combined-loading"],
]) {
  for (const alreadyOpen of [true, false]) {
    test(`${format} transcript reads the ${alreadyOpen ? "already-open" : "newly-opened"} ${panelLayout} panel without hidden duplicate cues`, async () => {
      const app = popup();
      const rowTag =
        format === "legacy" ? "ytd-transcript-segment-renderer" : "transcript-segment-view-model";
      const timestampSelector =
        format === "legacy" ? ".segment-timestamp" : ".ytwTranscriptSegmentViewModelTimestamp";
      const textSelector = format === "legacy" ? ".segment-text" : '[role="text"]';
      const row = (timestamp, text) => ({
        querySelector(selector) {
          const selectors = selector.split(",").map((value) => value.trim());
          if (selectors.includes(timestampSelector)) return { textContent: timestamp };
          if (selectors.includes(textSelector)) return { textContent: text };
          return null;
        },
      });
      // A caption with a line break must not become its own prompt line.
      const visibleRows = [
        row("0:00", "Where are all the aliens?"),
        row("2:14:07", "Closing\n  topic\tnow"),
      ];
      const hiddenRows = [row("0:00", "Hidden duplicate"), row("2:14:07", "Hidden duplicate")];
      const rowsFor = (selector, rows) => {
        const found = selector
          .split(",")
          .map((value) => value.trim())
          .includes(rowTag)
          ? [...rows]
          : [];
        found.item = (index) => found[index];
        return found;
      };
      let isExpanded = alreadyOpen;
      let loaded = panelLayout !== "combined-loading";
      let closes = 0;
      let opens = 0;
      const expanded = {
        getAttribute: () =>
          isExpanded
            ? "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"
            : "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN",
        querySelector(selector) {
          if (selector === "#visibility-button button")
            return {
              click() {
                isExpanded = false;
                closes++;
              },
            };
          return loaded ? rowsFor(selector, visibleRows)[0] || null : null;
        },
        querySelectorAll: (selector) => rowsFor(selector, loaded ? visibleRows : []),
      };
      const hidden = {
        getAttribute: () => "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN",
        querySelector() {
          assert.fail("Hidden duplicate panel must not be used");
        },
        querySelectorAll: (selector) => rowsFor(selector, hiddenRows),
      };
      let clock = 0;
      const styles = [];
      let requests = 0;
      const result = await vm.runInNewContext(
        `(${app.fetchTranscript.toString()})("original-video")`,
        {
          URL,
          AbortSignal,
          location: { href: "https://www.youtube.com/watch?v=original-video" },
          window: {},
          ytcfg: { get: () => ({}) },
          // The newer view's own request fails here, so the reader opens the panel instead.
          async fetch() {
            requests++;
            throw new TypeError("Failed to fetch");
          },
          performance: { now: () => clock },
          setTimeout(callback) {
            clock += 50;
            loaded = true;
            callback();
          },
          document: {
            createElement(tag) {
              assert.equal(tag, "style");
              const style = {
                textContent: "",
                attached: false,
                remove() {
                  this.attached = false;
                },
              };
              styles.push(style);
              return style;
            },
            head: {
              append(style) {
                style.attached = true;
              },
            },
            querySelector(selector) {
              if (selector === "#movie_player")
                return {
                  classList: { contains: () => false },
                  getDuration: () => 8049.781,
                  getPlayerResponse: () => ({
                    videoDetails: { videoId: "original-video", title: "Aliens talk" },
                    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{}] } },
                  }),
                  getWatchNextResponse: () => (format === "modern" ? modernWatchNext : {}),
                };
              if (selector.startsWith("ytd-engagement-panel-section-list-renderer")) {
                const matchesPanel = selector
                  .split(",")
                  .some((part) =>
                    panelLayout === "legacy"
                      ? part.includes("[target-id='engagement-panel-searchable-transcript']")
                      : part.includes(
                          loaded
                            ? "[data-target-id='PAmodern_transcript_view']"
                            : "[target-id='PAmodern_transcript_view']",
                        ),
                  );
                if (!matchesPanel) return null;
                return selector.includes("ENGAGEMENT_PANEL_VISIBILITY_EXPANDED")
                  ? isExpanded
                    ? expanded
                    : null
                  : hidden;
              }
              if (selector === "tp-yt-paper-button#expand") return null;
              if (selector === "ytd-video-description-transcript-section-renderer button") {
                return {
                  click() {
                    opens++;
                    isExpanded = true;
                  },
                };
              }
              return rowsFor(selector, [...hiddenRows, ...visibleRows])[0] || null;
            },
            querySelectorAll: (selector) => rowsFor(selector, [...hiddenRows, ...visibleRows]),
          },
        },
      );
      assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        cues: [
          { time: 0, text: "Where are all the aliens?" },
          { time: 8047, text: "Closing topic now" },
        ],
        duration: 8049.781,
        title: "Aliens talk",
      });
      assert.equal(isExpanded, alreadyOpen);
      assert.equal(closes, alreadyOpen ? 0 : 1);
      assert.equal(opens, alreadyOpen ? 0 : 1);
      // A panel the reader opens is hidden while it renders and shown again once it is closed.
      assert.equal(styles.length, 1);
      assert.match(styles[0].textContent, /visibility: hidden/);
      assert.equal(styles[0].attached, false);
      // Reading stops polling once cues are present, so only a loading panel waits.
      assert.equal(clock, panelLayout === "combined-loading" ? 50 : 0);
      assert.equal(requests, format === "modern" ? 1 : 0);
    });
  }
}

test("the newer transcript view is read by its own request, without opening the panel", async () => {
  const app = popup();
  const requests = [];
  const segment = (timestamp, simpleText) => ({
    macroMarkersPanelItemViewModel: {
      item: {
        timelineItemViewModel: {
          contentItems: [{ transcriptSegmentViewModel: { timestamp, simpleText } }],
        },
      },
    },
  });
  const result = await vm.runInNewContext(`(${app.fetchTranscript.toString()})("original-video")`, {
    URL,
    AbortSignal,
    location: { href: "https://www.youtube.com/watch?v=original-video" },
    window: {},
    ytcfg: {
      get: (key) => (key === "INNERTUBE_CONTEXT" ? { client: { clientName: "WEB" } } : undefined),
    },
    async fetch(url, init) {
      requests.push({ url, method: init.method, body: JSON.parse(init.body) });
      return {
        json: async () => ({
          content: {
            engagementPanelSectionListRenderer: {
              content: {
                sectionListRenderer: {
                  contents: [
                    {
                      itemSectionRenderer: {
                        contents: [
                          segment("0:02", "Where are\n  all the aliens?"),
                          segment("2:14:07", "Closing topic"),
                        ],
                      },
                    },
                    // A segment past the video's end is dropped, as the panel reader drops it.
                    { itemSectionRenderer: { contents: [segment("2:15:00", "After the end")] } },
                  ],
                },
              },
            },
          },
        }),
      };
    },
    document: {
      createElement: () => ({ remove() {} }),
      head: {
        append() {
          assert.fail("no panel opens, so none is hidden");
        },
      },
      querySelector(selector) {
        if (selector === "#movie_player")
          return {
            classList: { contains: () => false },
            getDuration: () => 8049.781,
            getPlayerResponse: () => ({
              videoDetails: { videoId: "original-video", title: "Aliens talk" },
              captions: { playerCaptionsTracklistRenderer: { captionTracks: [{}] } },
            }),
            getWatchNextResponse: () => modernWatchNext,
          };
        // No transcript panel is open, and nothing is clicked.
        return null;
      },
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    cues: [
      { time: 2, text: "Where are all the aliens?" },
      { time: 8047, text: "Closing topic" },
    ],
    duration: 8049.781,
    title: "Aliens talk",
  });
  assert.deepEqual(requests, [
    {
      url: "/youtubei/v1/get_panel?prettyPrint=false",
      method: "POST",
      body: {
        context: { client: { clientName: "WEB" } },
        panelId: "PAmodern_transcript_view",
        params: "modern-params",
      },
    },
  ]);
});

// Without the model on the device, titles come from code and the model is never touched.
test("a device without the model renders code-named chapters through the production renderer", async () => {
  const app = popup({ availability: "unavailable" });
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 0, "opening the popup starts no session");
  await app.click();
  assert.equal(app.sessions.length, 0);
  assert.equal(app.prompted(), 0);
  assert.equal(app.calls.length, 2);
  const [transcript, injection] = app.calls;
  assert.equal(transcript.args[0], "original-video");
  assert.equal(injection.func, app.renderer);
  assert.equal(injection.args[1], "original-video");
  assertKeywordChapters(app);
  assertSuccess(app, { modelOnDevice: false });
  assert.equal(app.labels.includes("Generating chapters"), true);
  assert.equal(app.errors.length, 0);
  assert.equal(app.timers.size, 0, "no generation timeout is armed");
});

test("section cues cover each chapter's span and split a straddling caption", () => {
  const app = popup();
  const sections = app.sectionCues(
    {
      duration: 100,
      cues: [
        { time: 0, text: "Opening words. Next, the middle topic starts here." },
        { time: 60, text: "The end." },
      ],
    },
    [0, 18, 60],
  ); // "Next," begins 15 of 51 characters in, so the split piece is timed at 18 s
  assert.deepEqual(
    sections.map((section) => [section.start, section.end]),
    [
      [0, 18],
      [18, 60],
      [60, 100],
    ],
  );
  assert.deepEqual(
    sections.map((section) => section.cues.length),
    [1, 1, 1],
  );
  assert.match(sections[1].cues[0].text, /^Next, the middle topic/);
  assert.equal(sections[1].cues[0].time, 18);
});

// Keyword titler: fixtures name the behaviour, not the whole word lists.
function sections(...specs) {
  return specs.map(([start, end, texts]) => ({
    start,
    end,
    cues: texts.map((text, index) => ({ time: start + index * 5, text })),
  }));
}

test("an announced topic names its section and a repeated word ends the phrase", () => {
  const app = popup();
  const titles = app.nameChapters(
    sections(
      [0, 60, ["welcome to the channel", "today we look at tents", "there are many tents"]],
      [
        60,
        200,
        [
          "let's talk about price the price of a premium tent is high",
          "price matters and the price ranges vary",
          "cheap tents leak",
        ],
      ],
      [
        200,
        300,
        [
          "now for the season rating",
          "a three season tent",
          "the season rating tells you",
          "season matters",
        ],
      ],
    ),
    "How To Choose A Tent",
  );
  // A thin first section that says a phrase of the video's title is an overview of that subject.
  assert.deepEqual(titles, ["Tents Overview", "Price", "Season Rating"]);
});

test("numbered section words become labels with the announced phrase", () => {
  const app = popup();
  const titles = app.nameChapters(
    sections(
      [0, 60, ["intro words here", "fishing is fun"]],
      [
        60,
        200,
        [
          "mistake five wrong strength line.",
          "the strength line breaks",
          "use a strong line",
          "strength line again",
        ],
      ],
      [200, 300, ["mistake seven bad hooks.", "hooks rust", "sharp hooks matter", "hooks again"]],
    ),
    "Fishing Mistakes",
  );
  // A first section of a minute is named by what it says, not Intro.
  assert.deepEqual(titles, [
    "Intro Words",
    "Mistake 5: Wrong Strength Line",
    "Mistake 7: Bad Hooks",
  ]);
});

test("a repeated collocation beats its single words without an announcement", () => {
  const app = popup();
  const titles = app.nameChapters(
    sections(
      [
        0,
        200,
        [
          "the heating element warms the water",
          "a heating element can fail",
          "check the heating element",
          "hot water helps",
        ],
      ],
      [
        200,
        400,
        [
          "the rinse aid dispenser",
          "rinse aid stops spots",
          "fill the rinse aid",
          "rinse aid is cheap",
        ],
      ],
    ),
    "Dishwasher Tips",
  );
  assert.deepEqual(titles, ["Heating Element & Water", "Rinse Aid"]);
});

test("a section that repeats three strong phrases names all three, and one with a single phrase keeps it alone", () => {
  const app = popup();
  const titles = app.nameChapters(
    sections(
      [
        0,
        200,
        [
          "the heating element warms the water",
          "a heating element can fail",
          "check the heating element",
          "the rinse aid dispenser",
          "rinse aid stops spots",
          "fill the rinse aid",
          "the spray arm spins",
          "clean the spray arm",
          "a clogged spray arm",
        ],
      ],
      [
        200,
        400,
        [
          "the door seal keeps water in",
          "a worn door seal leaks",
          "replace the door seal",
          "door seal again",
        ],
      ],
    ),
    "Dishwasher Tips",
  );
  assert.deepEqual(titles, ["Heating Element, Rinse Aid & Spray Arm", "Door Seal"]);
  assert.ok(titles[0].length <= 60);
});

test("short thin edge sections read Intro and Outro, and wordless sections never throw", () => {
  const app = popup();
  assert.deepEqual(
    app.nameChapters(
      sections(
        [0, 20, ["hey everyone", "welcome back"]],
        [
          20,
          400,
          [
            "the dutch oven bakes bread",
            "a dutch oven holds heat",
            "dutch oven again",
            "bread bakes well",
          ],
        ],
        [400, 430, ["thanks for watching", "see you next time"]],
      ),
      "Sourdough",
    ),
    ["Intro", "Dutch Oven", "Outro"],
  );
  for (const odd of [
    sections([0, 60, ["[Music]"]], [60, 120, ["[Applause]", "[Music]"]]),
    [{ start: 0, end: 10, cues: [] }],
    sections([0, 300, ["supercalifragilisticexpialidocious ".repeat(12)]]),
    [],
  ]) {
    const titles = app.nameChapters(odd, undefined);
    assert.equal(titles.length, odd.length);
    assert.ok(
      titles.every((title) => typeof title === "string" && title.length >= 3 && title.length <= 60),
      JSON.stringify(titles),
    );
  }
});

test("a model title cut by the length limit loses its open bracket and trailing separators", () => {
  const app = popup();
  assert.equal(app.tidyTitle("Battery Life (Screen On"), "Battery Life");
  assert.equal(app.tidyTitle("Camera, Battery &"), "Camera, Battery");
  assert.equal(app.tidyTitle("Camera, Battery & Price"), "Camera, Battery & Price");
});

test("a model title takes only the keyword phrases it lacks, within 60 characters", () => {
  const app = popup();
  assert.equal(
    app.withKeywords("Battery Life", "Battery Life, Fast Charging & USB-C Cable"),
    "Battery Life: Fast Charging, USB-C Cable",
  );
  assert.equal(
    app.withKeywords(
      "Battery Life and Charging Speed Test",
      "Wireless Charging Pads & Power Delivery Standards",
    ),
    "Battery Life and Charging Speed Test",
  );
});
