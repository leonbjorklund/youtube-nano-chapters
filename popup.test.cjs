const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const generated = {
  chapter1: { timestamp: 0, title: "  Generated opening  " },
  chapter2: { timestamp: 180, title: "Generated architecture" },
  chapter3: { timestamp: 360, title: "Generated tradeoffs between battery life, comfort and weight" }, // 60 characters, the longest accepted title
  chapter4: { timestamp: 540, title: "Generated conclusion" },
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function popup(options = {}) {
  const calls = [];
  const inspections = [];
  const errors = [];
  const sessions = [];
  const downloads = [];
  const creations = [];
  const createCalls = [];
  const reads = [];
  const prompts = [];
  const timers = new Map();
  const window = new EventTarget();
  const body = { dataset: { state: "idle" } };
  const status = { textContent: "" };
  const labels = ["Generate chapters"];
  let click;
  let timerId = 0;
  let now = 1_000;
  class Clock extends Date { static now() { return now; } }
  const attributes = {};
  const button = {
    disabled: false,
    addEventListener(event, listener) {
      assert.equal(event, "click");
      click = listener;
    },
    setAttribute(name, value) { attributes[name] = value; },
    removeAttribute(name) { delete attributes[name]; },
  };
  // The button's words live in their own span, beside the circular arrow that offers another naming.
  const label = {
    get textContent() { return labels.at(-1); },
    set textContent(value) {
      if (value !== labels.at(-1)) labels.push(value);
    },
  };
  // The arrow is an SVG element: no hidden property, only the attribute.
  const again = {
    attributes: new Set(["hidden"]),
    hasAttribute(name) { return this.attributes.has(name); },
    toggleAttribute(name, force) {
      if (force) this.attributes.add(name); else this.attributes.delete(name);
      return force;
    },
  };
  const offer = { hidden: true };
  const optIn = { checked: false };
  const elements = { "#create": button, "#label": label, "#again": again, "#status": status, "#offer": offer, "#opt-in": optIn };
  const queried = new Set();
  const tab = options.tab === undefined
    ? { id: 42, url: "https://www.youtube.com/watch?v=original-video" }
    : options.tab;
  const context = vm.createContext({
    URL,
    AbortController,
    Date: Clock,
    window,
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    console: { error: (error) => errors.push(error) },
    document: {
      body,
      querySelector(selector) {
        assert.ok(Object.hasOwn(elements, selector), selector);
        queried.add(selector);
        return elements[selector];
      },
    },
    ...(options.missingApi ? {} : { LanguageModel: {
      availability: async () => {
        if (options.availabilityReady) await options.availabilityReady;
        reads.push("availability");
        // A model that goes away between the popup's read and generation's read.
        return (reads.length > 1 && options.availabilityAfter) || options.availability || "available";
      },
      create(modelOptions) {
        createCalls.push(modelOptions);
        modelOptions.monitor?.({ addEventListener: (type, listener) => {
          assert.equal(type, "downloadprogress");
          downloads.push(listener);
        } });
        // Code chooses the starts; the created session is prompted once for titles.
        const session = {
          destroyed: 0,
          signal: modelOptions.signal,
          async prompt(text, promptOptions) {
            prompts.push({ text, options: promptOptions });
            if (options.promptReady) await options.promptReady;
            if (options.titleError) throw options.titleError;
            if (options.titleRaw !== undefined) return options.titleRaw;
            return JSON.stringify(Object.fromEntries(promptOptions.responseConstraint.required.map(key => [key, generated[key].title])));
          },
          destroy() { this.destroyed++; },
        };
        // A create Chrome refuses: no space for the download, or a model that went away.
        if (options.createError) {
          const failure = Promise.resolve(options.modelReady).then(() => { throw options.createError; });
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
    } }),
    chrome: {
      tabs: { query: async () => {
        if (options.tabReady) await options.tabReady;
        return tab ? [tab] : [];
      } },
      scripting: {
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
            if (options.transcriptResultError) return [{ result: { error: options.transcriptResultError } }];
            if (Object.hasOwn(options, "transcriptResult")) return [{ result: options.transcriptResult }];
            // A later tab URL must not replace the identity captured on click.
            tab.url = "https://www.youtube.com/watch?v=different-video";
            return [{ result: {
              duration: 720,
              // Announced topics at 180, 360 and 540 become the generated starts.
              cues: [
                { time: 0, text: "Transcript about architecture." },
                { time: 180, text: "Next, the architecture itself." },
                { time: 360, text: "Next, tradeoffs between battery life and comfort." },
                { time: 540, text: "Next, the conclusion." },
              ],
              title: "Architecture talk",
            } }];
          }
          if (options.rendererError) throw options.rendererError;
          if (options.rendererResultError) return [{ result: { error: options.rendererResultError } }];
          return [{ result: { count: injection.args[0].length } }];
        },
      },
    },
  });

  // Load the production scripts in the same order as the popup.
  const html = readFileSync(path.join(__dirname, "popup.html"), "utf8");
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, ["chapters.js", "generation.js", "popup.js"]);
  for (const script of scripts) {
    vm.runInContext(readFileSync(path.join(__dirname, script), "utf8"), context, { filename: script });
  }
  // Every element the popup reaches for must exist in the markup under that id, and the popup must reach for all
  // of them: a renamed id would otherwise break the popup without breaking a test.
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...queried].sort(), Object.keys(elements).sort());
  for (const selector of queried) assert.ok(ids.has(selector.slice(1)), `${selector} is missing from popup.html`);
  // The button's words change under the pointer, so a screen reader is told when they do.
  assert.match(html, /<span id="label"[^>]*aria-live="polite"/);

  return {
    button, label, again, offer, optIn, status, body, attributes, createCalls, calls, inspections, errors, sessions, prompts, timers, labels,
    ready: vm.runInContext("initialState", context),
    readChapterState: vm.runInContext("readChapterState", context),
    click: () => click(),
    renderer: vm.runInContext("injectChapters", context),
    fetchTranscript: vm.runInContext("fetchTranscript", context),
    buildTitlePrompt: vm.runInContext("buildTitlePrompt", context),
    selectStarts: vm.runInContext("selectStarts", context),
    splitAtStarts: vm.runInContext("splitAtStarts", context),
    nameChapters: vm.runInContext("nameChapters", context),
    sectionCues: vm.runInContext("sectionCues", context),
    generateChapterData: vm.runInContext("generateChapterData", context),
    destroyed: () => sessions.reduce((total, session) => total + session.destroyed, 0),
    prompted: () => prompts.length,
    modelCreated: (index = 0) => creations[index],
    reportProgress: (loaded, index = 0) => downloads[index]({ loaded }),
    advance: (milliseconds) => { now += milliseconds; },
    close: () => window.dispatchEvent(new Event("pagehide")),
    async checkAd() {
      const entry = [...timers].find(([, timer]) => timer.delay === 750);
      assert.ok(entry, "ad state schedules a recheck");
      timers.delete(entry[0]);
      await entry[1].callback();
    },
    expireGeneration() {
      assert.equal(timers.size, 1);
      const [id, timer] = [...timers][0];
      assert.equal(timer.delay, 60_000);
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

// The harness transcript, as the popup's own reader returns it.
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

// The chapters the code names when the model does not name them.
function assertKeywordChapters(app) {
  const chapters = JSON.parse(JSON.stringify(app.calls.at(-1).args[0]));
  assert.deepEqual(chapters.map(chapter => chapter.timestamp), [0, 180, 360, 540]);
  const named = app.nameChapters(app.sectionCues(harnessTranscript, [0, 180, 360, 540]), harnessTranscript.title);
  assert.deepEqual(chapters.map(chapter => chapter.title), [...named]);
  assert.ok(chapters.every(chapter => chapter.title.length >= 3 && chapter.title.length <= 60));
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
  // Generation's cleanup aborts the early session's controller too, after the session was used.
  assert.equal(app.sessions[0].signal.aborted, true);
  assert.equal(app.prompts[0].options.signal.aborted, true);
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

test("closing the popup after a click that waits on the early session aborts its loading", async () => {
  const model = deferred();
  const app = popup({ modelReady: model.promise });
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 1);
  const run = app.click();
  await tick();
  assert.equal(app.sessions[0].signal.aborted, false);
  app.close();
  assert.equal(app.sessions[0].signal.aborted, true);
  model.resolve();
  await run;
  assert.equal(app.destroyed(), 1);
  assert.equal(app.prompted(), 0);
});

test("closing the popup while the early session loads aborts it", async () => {
  const model = deferred();
  const app = popup({ modelReady: model.promise });
  await app.ready;
  await tick();
  assert.equal(app.sessions.length, 1);
  app.close();
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
  app.sessions[0].prompt = async () => { throw new Error("stale"); };
  await app.click();
  assert.equal(app.sessions.length, 1, "the failed session is not replaced by a second one");
  assertSuccess(app);
  assertKeywordChapters(app);
  assert.equal(app.destroyed(), 1);
});

test("late chapter inspection cannot replace generation or its result", async () => {
  const inspection = deferred();
  const prompt = deferred();
  const app = popup({ inspectionReady: inspection.promise, promptReady: prompt.promise, chapterState: { native: true } });
  const run = app.click();
  assert.equal(app.button.disabled, true);
  assert.equal(app.label.textContent, "Generating chapters...");
  assert.equal(app.status.textContent, "");
  await tick();
  prompt.resolve();
  await run;
  inspection.resolve();
  await app.ready;
  assertSuccess(app);
});

test("chapter inspection failures show concise feedback and allow retry", async () => {
  const app = popup({ inspectionError: new Error("Cannot access contents of the page. Long browser explanation.") });
  await app.ready;
  assertRetry(app, /Can't access this video/);
  await app.click();
  assert.equal(app.body.dataset.state, "success");
});

test("chapter detection requires structured chapters for the current video", () => {
  const app = popup();
  const chapters = [
    { chapterRenderer: { title: { simpleText: "Introduction" }, timeRangeStartMillis: 0 } },
    { chapterRenderer: { title: { runs: [{ text: "Main " }, { text: "topic" }] }, timeRangeStartMillis: 65000 } },
  ];
  const watchNext = (markersMap, videoId = "original-video") => ({
    currentVideoEndpoint: { watchEndpoint: { videoId } },
    playerOverlays: { playerOverlayRenderer: { decoratedPlayerBarRenderer: {
      decoratedPlayerBarRenderer: { playerBar: { multiMarkersPlayerBarRenderer: { markersMap } } },
    } } },
  });
  const markers = (value = chapters, key = "DESCRIPTION_CHAPTERS") => [{ key, value: { chapters: value } }];
  const detect = ({ next = watchNext(markers()), playerId = "original-video", videoId = "original-video",
    title = "In this video" } = {}) => vm.runInNewContext(
    `(${app.readChapterState.toString()})("original-video")`, {
      URL, location: { href: `https://www.youtube.com/watch?v=${videoId}` },
      document: {
        querySelector: (selector) => selector === "#movie_player" ? {
          getPlayerResponse: () => ({ videoDetails: { videoId: playerId } }),
          ...(next === null ? {} : { getWatchNextResponse: () => next }),
        } : null,
        querySelectorAll: () => [{ textContent: title, closest: () => ({ disabled: false }) }],
      },
    });

  assert.equal(detect({ next: watchNext(undefined) }).native, false, "Timeline-only video is not chaptered");
  assert.equal(detect({ title: "" }).native, true, "chapters do not depend on a visible player title");
  assert.equal(detect({ next: watchNext(markers(chapters, "AUTO_CHAPTERS")) }).native, true);
  // The reader reports only what the page shows; chapters this extension added are not part of it.
  assert.deepEqual(JSON.parse(JSON.stringify(detect())), { native: true, blocked: "" });
  assert.equal(detect({ next: watchNext(markers(), "previous-video") }).native, false, "stale watch data");
  assert.equal(detect({ playerId: "previous-video" }).native, false, "stale player data");
  assert.equal(detect({ videoId: "different-video" }), null);

  for (const next of [null, {}, watchNext({}), watchNext([null]), watchNext([{ key: "HEATSEEKER", value: { heatmap: {} } }])]) {
    assert.equal(detect({ next }).native, false, "missing or unrelated metadata is not chapter evidence");
  }
  for (const invalid of [undefined, {}, [], chapters.slice(0, 1), [null, null],
    chapters.toReversed(), [chapters[0], chapters[0]],
    [chapters[0], { chapterRenderer: { title: { simpleText: " " }, timeRangeStartMillis: 65000 } }],
    [chapters[0], { chapterRenderer: { title: { runs: {} }, timeRangeStartMillis: 65000 } }],
    [chapters[0], { chapterRenderer: { title: { simpleText: "Topic" }, timeRangeStartMillis: "65000" } }],
    [chapters[0], { chapterRenderer: { title: { simpleText: "Topic" }, timeRangeStartMillis: NaN } }],
  ]) {
    assert.equal(detect({ next: watchNext([{ value: { chapters: invalid } }]) }).native, false, "invalid chapter list");
  }
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
  const detect = (ad, duration, videoId = "original-video") => vm.runInNewContext(
    `(${app.readChapterState.toString()})("original-video")`, {
      URL, location: { href: "https://www.youtube.com/watch?v=original-video" },
      document: {
        querySelector: (selector) => selector === "#movie_player" ? {
          classList: { contains: () => ad },
          getDuration: () => duration,
          getPlayerResponse: () => ({ videoDetails: { videoId } }),
        } : null,
        querySelectorAll: () => [],
      },
    });
  assert.equal(detect(true, 3).blocked, "Wait for the ad to finish");
  assert.equal(detect(false, 3).blocked, "Video too short");
  assert.equal(detect(false, 4).blocked, "");
  assert.equal(detect(false, 0).blocked, "");
  assert.equal(detect(false, 3, "previous-video").blocked, "");
});

test("popup sends validated model output to the production renderer for the original video", async () => {
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
    { timestamp: 360, title: "Generated tradeoffs between battery life, comfort and weight" },
    { timestamp: 540, title: "Generated conclusion" },
  ]);
  assertSuccess(app);
  assert.equal(app.errors.length, 0);
  // The prompt carries the run's own signal; the early session's loading was cancelled with it.
  assert.equal(app.prompts[0].options.signal.aborted, true);
  assert.equal(app.sessions[0].signal.aborted, true);
  assert.deepEqual([...app.prompts[0].options.responseConstraint.required], ["chapter1", "chapter2", "chapter3", "chapter4"]);
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

for (const [name, transcriptResult, message] of [
  ["serialized error", { error: "Wait for the ad to finish" }, /ad to finish/],
  ["missing transcript", null, /Transcript unavailable/],
  ["empty transcript", { duration: 2400, cues: [] }, /Transcript unavailable/],
]) {
  test(`${name} aborts model preparation before the session is ready`, async () => {
    const model = deferred();
    const app = popup({ modelReady: model.promise, transcriptResult });
    await app.ready;
    await tick();
    assert.equal(app.sessions.length, 1, "the popup started the model on opening");
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
      assert.equal(app.label.textContent, name === "serialized error" ? "Generate chapters" : "Try again");
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

test("a stalled prompt times out after 60 seconds and the chapters are named in code instead", async () => {
  const prompt = deferred();
  const app = popup({ promptReady: prompt.promise });
  await app.ready;
  const run = app.click();
  await tick();
  assert.equal(app.prompted(), 1);
  assert.equal(app.button.disabled, true);
  app.expireGeneration();
  await run;
  assertSuccess(app);
  assertKeywordChapters(app);
  assert.equal(app.prompts[0].options.signal.aborted, true);
  assert.equal(app.destroyed(), 1);
  assert.equal(app.calls.length, 2);
  prompt.resolve();
  await tick();
  // The late model output arrives after the chapters were rendered and changes nothing.
  assert.equal(app.calls.length, 2);
  assertSuccess(app);
});

// The popup reads the model once on opening. A click in that first moment waits for the read rather than
// deciding without it.
for (const [name, options, usesModel] of [
  ["a model on the device", {}, true],
  ["no model", { availability: "unavailable" }, false],
]) {
  test(`a click during the model read waits for it, then ${usesModel ? "uses Nano" : "names the chapters in code"}`, async () => {
    const availability = deferred();
    const app = popup({ ...options, availabilityReady: availability.promise });
    const run = app.click();
    await tick();
    assert.equal(app.label.textContent, "Generating chapters...");
    assert.equal(app.calls.length, 0, "the run waits for the model read");
    availability.resolve();
    await run;
    assert.equal(app.prompted(), usesModel ? 1 : 0);
    assert.equal(app.calls.length, 2);
    if (usesModel) {
      assert.equal(JSON.parse(JSON.stringify(app.calls[1].args[0]))[0].title, "Generated opening");
    } else assertKeywordChapters(app);
    assertSuccess(app, { modelOnDevice: usesModel });
    assert.deepEqual(app.labels, ["Generate chapters", "Generating chapters...", "Chapters added"]);
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

// A finished download reports "available" and the offer disappears on its own; a download that died leaves the
// box for another try.
for (const [name, options, offered] of [
  ["a downloadable model", { availability: "downloadable" }, true],
  ["a model already on the device", {}, false],
  ["a model still downloading", { availability: "downloading" }, false],
  ["an unavailable model", { availability: "unavailable" }, false],
  ["a missing Prompt API", { missingApi: true }, false],
  ["a blocked video", { availability: "downloadable", chapterState: { blocked: "Video too short" } }, false],
]) {
  test(`${name} ${offered ? "offers" : "does not offer"} better titles`, async () => {
    const app = popup(options);
    await app.ready;
    await tick();
    assert.equal(app.offer.hidden, !offered);
    assert.equal(app.optIn.checked, false);
  });
}

test("ticking the offer and clicking hides the offer and starts the download", async () => {
  const app = popup({ availability: "downloadable" });
  await app.ready;
  assert.equal(app.offer.hidden, false);
  app.optIn.checked = true;
  await app.click();
  assert.equal(app.offer.hidden, true, "the offer is answered for this popup");
  assert.equal(app.sessions.length, 1, "the click starts the download");
  // Nothing cancels the download: it must survive the popup that asked for it.
  assert.equal(app.createCalls.length, 1);
  assert.equal(app.createCalls[0].signal, undefined);
  assert.equal(typeof app.createCalls[0].monitor, "function");
  // The download outlives this run, so these chapters are still named in code.
  assert.equal(app.prompted(), 0);
  assertKeywordChapters(app);
  assertSuccess(app, { modelOnDevice: false });
  await tick();
  assert.equal(app.destroyed(), 1, "the download session is released once Chrome has the model");
});

test("an unticked offer downloads nothing and stays on screen", async () => {
  const app = popup({ availability: "downloadable" });
  await app.ready;
  await app.click();
  assert.equal(app.offer.hidden, false);
  assert.equal(app.sessions.length, 0);
  assertSuccess(app, { modelOnDevice: false });
});

test("the download starts on the click itself, ahead of every await", async () => {
  const app = popup({ availability: "downloadable" });
  await app.ready;
  app.optIn.checked = true;
  const run = app.click();
  // Chrome allows the download only from the click, so it cannot wait for the model read or the transcript.
  assert.equal(app.sessions.length, 1);
  assert.equal(app.offer.hidden, true);
  assert.equal(app.calls.length, 0, "the run itself has not started yet");
  await run;
  assertSuccess(app, { modelOnDevice: false });
});

test("download progress reaches the status line until the popup closes", async () => {
  const download = deferred();
  const app = popup({ availability: "downloadable", modelReady: download.promise });
  await app.ready;
  app.optIn.checked = true;
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
  download.resolve();
  await tick();
  assert.equal(app.destroyed(), 1);
});

test("download progress never overwrites a failure the user must read", async () => {
  const app = popup({ availability: "downloadable", rendererError: new Error("Video changed") });
  await app.ready;
  app.optIn.checked = true;
  await app.click();
  assertRetry(app, /Video changed/);
  app.reportProgress(0.5);
  assert.equal(app.status.textContent, "Video changed", "the error stays on screen");
});

test("an ad after a ticked click keeps the offer hidden and starts no second download", async () => {
  const options = { availability: "downloadable", transcriptResultError: "Wait for the ad to finish" };
  const app = popup(options);
  await app.ready;
  app.optIn.checked = true;
  await app.click();
  assert.equal(app.body.dataset.state, "blocked");
  assert.equal(app.sessions.length, 1, "one download");
  assert.equal(app.offer.hidden, true);
  // The ad recheck repaints the idle state; the ticked box must not come back with it.
  await app.checkAd();
  assert.equal(app.body.dataset.state, "idle");
  assert.equal(app.offer.hidden, true, "a started download is never offered again");
  delete options.transcriptResultError;
  await app.click();
  assert.equal(app.sessions.length, 1, "no second 4 GB download");
  assertSuccess(app, { modelOnDevice: false });
});

test("a download Chrome refuses fails silently and the chapters are still named", async () => {
  const app = popup({ availability: "downloadable", createError: new Error("Not enough space") });
  await app.ready;
  app.optIn.checked = true;
  await app.click();
  assert.equal(app.sessions.length, 0, "no session survived the failed create");
  assert.equal(app.createCalls.length, 1);
  assertKeywordChapters(app);
  assertSuccess(app, { modelOnDevice: false });
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

test("a model that goes away between the two reads leaves the chapters to the keyword titler", async () => {
  const app = popup({ availabilityAfter: "unavailable" });
  await app.ready;
  await tick();
  await app.click();
  assert.equal(app.sessions.length, 0);
  assert.equal(app.prompted(), 0);
  assertKeywordChapters(app);
  assertSuccess(app);
});

// Evaluation runs ask for the model and nothing else, so a missing model stays a failed run.
for (const [name, options] of [
  ["a model that went away", { availability: "unavailable" }],
  ["a missing Prompt API", { missingApi: true }],
]) {
  test(`${name} fails a run that asked for no keyword titles`, async () => {
    const app = popup(options);
    const run = { loadTranscript: async () => harnessTranscript, controller: new AbortController(), useModel: true };
    await assert.rejects(app.generateChapterData(run), /Gemini Nano unavailable/);
    const { chapters } = await app.generateChapterData({
      ...run, controller: new AbortController(), fallbackTitles: true,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(chapters)).map(chapter => chapter.timestamp), [0, 180, 360, 540]);
  });
}

test("model startup and transcript setup do not consume the generation budget", async () => {
  const model = deferred();
  const transcript = deferred();
  const prompt = deferred();
  const app = popup({ modelReady: model.promise, transcriptReady: transcript.promise, promptReady: prompt.promise });
  await app.ready;
  const run = app.click();
  await tick();
  app.advance(120_000);
  assert.equal(app.timers.size, 0);
  model.resolve();
  await tick();
  assert.equal(app.timers.size, 0);
  transcript.resolve();
  await tick();
  assert.equal(app.prompted(), 1);
  assert.equal([...app.timers.values()][0].delay, 60_000);
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

test("closing popup aborts generation and prevents its result from rendering", async () => {
  const prompt = deferred();
  const app = popup({ promptReady: prompt.promise });
  await app.ready;
  const run = app.click();
  await tick();
  app.close();
  assert.equal(app.prompts[0].options.signal.aborted, true);
  prompt.resolve();
  await run;
  assert.equal(app.calls.length, 1);
  assert.equal(app.destroyed(), 1);
});

test("closing popup during the tab lookup prevents model and transcript work", async () => {
  const pending = deferred();
  const app = popup({ tabReady: pending.promise });
  const run = app.click();
  await tick();
  app.close();
  pending.resolve();
  await Promise.all([run, app.ready]);
  assert.equal(app.sessions.length, 0);
  assert.equal(app.calls.length, 0);
  assert.equal(app.timers.size, 0);
});

for (const [name, options] of [
  ["missing Prompt API", { missingApi: true }],
  ["unavailable model", { availability: "unavailable" }],
]) {
  test(`${name} names the chapters in code and never mentions Gemini Nano`, async () => {
    const app = popup(options);
    await app.ready;
    assert.equal(app.offer.hidden, true, "nothing to download, so nothing to offer");
    await app.click();
    assertKeywordChapters(app);
    assertSuccess(app, { modelOnDevice: false });
    assert.equal(app.sessions.length, 0);
    assert.equal(app.calls.length, 2);
    assert.equal(app.errors.length, 0);
    assert.ok(!app.labels.some(text => /Nano|Chrome AI/.test(text)), app.labels.join(" | "));
  });
}

for (const [name, options, message] of [
  ["no active tab", { tab: null }, /Open a YouTube video/],
  ["non-YouTube tab", { tab: { id: 42, url: "https://example.com/watch?v=test" } }, /Open a YouTube video/],
  ["empty video id", { tab: { id: 42, url: "https://www.youtube.com/watch?v=" } }, /Open a YouTube video/],
  ["insecure page", { tab: { id: 42, url: "http://www.youtube.com/watch?v=test" } }, /Open a YouTube video/],
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
  const app = popup({ transcriptResult: { duration: 720, cues: [{ time: 0, text: "Only opening words" }], title: "Sparse talk" } });
  await app.ready;
  await app.click();
  assert.equal(app.body.dataset.state, "success");
  assert.deepEqual([...app.prompts[0].options.responseConstraint.required], ["chapter1"]);
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls[1].args[0])), [{ timestamp: 0, title: "Generated opening" }]);
  assert.equal(app.destroyed(), 1);
});

const generatedTitles = Object.fromEntries(Object.entries(generated).map(([key, chapter]) => [key, chapter.title]));
for (const [name, options] of [
  ["missing title key", { titleRaw: JSON.stringify({ ...generatedTitles, chapter2: undefined }) }],
  ["extra title key", { titleRaw: JSON.stringify({ ...generatedTitles, chapter5: "Unexpected chapter" }) }],
  ["wrong title type", { titleRaw: JSON.stringify({ ...generatedTitles, chapter2: 123 }) }],
  ["blank title", { titleRaw: JSON.stringify({ ...generatedTitles, chapter2: "   " }) }],
  ["oversized title", { titleRaw: JSON.stringify({ ...generatedTitles, chapter2: "x".repeat(61) }) }],
  ["narrative outside JSON", { titleRaw: "Here are the chapters: " + JSON.stringify(generatedTitles) }],
  ["a model failure", { titleError: new Error("Model failed") }],
]) {
  // The model output is still rejected; the popup then names the chapters in code rather than failing.
  test(`title step rejects ${name} and falls back to keyword titles`, async () => {
    const app = popup(options);
    await app.ready;
    await app.click();
    assertSuccess(app);
    assertKeywordChapters(app);
    assert.equal(app.prompted(), 1);
    assert.equal(app.calls.length, 2);
    assert.equal(app.destroyed(), 1);
  });
}

test("a single JSON fence is accepted without repairing title contents", async () => {
  const app = popup({ titleRaw: "```json\n" + JSON.stringify(generatedTitles) + "\n```" });
  await app.ready;
  await app.click();
  assertSuccess(app);
  assert.equal(app.calls[1].args[0][1].title, generated.chapter2.title);
});

for (const action of ["close", "timeout"]) {
  test(`${action} during title generation destroys the session and ${action === "close" ? "renders nothing" : "names the chapters in code"}`, async () => {
    const titles = deferred();
    const app = popup({ promptReady: titles.promise });
    await app.ready;
    const run = app.click();
    await tick();
    assert.equal(app.prompted(), 1);
    assert.equal(app.sessions.length, 1);
    assert.equal(app.prompts[0].options.signal.aborted, false);
    if (action === "timeout") {
      app.expireGeneration();
      await run;
      assertSuccess(app);
      assertKeywordChapters(app);
    } else app.close();
    titles.resolve();
    await run;
    // A closed popup renders nothing; a timeout has already rendered the code-named chapters.
    assert.equal(app.calls.length, action === "close" ? 1 : 2);
    assert.equal(app.destroyed(), 1);
    assert.equal(app.timers.size, 0);
  });
}

test("title sections contain their selected spans and exclude the next section", () => {
  const app = popup();
  const prompt = app.buildTitlePrompt([
    { time: 0, text: "Opening evidence" }, { time: 50, text: "Transition evidence" },
    { time: 99, text: "Closing evidence" },
  ], 100, [0, 50]);
  const firstSection = prompt.split("chapter1 contains ONLY")[1].split("chapter2 contains ONLY")[0];
  assert.match(firstSection, /Opening evidence/);
  assert.doesNotMatch(firstSection, /Transition evidence|Closing evidence/);
  assert.match(prompt.split("chapter2 contains ONLY")[1], /Transition evidence[\s\S]*Closing evidence/);
});

test("dense transcripts keep the title prompt bounded", () => {
  const app = popup();
  const cues = Array.from({ length: 7200 }, (_, time) => ({ time, text: "Dense caption content ".repeat(100) }));
  const starts = app.selectStarts({ duration: 7200, cues });
  assert.equal(starts.length, 10);
  assert.ok(app.buildTitlePrompt(cues, 7200, starts).length < 26_000);
});

test("title sections keep their first three cues and sample the rest, twelve cues at most", () => {
  const app = popup();
  const cues = Array.from({ length: 40 }, (_, index) => ({ time: index * 5, text: `Cue ${index}` }));
  const prompt = app.buildTitlePrompt(cues, 200, [0]);
  const lines = prompt.split("chapter1 contains ONLY 0-200 seconds:\n")[1].split("\n");
  // Cues 0-2 set up the topic; the remaining 37 are sampled every fifth cue.
  assert.deepEqual(lines, [0, 1, 2, 3, 8, 13, 18, 23, 28, 33, 38].map(index => `${index * 5}s Cue ${index}`));
  const short = app.buildTitlePrompt(cues.slice(0, 12), 60, [0]);
  assert.equal(short.split("\n").filter(line => /^\d+s Cue/.test(line)).length, 12);
});

test("chapter count follows duration and starts stay half an average chapter apart, with the first allowed from 60 s", () => {
  const app = popup();
  // Every caption announces a topic, so only duration and spacing limit the choice.
  const transcript = duration => ({ duration, cues: Array.from({ length: Math.ceil(duration / 15) }, (_, index) => ({ time: index * 15, text: `Next, topic ${index}.` })) });
  for (const [duration, count] of [[100, 4], [600, 4], [1349, 7], [1350, 8], [7200, 10]]) {
    const starts = app.selectStarts(transcript(duration));
    assert.equal(starts.length, count, `${duration}`);
    assert.equal(starts[0], 0);
    const gap = duration / count / 2;
    starts.slice(1).forEach((start, index) => {
      assert.ok(start - starts[index] >= (index ? gap : Math.min(gap, 60)) && start <= duration - gap, `${duration}: ${starts}`);
    });
    // Creators often end an intro at about a minute, so the first start may sit there on long videos.
    if (duration === 600) assert.equal(starts[1], 60);
  }
});

test("starts prefer announced topic changes over continuing captions", () => {
  const app = popup();
  const filler = ["and the same part keeps going here", "with more of the same example text", "still about the same part of this story"];
  const cues = Array.from({ length: 48 }, (_, index) => ({ time: index * 15, text: filler[index % 3] }));
  for (const [time, text] of [[165, "Next, let's talk about batteries."], [390, "Moving on to the camera."], [570, "Finally, the verdict."]]) {
    cues.find(cue => cue.time === time).text = text;
  }
  assert.deepEqual([...app.selectStarts({ duration: 720, cues })], [0, 165, 390, 570]);
});

test("starts ignore captions that only look like announcements or questions", () => {
  const app = popup();
  // Punctuated filler keeps these decoys on the punctuated path; unpunctuated captions ignore line-start openers.
  const filler = ["and the same part keeps going here.", "with more of the same example text.", "still about the same part of this story."];
  for (const decoy of ["Now, if the same part keeps going here", "So what is the same part keeps going", "and the same part keeps going, right?", "[music] and the same part keeps going here"]) {
    const cues = Array.from({ length: 48 }, (_, index) => ({ time: index * 15, text: filler[index % 3] }));
    for (const [time, text] of [[165, "Next, let's talk about batteries."], [390, "Moving on to the camera."], [570, decoy]]) {
      cues.find(cue => cue.time === time).text = text;
    }
    const starts = app.selectStarts({ duration: 720, cues });
    assert.ok(starts.includes(165) && starts.includes(390) && !starts.includes(570), `${decoy}: ${starts}`);
  }
});

test("a speaker turn that opens with a real question starts a chapter", () => {
  const app = popup();
  const cues = Array.from({ length: 48 }, (_, index) => ({ time: index * 15, text: "and the same part keeps going here" }));
  for (const [time, text] of [[165, "Next, let's talk about batteries."], [390, "Moving on to the camera."], [495, "- Did pricing change later?"], [570, "- What made you decide to leave"], [585, "the company after all those years?"]]) {
    cues.find(cue => cue.time === time).text = text;
  }
  assert.deepEqual([...app.selectStarts({ duration: 720, cues })], [0, 165, 390, 570]);
});

test("a section marker inside a long caption starts a chapter at its own sentence", () => {
  const app = popup();
  const cues = Array.from({ length: 48 }, (_, index) => ({ time: index * 15, text: "and the same part keeps going here" }));
  for (const [time, text] of [[165, "Next, let's talk about batteries."], [390, "Moving on to the camera."]]) {
    cues.find(cue => cue.time === time).text = text;
  }
  // Auto-generated captions hold several sentences; "Part three." sits 30 of 60 characters into a 15-second caption.
  cues.find(cue => cue.time === 555).text = "the same part keeps going. Part three. The verdict here.";
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.deepEqual(starts, [0, 165, 390, 562]);
  const sections = app.splitAtStarts(cues, 720, starts).filter(cue => cue.time >= 555 && cue.time < 570);
  assert.deepEqual(sections.map(cue => [cue.time, cue.text]), [[555, "the same part keeps going."], [562, "Part three. The verdict here."]]);
});

test("step openings and questions inside a caption do not start chapters", () => {
  const app = popup();
  const filler = ["and the same part keeps going here", "with more of the same example text", "still about the same part of this story"];
  for (const inside of ["Let's go back to the beginning.", "Now I can play it.", "So what did he do?", "Okay, so we keep going."]) {
    const cues = Array.from({ length: 48 }, (_, index) => ({ time: index * 15, text: filler[index % 3] }));
    for (const [time, text] of [[165, "Next, let's talk about batteries."], [390, "Moving on to the camera."], [555, `the same part keeps going. ${inside}`]]) {
      cues.find(cue => cue.time === time).text = text;
    }
    const starts = app.selectStarts({ duration: 720, cues });
    assert.ok(starts.every(start => start < 555 || start >= 570), `${inside}: ${starts}`);
  }
});

test("in unpunctuated captions a section word or topic turn starts a chapter at its own word, even across lines", () => {
  const app = popup();
  const cues = Array.from({ length: 240 }, (_, index) => ({ time: index * 3, text: "and the same part keeps going here" }));
  // "step number two" begins 30 of 34 characters into the 3-second line at 165 and ends on the next line.
  cues.find(cue => cue.time === 165).text = "and the same part keeps going step";
  cues.find(cue => cue.time === 168).text = "number two is the battery test";
  cues.find(cue => cue.time === 390).text = "so speaking of the camera lens";
  cues.find(cue => cue.time === 570).text = "my final point is the verdict";
  assert.deepEqual([...app.selectStarts({ duration: 720, cues })], [0, 167, 390, 570]);
});

test("in unpunctuated captions an opener at a line start does not announce", () => {
  const app = popup();
  const cues = Array.from({ length: 240 }, (_, index) => ({ time: index * 3, text: "and the same part keeps going here" }));
  cues.find(cue => cue.time === 165).text = "moving on to the battery";
  cues.find(cue => cue.time === 390).text = "let's talk about the camera";
  // A width break put "next" at the start of a line in the middle of a sentence.
  cues.find(cue => cue.time === 567).text = "and the same part keeps going and";
  cues.find(cue => cue.time === 570).text = "next to it the same part keeps";
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.ok(starts.includes(165) && starts.includes(390) && !starts.includes(570), `${starts}`);
});

test("a topic turn inside a punctuated caption starts a chapter at its own word", () => {
  const app = popup();
  const cues = Array.from({ length: 48 }, (_, index) => ({ time: index * 15, text: "And the same part keeps going here." }));
  for (const [time, text] of [[165, "Next, let's talk about batteries."], [390, "Moving on to the camera."]]) {
    cues.find(cue => cue.time === time).text = text;
  }
  // "speaking of" begins 20 of 55 characters into a 15-second caption, mid-sentence.
  cues.find(cue => cue.time === 555).text = "It keeps going, and speaking of the verdict, it's good.";
  assert.deepEqual([...app.selectStarts({ duration: 720, cues })], [0, 165, 390, 560]);
});

test("a caption of only sounds never becomes a start", () => {
  const app = popup();
  for (const sound of ["[Music]", "[music]", "[Applause] [Music]"]) {
    const cues = [];
    for (let time = 0; time < 720; time += 3) {
      if (time === 555 || time === 558) continue;
      cues.push({ time, text: time < 552 ? "and the same part keeps going here" : `battery chemistry ${time} changes charging behaviour` });
    }
    cues.find(cue => cue.time === 165).text = "next let's talk about batteries";
    cues.find(cue => cue.time === 390).text = "moving on to the camera";
    cues.find(cue => cue.time === 552).text = sound;
    const starts = [...app.selectStarts({ duration: 720, cues })];
    // The vocabulary dip is measured every 5 seconds, so the start can land on the last line before the break.
    assert.ok(!starts.includes(552) && starts.some(start => start >= 549 && start <= 561), `${sound}: ${starts}`);
  }
});

test("a lasting change of vocabulary outranks a question inside a topic", () => {
  const app = popup();
  // Three topics with their own words and no spoken marker; each caption also has words of its own, and a question
  // sits inside each topic.
  const topics = [["battery", "charging", "cable"], ["camera", "lens", "sensor"], ["speaker", "volume", "bass"]];
  const cues = Array.from({ length: 48 }, (_, index) => {
    const [first, second] = [topics[Math.floor(index / 16)][index % 3], topics[Math.floor(index / 16)][(index + 1) % 3]];
    return { time: index * 15, text: `The ${first} and ${second} matter for item${index} and extra${index}.` };
  });
  for (const time of [105, 345, 585]) cues.find(cue => cue.time === time).text = `Why does item${time} change it?`;
  const starts = [...app.selectStarts({ duration: 720, cues })];
  assert.ok(starts.includes(240) && starts.includes(480), `${starts}`);
});

test("captions without an inner section marker keep their title sections", () => {
  const app = popup();
  const cues = [{ time: 0, text: "Opening. Still opening." }, { time: 50, text: "Middle. Next, more." }, { time: 99, text: "Closing." }];
  assert.deepEqual(app.splitAtStarts(cues, 100, [0, 50]), cues);
});

test("no chapter runs longer than two average chapters", () => {
  const app = popup();
  const cues = Array.from({ length: 48 }, (_, index) => ({ time: index * 15, text: "and the same part keeps going here" }));
  for (const [time, text] of [[105, "Next, the battery."], [210, "Moving on to the camera."], [315, "Finally, the verdict."]]) {
    cues.find(cue => cue.time === time).text = text;
  }
  const edges = [...app.selectStarts({ duration: 720, cues }), 720];
  assert.equal(edges.length, 5);
  assert.ok(edges.slice(1).every((edge, index) => edge - edges[index] <= 360), `${edges}`);
});

test("sparse captions never invent starts", () => {
  const app = popup();
  assert.deepEqual([...app.selectStarts({ duration: 720, cues: [{ time: 0, text: "Only opening words" }] })], [0]);
  // Captions only in the first minute of a 12-minute video leave no candidate half an average chapter from the start.
  const early = Array.from({ length: 12 }, (_, index) => ({ time: index * 5, text: `Next, part ${index}.` }));
  assert.deepEqual([...app.selectStarts({ duration: 720, cues: early })], [0]);
});

test("title prompt uses the video title only as naming context", () => {
  const app = popup();
  const cues = [{ time: 0, text: "Opening evidence" }, { time: 50, text: "Later evidence" }];
  assert.match(app.buildTitlePrompt(cues, 100, [0, 50], "Headset \"review\""), /The video is titled "Headset \\"review\\""; use that only to identify its product or subject/);
  const untitled = app.buildTitlePrompt(cues, 100, [0, 50]);
  assert.doesNotMatch(untitled, /video is titled/);
  assert.match(untitled, /3-7 words and at most 60 characters/);
});

for (const [format, panelLayout] of [
  ["legacy", "legacy"],
  ["modern", "legacy"],
  ["modern", "combined"],
  ["modern", "combined-loading"],
]) {
  for (const alreadyOpen of [true, false]) {
    test(`${format} transcript reads the ${alreadyOpen ? "already-open" : "newly-opened"} ${panelLayout} panel without hidden duplicate cues`, async () => {
      const app = popup();
      const rowTag = format === "legacy" ? "ytd-transcript-segment-renderer" : "transcript-segment-view-model";
      const timestampSelector = format === "legacy" ? ".segment-timestamp" : ".ytwTranscriptSegmentViewModelTimestamp";
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
      const visibleRows = [row("0:00", "Where are all the aliens?"), row("2:14:07", "Closing\n  topic\tnow")];
      const hiddenRows = [row("0:00", "Hidden duplicate"), row("2:14:07", "Hidden duplicate")];
      const rowsFor = (selector, rows) => {
        const found = selector.split(",").map((value) => value.trim()).includes(rowTag) ? [...rows] : [];
        found.item = (index) => found[index];
        return found;
      };
      let isExpanded = alreadyOpen;
      let loaded = panelLayout !== "combined-loading";
      let closes = 0;
      let opens = 0;
      const expanded = {
        getAttribute: () => isExpanded ? "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" : "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN",
        querySelector(selector) {
          if (selector === "#visibility-button button") return { click() { isExpanded = false; closes++; } };
          return loaded ? rowsFor(selector, visibleRows)[0] || null : null;
        },
        querySelectorAll: (selector) => rowsFor(selector, loaded ? visibleRows : []),
      };
      const hidden = {
        getAttribute: () => "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN",
        querySelector() { assert.fail("Hidden duplicate panel must not be used"); },
        querySelectorAll: (selector) => rowsFor(selector, hiddenRows),
      };
      let clock = 0;
      const styles = [];
      const result = await vm.runInNewContext(`(${app.fetchTranscript.toString()})("original-video")`, {
        URL,
        location: { href: "https://www.youtube.com/watch?v=original-video" },
        window: {},
        performance: { now: () => clock },
        setTimeout(callback) { clock += 50; loaded = true; callback(); },
        document: {
          createElement(tag) {
            assert.equal(tag, "style");
            const style = { textContent: "", attached: false, remove() { this.attached = false; } };
            styles.push(style);
            return style;
          },
          head: { append(style) { style.attached = true; } },
          querySelector(selector) {
            if (selector === "#movie_player") return {
              classList: { contains: () => false },
              getDuration: () => 8049.781,
              getPlayerResponse: () => ({
                videoDetails: { videoId: "original-video", title: "Aliens talk" },
                captions: { playerCaptionsTracklistRenderer: { captionTracks: [{}] } },
              }),
            };
            if (selector.startsWith("ytd-engagement-panel-section-list-renderer")) {
              const matchesPanel = selector.split(",").some((part) => panelLayout === "legacy"
                ? part.includes("[target-id='engagement-panel-searchable-transcript']")
                : part.includes(loaded ? "[data-target-id='PAmodern_transcript_view']" : "[target-id='PAmodern_transcript_view']"));
              if (!matchesPanel) return null;
              return selector.includes("ENGAGEMENT_PANEL_VISIBILITY_EXPANDED") ? (isExpanded ? expanded : null) : hidden;
            }
            if (selector === "tp-yt-paper-button#expand") return null;
            if (selector === "ytd-video-description-transcript-section-renderer button") {
              return { click() { opens++; isExpanded = true; } };
            }
            return rowsFor(selector, [...hiddenRows, ...visibleRows])[0] || null;
          },
          querySelectorAll: (selector) => rowsFor(selector, [...hiddenRows, ...visibleRows]),
        },
      });
      assert.deepEqual(JSON.parse(JSON.stringify(result)), {
        cues: [{ time: 0, text: "Where are all the aliens?" }, { time: 8047, text: "Closing topic now" }],
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
    });
  }
}

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
  assert.equal(app.labels.includes("Generating chapters..."), true);
  assert.equal(app.errors.length, 0);
  assert.equal(app.timers.size, 0, "no generation timeout is armed");
});

test("closing the popup during transcript retrieval renders nothing", async () => {
  const transcriptReady = deferred();
  const app = popup({ availability: "unavailable", transcriptReady: transcriptReady.promise });
  await app.ready;
  const clicked = app.click();
  await tick();
  app.close();
  transcriptReady.resolve();
  await clicked;
  assert.equal(app.calls.length, 1);
  assert.equal(app.sessions.length, 0);
});

test("section cues cover each chapter's span and split a straddling caption", () => {
  const app = popup();
  const sections = app.sectionCues({ duration: 100, cues: [
    { time: 0, text: "Opening words. Next, the middle topic starts here." },
    { time: 60, text: "The end." },
  ] }, [0, 18, 60]); // "Next," begins 15 of 51 characters in, so the split piece is timed at 18 s
  assert.deepEqual(sections.map(section => [section.start, section.end]), [[0, 18], [18, 60], [60, 100]]);
  assert.deepEqual(sections.map(section => section.cues.length), [1, 1, 1]);
  assert.match(sections[1].cues[0].text, /^Next, the middle topic/);
  assert.equal(sections[1].cues[0].time, 18);
});

// Keyword titler: fixtures name the behaviour, not the whole word lists.
function sections(...specs) {
  return specs.map(([start, end, texts]) => ({ start, end, cues: texts.map((text, index) => ({ time: start + index * 5, text })) }));
}

test("an announced topic names its section and a repeated word ends the phrase", () => {
  const app = popup();
  const titles = app.nameChapters(sections(
    [0, 60, ["welcome to the channel", "today we look at tents", "there are many tents"]],
    [60, 200, ["let's talk about price the price of a premium tent is high", "price matters and the price ranges vary", "cheap tents leak"]],
    [200, 300, ["now for the season rating", "a three season tent", "the season rating tells you", "season matters"]],
  ), "How To Choose A Tent");
  assert.deepEqual(titles, ["Intro", "Price", "Season Rating"]);
});

test("numbered section words become labels with the announced phrase", () => {
  const app = popup();
  const titles = app.nameChapters(sections(
    [0, 60, ["intro words here", "fishing is fun"]],
    [60, 200, ["mistake five wrong strength line.", "the strength line breaks", "use a strong line", "strength line again"]],
    [200, 300, ["mistake seven bad hooks.", "hooks rust", "sharp hooks matter", "hooks again"]],
  ), "Fishing Mistakes");
  assert.deepEqual(titles, ["Intro", "Mistake 5: Wrong Strength Line", "Mistake 7: Bad Hooks"]);
});

test("a repeated collocation beats its single words without an announcement", () => {
  const app = popup();
  const titles = app.nameChapters(sections(
    [0, 200, ["the heating element warms the water", "a heating element can fail", "check the heating element", "hot water helps"]],
    [200, 400, ["the rinse aid dispenser", "rinse aid stops spots", "fill the rinse aid", "rinse aid is cheap"]],
  ), "Dishwasher Tips");
  assert.deepEqual(titles, ["Heating Element", "Rinse Aid"]);
});

test("short thin edge sections read Intro and Outro, and wordless sections never throw", () => {
  const app = popup();
  assert.deepEqual(app.nameChapters(sections(
    [0, 20, ["hey everyone", "welcome back"]],
    [20, 400, ["the dutch oven bakes bread", "a dutch oven holds heat", "dutch oven again", "bread bakes well"]],
    [400, 430, ["thanks for watching", "see you next time"]],
  ), "Sourdough"), ["Intro", "Dutch Oven", "Outro"]);
  for (const odd of [
    sections([0, 60, ["[Music]"]], [60, 120, ["[Applause]", "[Music]"]]),
    [{ start: 0, end: 10, cues: [] }],
    sections([0, 300, ["supercalifragilisticexpialidocious ".repeat(12)]]),
    [],
  ]) {
    const titles = app.nameChapters(odd, undefined);
    assert.equal(titles.length, odd.length);
    assert.ok(titles.every(title => typeof title === "string" && title.length >= 3 && title.length <= 60), JSON.stringify(titles));
  }
});
