function injectChapters(chapters, expectedVideoId) {
  const videoId = new URL(location.href).searchParams.get("v");
  if (expectedVideoId && expectedVideoId !== videoId) {
    return { error: "Video changed" };
  }
  const player = document.querySelector("#movie_player");
  const video = player?.querySelector("video");
  const panels = document.querySelector("#panels");
  // YouTube can keep a hidden duplicate outside the bottom player controls.
  const progress = player?.querySelector(".ytp-chrome-bottom .ytp-progress-bar");
  const controls = player?.querySelector(".ytp-left-controls");
  if (!video || !panels || !progress || !controls) {
    return { error: "Video still loading" };
  }
  window.__nanoChaptersCleanup?.();
  document.querySelector("#nano-chapters-style")?.remove();

  const listeners = new AbortController();
  const { signal } = listeners;
  const timeLabel = (seconds) => {
    const whole = Math.floor(seconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const remainder = String(whole % 60).padStart(2, "0");
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}`
      : `${minutes}:${remainder}`;
  };
  const style = document.createElement("style");
  style.id = "nano-chapters-style";
  style.textContent = `
    #nano-chapters-panel { box-sizing:border-box; width:100%; color:var(--yt-spec-text-primary,#f1f1f1); background:var(--yt-spec-raised-background,#212121); border:1px solid var(--yt-spec-10-percent-layer,rgba(255,255,255,.2)); border-radius:12px; overflow:hidden; font:14px Roboto,Arial,sans-serif; margin-bottom:16px; }
    #nano-chapters-panel[hidden], .nano-chapters-hover[hidden] { display:none!important; }
    #nano-chapters-panel * { box-sizing:border-box; }
    #nano-chapters-panel .nano-chapters-heading { display:flex; align-items:center; justify-content:space-between; padding:12px 12px 8px 16px; border-bottom:1px solid var(--yt-spec-10-percent-layer,rgba(255,255,255,.2)); }
    #nano-chapters-panel h2 { margin:0; font-size:20px; line-height:28px; font-weight:700; }
    #nano-chapters-panel button { font:inherit; color:inherit; cursor:pointer; border:0; }
    #nano-chapters-panel .nano-chapters-close { display:grid; place-items:center; width:40px; height:40px; padding:8px; border-radius:50%; background:transparent; }
    #nano-chapters-panel .nano-chapters-close:hover { background:var(--yt-spec-10-percent-layer,rgba(255,255,255,.1)); }
    #nano-chapters-panel .nano-chapters-list { margin:0; padding:0 0 8px; list-style:none; overflow-y:auto; max-height:var(--nano-chapters-list-height,430px); scrollbar-width:thin; }
    #nano-chapters-panel .nano-chapters-row { display:flex; align-items:center; gap:16px; width:100%; min-height:72px; padding:8px 16px; background:transparent; text-align:left; }
    #nano-chapters-panel .nano-chapters-row:hover, #nano-chapters-panel .nano-chapters-row[aria-current=true] { background:var(--yt-spec-10-percent-layer,rgba(255,255,255,.1)); }
    #nano-chapters-panel .nano-chapters-thumbnail { position:relative; width:100px; height:56px; overflow:hidden; border-radius:4px; flex:none; background:var(--yt-spec-10-percent-layer,rgba(255,255,255,.1)); }
    #nano-chapters-panel .nano-chapters-thumbnail img { position:absolute; max-width:none; object-fit:cover; }
    #nano-chapters-panel .nano-chapters-copy { min-width:0; }
    #nano-chapters-panel .nano-chapters-name { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; font-weight:500; line-height:20px; }
    #nano-chapters-panel .nano-chapters-timestamp { display:inline-block; margin-top:4px; padding:2px 6px; border-radius:4px; background:rgba(62,166,255,.2); color:var(--yt-spec-call-to-action,#3ea6ff); font-size:12px; font-weight:500; line-height:16px; }
    #nano-chapters-panel button:focus-visible { outline:2px solid var(--yt-spec-call-to-action,#3ea6ff); outline-offset:-2px; }
    #panels.nano-chapters-panel-open > ytd-engagement-panel-section-list-renderer { display:none!important; }
    #movie_player .nano-chapters-title { display:flex; flex:none; align-self:center; align-items:center; gap:8px; height:40px; padding:0 16px; border:0; border-radius:28px; background:rgba(0,0,0,.3); color:#fff; font:13px Roboto,Arial,sans-serif; cursor:pointer; text-align:left; }
    #movie_player .nano-chapters-title-text { white-space:nowrap; }
    #movie_player .nano-chapters-chevron { flex:none; width:20px; height:20px; }
    #movie_player .nano-chapters-title:focus-visible { outline:2px solid #fff; outline-offset:-2px; }
    #movie_player.nano-chapters-active:not(.ad-showing) .ytp-chapter-container { display:none!important; }
    #movie_player.nano-chapters-active:not(.ad-showing) .ytp-progress-bar:has(> .nano-chapters-track) > .ytp-chapters-container { opacity:0!important; }
    #movie_player.nano-chapters-active:not(.ad-showing) .ytp-tooltip-progress-bar-pill-title { visibility:hidden; }
    #movie_player.nano-chapters-active:not(.ad-showing) .ytp-tooltip-progress-bar-pill-title[data-nano-chapters-title] { visibility:visible; font-size:0!important; }
    #movie_player.nano-chapters-active:not(.ad-showing) .ytp-tooltip-progress-bar-pill-title[data-nano-chapters-title]::after { content:attr(data-nano-chapters-title); font:500 13px Roboto,Arial,sans-serif; }
    #movie_player .nano-chapters-track { position:absolute; inset:0; pointer-events:none; z-index:1; }
    #movie_player .nano-chapters-segment { position:absolute; top:0; height:100%; overflow:hidden; background:rgba(255,255,255,.2); }
    #movie_player .nano-chapters-loaded, #movie_player .nano-chapters-played { position:absolute; inset:0 auto 0 0; height:100%; }
    #movie_player .nano-chapters-loaded { background:rgba(255,255,255,.4); }
    #movie_player .nano-chapters-played { background:#f03; }
    #movie_player .nano-chapters-hover { position:absolute; bottom:calc(100% + 28px); max-width:280px; padding:5px 8px; border-radius:4px; transform:translateX(-50%); background:rgba(0,0,0,.8); color:#fff; font:500 13px Roboto,Arial,sans-serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none; z-index:40; }
    #movie_player.ad-showing .nano-chapters-track, #movie_player.ad-showing .nano-chapters-title, #movie_player.ad-showing .nano-chapters-hover { display:none!important; }
    #movie_player #nano-chapters-panel { position:absolute; z-index:60; right:24px; bottom:72px; width:360px; max-width:calc(100% - 48px); text-shadow:none; }
  `;
  document.head.append(style);

  const panel = document.createElement("section");
  panel.id = "nano-chapters-panel";
  panel.setAttribute("aria-label", "Generated chapters");
  const headingRow = document.createElement("div");
  headingRow.className = "nano-chapters-heading";
  const heading = document.createElement("h2");
  heading.textContent = "Generated Chapters";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "nano-chapters-close";
  close.setAttribute("aria-label", "Close chapters");
  const closeIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  closeIcon.setAttribute("width", "24");
  closeIcon.setAttribute("height", "24");
  closeIcon.setAttribute("viewBox", "0 0 24 24");
  closeIcon.setAttribute("aria-hidden", "true");
  const closePath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  closePath.setAttribute("d", "m6 6 12 12M6 18 18 6");
  closePath.setAttribute("fill", "none");
  closePath.setAttribute("stroke", "currentColor");
  closePath.setAttribute("stroke-width", "1.5");
  closeIcon.append(closePath);
  close.append(closeIcon);
  headingRow.append(heading, close);
  const list = document.createElement("ol");
  list.className = "nano-chapters-list";
  panel.append(headingRow, list);

  const playerResponse = player.getPlayerResponse?.() || window.ytInitialPlayerResponse;
  const thumbnail = playerResponse?.videoDetails?.thumbnail?.thumbnails?.at(-1)?.url
    || document.querySelector('meta[property="og:image"]')?.content;
  // YouTube supplies signed storyboard sheets for the player's own seek previews.
  const storyboard = playerResponse?.storyboards?.playerStoryboardSpecRenderer?.spec?.split("|");
  const sheets = (storyboard?.slice(1) || []).map((value, level) => {
    const [width, height, count, columns, rows, interval, name, signature] = value.split("#");
    return { level, width: +width, height: +height, count: +count, columns: +columns, rows: +rows, interval: +interval, name, signature };
  }).filter((sheet) => [sheet.width, sheet.height, sheet.count, sheet.columns, sheet.rows, sheet.interval].every((value) => Number.isFinite(value) && value > 0) && sheet.name && sheet.signature);
  const sheet = sheets.find((item) => item.width >= 100) || sheets[0];
  function chapterImage(timestamp) {
    const frame = document.createElement("span");
    frame.className = "nano-chapters-thumbnail";
    frame.setAttribute("aria-hidden", "true");
    const image = document.createElement("img");
    image.alt = "";
    const fallback = () => {
      image.style.cssText = "width:100px;height:56px;left:0;top:0";
      if (thumbnail) image.src = thumbnail;
      else image.remove();
    };
    frame.append(image);
    if (sheet) {
      const index = Math.min(sheet.count - 1, Math.floor(timestamp * 1000 / sheet.interval));
      const perSheet = sheet.columns * sheet.rows;
      const cell = index % perSheet;
      const name = sheet.name.replaceAll("$M", String(Math.floor(index / perSheet)));
      const url = URL.parse(storyboard[0].replaceAll("$L", String(sheet.level)).replaceAll("$N", name));
      if (!url) {
        fallback();
        return frame;
      }
      url.searchParams.set("sigh", sheet.signature);
      image.style.cssText = `width:${sheet.columns * 100}px;height:${sheet.rows * 56}px;left:${-(cell % sheet.columns) * 100}px;top:${-Math.floor(cell / sheet.columns) * 56}px`;
      image.addEventListener("error", fallback, { once: true, signal });
      image.src = url.href;
    } else fallback();
    return frame;
  }
  const rows = chapters.map((chapter) => {
    const item = document.createElement("li");
    const row = document.createElement("button");
    row.type = "button";
    row.className = "nano-chapters-row";
    row.setAttribute("aria-label", `${chapter.title}, ${timeLabel(chapter.timestamp)}`);
    const image = chapterImage(chapter.timestamp);
    const copy = document.createElement("span");
    copy.className = "nano-chapters-copy";
    const title = document.createElement("span");
    title.className = "nano-chapters-name";
    title.textContent = chapter.title;
    const timestamp = document.createElement("span");
    timestamp.className = "nano-chapters-timestamp";
    timestamp.textContent = timeLabel(chapter.timestamp);
    copy.append(title, timestamp);
    row.append(image, copy);
    item.append(row);
    list.append(item);
    row.addEventListener("click", () => {
      if (player.classList.contains("ad-showing")) return;
      video.currentTime = chapter.timestamp;
      video.play()?.catch(() => {});
      update();
    }, { signal });
    return row;
  });

  const titleButton = document.createElement("button");
  titleButton.type = "button";
  titleButton.className = "nano-chapters-title";
  titleButton.setAttribute("aria-controls", panel.id);
  const titleText = document.createElement("span");
  titleText.className = "nano-chapters-title-text";
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.classList.add("nano-chapters-chevron");
  arrow.setAttribute("viewBox", "0 0 24 24");
  arrow.setAttribute("aria-hidden", "true");
  const arrowPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  arrowPath.setAttribute("d", "M9.71 18.71l-1.42-1.42 5.3-5.29-5.3-5.29 1.42-1.42 6.7 6.71z");
  arrowPath.setAttribute("fill", "currentColor");
  arrow.append(arrowPath);
  titleButton.append(titleText, arrow);
  const timeDisplay = controls.querySelector(".ytp-time-display");
  if (timeDisplay) timeDisplay.after(titleButton);
  else controls.append(titleButton);

  const track = document.createElement("div");
  track.className = "nano-chapters-track";
  track.setAttribute("aria-hidden", "true");
  const segments = chapters.map(() => {
    const segment = document.createElement("div");
    segment.className = "nano-chapters-segment";
    const loaded = document.createElement("div");
    loaded.className = "nano-chapters-loaded";
    const played = document.createElement("div");
    played.className = "nano-chapters-played";
    segment.append(loaded, played);
    track.append(segment);
    return { segment, loaded, played };
  });
  const hover = document.createElement("div");
  hover.className = "nano-chapters-hover";
  hover.hidden = true;
  progress.append(track, hover);
  player.classList.add("nano-chapters-active");
  let activeIndex = -1;
  let open = true;

  function scrollToActiveChapter() {
    if (!open || activeIndex < 0) return;
    const row = rows[activeIndex];
    const rowTop = row.offsetTop - list.offsetTop;
    if (rowTop < list.scrollTop || rowTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = Math.max(0, rowTop - (list.clientHeight - row.offsetHeight) / 2);
    }
  }
  function setOpen(value, restoreFocus = false) {
    const reopening = value && !open;
    open = value;
    panel.hidden = !open;
    panels.classList.toggle("nano-chapters-panel-open", open && panel.parentNode === panels);
    titleButton.setAttribute("aria-expanded", String(open));
    if (reopening) scrollToActiveChapter();
    if (restoreFocus) titleButton.focus();
  }
  function layout() {
    const inFullscreen = document.fullscreenElement?.contains(player);
    const parent = inFullscreen ? player : panels;
    if (panel.parentNode !== parent) parent.prepend(panel);
    const height = inFullscreen ? player.clientHeight - 190 : player.clientHeight - 108;
    panel.style.setProperty("--nano-chapters-list-height", `${Math.max(144, height)}px`);
    setOpen(open);
  }
  function update() {
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0 || player.classList.contains("ad-showing")) return;
    const current = video.currentTime;
    const nextIndex = chapters.findLastIndex((chapter) => chapter.timestamp <= current);
    const index = Math.max(0, nextIndex);
    if (index !== activeIndex) {
      if (activeIndex >= 0) rows[activeIndex].removeAttribute("aria-current");
      activeIndex = index;
      rows[index].setAttribute("aria-current", "true");
      titleText.textContent = chapters[index].title;
      titleButton.setAttribute("aria-label", `${chapters[index].title}. Chapters`);
      titleButton.title = chapters[index].title;
      scrollToActiveChapter();
    }
    let buffered = 0;
    for (let range = 0; range < video.buffered.length; range++) {
      if (video.buffered.start(range) <= current) buffered = Math.max(buffered, video.buffered.end(range));
    }
    segments.forEach(({ segment, loaded, played }, chapterIndex) => {
      const start = chapters[chapterIndex].timestamp;
      const end = chapters[chapterIndex + 1]?.timestamp ?? duration;
      const length = Math.max(1, end - start);
      const gap = chapterIndex === chapters.length - 1 ? 0 : 4;
      segment.style.left = `${start / duration * 100}%`;
      segment.style.width = `calc(${length / duration * 100}% - ${gap}px)`;
      played.style.width = `${Math.max(0, Math.min(1, (current - start) / length)) * 100}%`;
      loaded.style.width = `${Math.max(0, Math.min(1, (buffered - start) / length)) * 100}%`;
    });
  }
  close.addEventListener("click", () => setOpen(false, true), { signal });
  // Reopening an already expanded transcript does not change its visibility attribute.
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("ytd-video-description-transcript-section-renderer button")) {
      setOpen(false);
    }
  }, { capture: true, signal });
  titleButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!open);
  }, { signal });
  panel.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      setOpen(false, true);
    }
  }, { signal });
  panel.addEventListener("click", (event) => event.stopPropagation(), { signal });
  titleButton.addEventListener("keydown", (event) => event.stopPropagation(), { signal });
  progress.addEventListener("pointermove", (event) => {
    if (player.classList.contains("ad-showing") || !Number.isFinite(video.duration)) return;
    const rect = progress.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const time = x / rect.width * video.duration;
    const index = Math.max(0, chapters.findLastIndex((chapter) => chapter.timestamp <= time));
    const nativeTitle = player.querySelector(".ytp-tooltip-progress-bar-pill-title");
    if (nativeTitle) nativeTitle.setAttribute("data-nano-chapters-title", chapters[index].title);
    hover.textContent = chapters[index].title;
    hover.hidden = Boolean(nativeTitle);
    hover.style.left = `${Math.max(80, Math.min(rect.width - 80, x))}px`;
  }, { signal });
  progress.addEventListener("pointerleave", () => { hover.hidden = true; }, { signal });
  for (const event of ["timeupdate", "seeking", "durationchange", "progress", "loadedmetadata"]) {
    video.addEventListener(event, update, { signal });
  }
  document.addEventListener("fullscreenchange", layout, { signal });
  const resize = new ResizeObserver(() => { layout(); update(); });
  resize.observe(player);
  const adState = new MutationObserver(() => {
    if (player.classList.contains("ad-showing")) hover.hidden = true;
    else update();
  });
  adState.observe(player, { attributes: true, attributeFilter: ["class"] });
  const nativePanels = new MutationObserver((records) => {
    const expanded = (element) => element instanceof Element
      && element.matches("ytd-engagement-panel-section-list-renderer")
      && element.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED";
    if (open && records.some((record) => record.type === "attributes"
      ? expanded(record.target)
      : [...record.addedNodes].some(expanded))) {
      setOpen(false);
    }
  });
  nativePanels.observe(panels, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["visibility"],
  });
  function cleanup() {
    listeners.abort();
    resize.disconnect();
    adState.disconnect();
    nativePanels.disconnect();
    panel.remove();
    titleButton.remove();
    track.remove();
    hover.remove();
    style.remove();
    player.querySelectorAll("[data-nano-chapters-title]").forEach((element) => {
      element.removeAttribute("data-nano-chapters-title");
    });
    player.classList.remove("nano-chapters-active");
    panels.classList.remove("nano-chapters-panel-open");
    if (window.__nanoChaptersCleanup === cleanup) delete window.__nanoChaptersCleanup;
  }
  window.__nanoChaptersCleanup = cleanup;
  document.addEventListener("yt-navigate-start", cleanup, { signal });
  document.addEventListener("yt-navigate-finish", () => {
    if (new URL(location.href).searchParams.get("v") !== videoId) cleanup();
  }, { signal });
  layout();
  update();
  return { count: chapters.length };
}
