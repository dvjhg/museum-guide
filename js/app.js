"use strict";

var CONTENT = window.CONTENT || {};
var ZONES = Array.isArray(CONTENT.zones) ? CONTENT.zones : [];
var ROUTES = Array.isArray(CONTENT.routes) ? CONTENT.routes : [];
var VENUE = CONTENT.venue || {};
var Player = window.Player;

var viewEl = document.getElementById("view");
var resumeBtn = document.getElementById("resumeBtn");
var toastEl = document.getElementById("toast");

var state = {
  view: "",
  param: "",
  zoneId: null,
  sectionIndex: 0,
  resumePrompt: null,
  startAt: 0,
  recommendId: null,
  filter: "all",
  continueAction: null,
  seeking: false,
  scriptTab: "text"
};

var toastTimer = 0;

var HTML_ESCAPE = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function esc(value) {
  return String(value === undefined || value === null ? "" : value).replace(
    /[&<>"']/g,
    function (character) {
      return HTML_ESCAPE[character];
    }
  );
}

function formatTime(seconds) {
  var value = Math.max(0, Math.round(Number(seconds) || 0));
  var minutes = Math.floor(value / 60);
  return minutes + ":" + String(value % 60).padStart(2, "0");
}

function getZone(id) {
  return ZONES.find(function (zone) {
    return zone.id === id;
  }) || null;
}

function zoneLabel(zone) {
  if (!zone) {
    return "";
  }
  return zone.code || zone.id;
}

function getMainStops() {
  var main = ROUTES.find(function (route) {
    return route.id === "main";
  });
  var stops = main && Array.isArray(main.stops) ? main.stops.filter(getZone) : [];
  return stops.length ? stops : ZONES.map(function (zone) {
    return zone.id;
  });
}

function firstZoneId() {
  var stops = getMainStops();
  return stops.length ? stops[0] : (ZONES.length ? ZONES[0].id : "");
}

function getResumePrompt(zoneId) {
  var previous = Player.getProgress();
  var zone = getZone(zoneId);
  if (!previous || !zone || previous.zoneId !== zoneId) {
    return null;
  }
  var section = zone.sections[previous.sectionIndex];
  if (!section) {
    return null;
  }
  var position = Number(previous.position);
  var duration = Number(section.duration);
  if (!Number.isFinite(position) || position <= 30 || position >= duration * 0.9) {
    return null;
  }
  return {
    index: previous.sectionIndex,
    position: position,
    remain: Math.max(0, duration - position)
  };
}

function parseHash() {
  var raw = location.hash.replace(/^#/, "");
  if (!raw || raw === "home") {
    return { view: "home", param: "" };
  }
  if (raw === "pick") {
    return { view: "pick", param: "" };
  }
  var match = /^(go|zone)=(.+)$/.exec(raw);
  if (match) {
    var param = match[2];
    try {
      param = decodeURIComponent(param);
    } catch (error) {
      param = match[2];
    }
    return { view: match[1], param: param };
  }
  return { view: "home", param: "" };
}

function hashFor() {
  if (state.view === "home") {
    return "#home";
  }
  if (state.view === "pick") {
    return "#pick";
  }
  if (state.view === "go" || state.view === "zone") {
    return "#" + state.view + "=" + encodeURIComponent(state.param);
  }
  return "#home";
}

function syncHash() {
  var target = hashFor();
  if (location.hash !== target) {
    location.hash = target;
  }
}

function scrollTop() {
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function showContinue(label, action) {
  state.continueAction = typeof action === "function" ? action : null;
  resumeBtn.textContent = label;
  resumeBtn.hidden = false;
}

function hideContinue() {
  state.continueAction = null;
  resumeBtn.hidden = true;
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () {
    toastEl.hidden = true;
  }, 2600);
}

function updateProgressUI() {
  if (state.view !== "zone") {
    return;
  }
  var zone = getZone(state.zoneId);
  if (!zone) {
    return;
  }
  var section = zone.sections[state.sectionIndex];
  var seekBar = document.getElementById("seekBar");
  var nowLabel = document.getElementById("timeNow");
  var totalLabel = document.getElementById("timeTotal");
  if (!section || !seekBar || !nowLabel || !totalLabel) {
    return;
  }

  var playerState = Player.getState();
  var current = 0;

  if (state.resumePrompt) {
    current = state.resumePrompt.position;
  } else if (
    playerState.mode === "section" &&
    playerState.zoneId === zone.id &&
    playerState.sectionIndex === state.sectionIndex
  ) {
    current = Player.getTime();
  }

  if (playerState.mode === "guide" && playerState.zoneId === zone.id) {
    current = Number(section.duration) || 0;
  }

  if (!current && state.startAt > 0) {
    current = state.startAt;
  }

  var duration = Number(section.duration) || 0;
  if (
    playerState.mode === "section" &&
    playerState.zoneId === zone.id &&
    playerState.sectionIndex === state.sectionIndex &&
    Player.getDuration() > 0
  ) {
    duration = Player.getDuration();
  }

  var ratio = duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;
  seekBar.max = String(Math.max(0.1, duration));
  if (!state.seeking) {
    seekBar.value = String(Math.min(current, Math.max(0.1, duration)));
  }
  seekBar.style.setProperty("--seek", (ratio * 100) + "%");
  nowLabel.textContent = formatTime(current);
  totalLabel.textContent = formatTime(duration);
}

function updatePauseButton() {
  var button = document.getElementById("pauseBtn");
  if (!button || button.disabled) {
    return;
  }
  var paused = Player.isPaused();
  button.textContent = paused ? "▶" : "❚❚";
  button.setAttribute("aria-label", paused ? "播放" : "暂停");
  button.classList.toggle("is-paused", paused);
}

function renderFloorplan(currentId) {
  var pins = ZONES.map(function (zone) {
    var rawX = Number(zone.mapPin && zone.mapPin.x);
    var rawY = Number(zone.mapPin && zone.mapPin.y);
    var x = Number.isFinite(rawX) ? Math.max(4, Math.min(96, rawX)) : 50;
    var y = Number.isFinite(rawY) ? Math.max(8, Math.min(94, rawY)) : 50;
    var current = zone.id === currentId;

    return (
      '<span class="map-pin' + (current ? " is-current" : "") + '" style="left:' + x + "%;top:" + y + '%">' +
        (current ? '<span class="pin-ring"></span>' : "") +
        '<span class="pin-square"></span>' +
        '<span class="pin-label">' + esc(zoneLabel(zone)) + "</span>" +
      "</span>"
    );
  }).join("");

  return (
    '<div class="map-stage">' +
      '<img class="map-image" src="img/floorplan.png" alt="展厅平面图" draggable="false">' +
      '<div class="map-pins" aria-hidden="true">' + pins + "</div>" +
    "</div>"
  );
}

function renderHome() {
  hideContinue();
  document.title = (VENUE.name || "自助讲解") + " · 自助讲解";
  var count = ZONES.length;
  var minutes = Number(VENUE.totalMinutes) || 0;

  viewEl.innerHTML =
    '<section class="screen home">' +
      "<h1>" + esc(VENUE.name || "自助讲解") + "</h1>" +
      '<p class="home-meta">' + count + " 个展区 · 约 " + minutes + " 分钟</p>" +
      '<button id="startBtn" class="home-start" type="button">▶ 开始参观</button>' +
      '<p class="home-hint">请保持本页打开，不要锁屏</p>' +
    "</section>";

  document.getElementById("startBtn").addEventListener("click", function () {
    if (Player.getState().mode === "welcome") {
      Player.stop();
      goToGo(firstZoneId());
      return;
    }
    Player.unlock();
    Player.playWelcome();
  });
}

function renderGo(zone) {
  hideContinue();
  document.title = zoneLabel(zone) + " " + zone.title + " · " + (VENUE.name || "自助讲解");

  viewEl.innerHTML =
    '<section class="screen page go-page">' +
      '<header class="go-head">' +
        '<p class="eyebrow">下一站</p>' +
        '<p class="go-code">' + esc(zoneLabel(zone)) + "</p>" +
        '<h1 class="go-title">' + esc(zone.title) + "</h1>" +
        '<p class="location"><span class="location-dot" aria-hidden="true"></span><span>' + esc(zone.location) + "</span></p>" +
      "</header>" +
      '<div class="map-card">' + renderFloorplan(zone.id) + "</div>" +
      '<div class="go-action">' +
        '<button id="arriveBtn" class="primary-btn" type="button">我到了 · 开始讲解</button>' +
        '<button id="pickBtn" class="primary-btn ghost" type="button">想先去别的？</button>' +
      "</div>" +
    "</section>";

  document.getElementById("arriveBtn").addEventListener("click", function () {
    enterZone(zone.id);
  });

  document.getElementById("pickBtn").addEventListener("click", function () {
    openPick(zone.id);
  });
}

var scriptLoadToken = 0;

function paintScript(node, content, hasContent) {
  if (!node) {
    return;
  }
  node.textContent = content;
  node.classList.toggle("script-empty", !hasContent);
}

function loadSectionScript(section, node) {
  if (!node) {
    return;
  }

  var token = ++scriptLoadToken;
  var fallback = section.text ? section.text : "本节文字稿待补充，可先收听音频。";
  var url = "text/" + encodeURIComponent(section.id) + ".txt";

  fetch(url, { cache: "no-store" })
    .then(function (response) {
      if (!response.ok) {
        throw new Error("no text file");
      }
      return response.text();
    })
    .then(function (raw) {
      var content = String(raw).replace(/\r\n/g, "\n").trim();
      if (!content) {
        throw new Error("empty text file");
      }
      if (token !== scriptLoadToken) {
        return;
      }
      paintScript(node, content, true);
    })
    .catch(function () {
      if (token !== scriptLoadToken) {
        return;
      }
      paintScript(node, fallback, Boolean(section.text));
    });
}

function renderZone(zone) {
  var sections = zone.sections;
  if (!sections.length) {
    goHome();
    return;
  }

  if (!Number.isInteger(state.sectionIndex) || state.sectionIndex < 0 || state.sectionIndex >= sections.length) {
    state.sectionIndex = 0;
  }

  var section = sections[state.sectionIndex];
  var prompt = state.resumePrompt;
  var isLast = state.sectionIndex >= sections.length - 1;
  var text = section.text ? section.text : "本节文字稿待补充，可先收听音频。";
  var textClass = section.text ? "" : " script-empty";
  var playerState = Player.getState();
  var current = 0;

  if (prompt) {
    current = prompt.position;
  } else if (
    playerState.mode === "section" &&
    playerState.zoneId === zone.id &&
    playerState.sectionIndex === state.sectionIndex
  ) {
    current = Player.getTime();
  }

  if (playerState.mode === "guide" && playerState.zoneId === zone.id) {
    current = Number(section.duration) || 0;
  }

  if (!current && state.startAt > 0) {
    current = state.startAt;
  }

  var duration = Number(section.duration) || 1;
  if (
    playerState.mode === "section" &&
    playerState.zoneId === zone.id &&
    playerState.sectionIndex === state.sectionIndex &&
    Player.getDuration() > 0
  ) {
    duration = Player.getDuration();
  }
  var ratio = Math.min(1, current / Math.max(1, duration));
  var speedOptions = [0.75, 1, 1.25, 1.5, 2].map(function (rate) {
    var selected = Math.abs(Player.getRate() - rate) < 0.01 ? " selected" : "";
    return '<option value="' + rate + '"' + selected + ">" + rate.toFixed(2).replace(/0$/, "") + "×</option>";
  }).join("");
  var controlsActive =
    playerState.mode === "section" &&
    playerState.zoneId === zone.id &&
    playerState.sectionIndex === state.sectionIndex;
  var controlsDisabled = (prompt || !controlsActive) ? " disabled" : "";
  var controlIcon = controlsDisabled ? "▶" : "❚❚";
  var textTabActive = state.scriptTab !== "image";

  document.title = zoneLabel(zone) + " " + zone.title + " · " + (VENUE.name || "自助讲解");

  var chapters = sections.map(function (item, index) {
    var isCurrent = index === state.sectionIndex;
    return (
      '<button class="chapter-row' + (isCurrent ? " is-current" : "") + '" type="button" data-index="' + index + '"' +
        (isCurrent ? ' aria-current="true"' : "") + ">" +
        '<span class="chapter-index">' + String(index + 1).padStart(2, "0") + "</span>" +
        '<span class="chapter-name">' + esc(item.title) + "</span>" +
        '<span class="chapter-time">' + formatTime(item.duration) + "</span>" +
      "</button>"
    );
  }).join("");

  var resumeCard = prompt
    ? '<div class="resume-card">' +
        "<p>继续上次 剩 " + formatTime(prompt.remain) + "</p>" +
        '<div class="resume-actions">' +
          '<button id="resumeContinue" class="primary-btn compact" type="button">▶ 继续上次</button>' +
          '<button id="resumeRestart" class="secondary-btn" type="button">从头听</button>' +
        "</div>" +
      "</div>"
    : "";

  viewEl.innerHTML =
    '<section class="screen zone-screen">' +
      '<header class="zone-heading">' +
        '<span class="zone-id">' + esc(zoneLabel(zone)) + "</span>" +
        '<h1 class="zone-title">' + esc(zone.title) + "</h1>" +
      "</header>" +
      '<p class="zone-sub">第 ' + (state.sectionIndex + 1) + " / " + sections.length + " 节</p>" +
      '<div class="player-bar">' +
        '<button id="pauseBtn" class="play-toggle" type="button" aria-label="暂停"' + controlsDisabled + ">" + controlIcon + "</button>" +
        '<div class="player-time"><span id="timeNow">' + formatTime(current) + '</span><span class="time-sep">/</span><span id="timeTotal">' + formatTime(duration) + "</span></div>" +
        '<input id="seekBar" class="seek-bar" type="range" min="0" max="' + Math.max(0.1, duration) + '" step="0.1" value="' + Math.min(current, duration) + '" style="--seek:' + (ratio * 100) + '%" aria-label="播放进度"' + controlsDisabled + ">" +
        '<select id="speedSelect" class="speed-select" aria-label="播放速度">' + speedOptions + "</select>" +
      "</div>" +
      resumeCard +
      '<h2 class="section-title">' + esc(section.title) + "</h2>" +
      '<div class="script-card">' +
        '<button id="scriptToggle" class="script-toggle" type="button" title="切换图片和文本" aria-label="' + (textTabActive ? "切换到图片" : "切换到文本") + '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h15"></path><path d="M15 4l4 4-4 4"></path><path d="M20 16H5"></path><path d="M9 20l-4-4 4-4"></path></svg></button>' +
        '<div class="script-stack">' +
          '<div class="script-pane" data-pane="text"' + (textTabActive ? "" : " hidden") + ">" +
            '<p class="script' + textClass + '">' + esc(text) + "</p>" +
          "</div>" +
          '<div class="script-pane" data-pane="image"' + (textTabActive ? " hidden" : "") + ">" +
            '<div class="media-frame">' +
              '<img id="sectionImage" class="section-image" alt="' + esc(zone.title + " " + section.title) + '" hidden>' +
              '<div id="mediaFallback" class="media-fallback">' +
                '<span class="media-mark">▧</span>' +
                "<strong>图片资料待补充</strong>" +
                "<span>本节目录：img/" + esc(section.id) + ".jpg</span>" +
              "</div>" +
            "</div>" +
          "</div>" +
        "</div>" +
      "</div>" +
      '<div class="nav-row">' +
        '<button id="prevBtn" class="secondary-btn" type="button">‹ 上一节</button>' +
        '<button id="nextBtn" class="secondary-btn" type="button"' + (isLast ? " disabled" : "") + ">下一节 ›</button>" +
      "</div>" +
      '<details class="chapters" open>' +
        "<summary><span>全部 " + sections.length + " 节</span><span>第 " + (state.sectionIndex + 1) + " 节</span></summary>" +
        '<div class="chapter-list">' + chapters + "</div>" +
      "</details>" +
      '<button id="changeZone" class="text-btn change-zone" type="button">换个展区</button>' +
    "</section>";

  document.getElementById("prevBtn").addEventListener("click", playPrevious);
  document.getElementById("nextBtn").addEventListener("click", playNext);

  viewEl.querySelectorAll(".chapter-row").forEach(function (button) {
    button.addEventListener("click", function () {
      var index = Number(button.getAttribute("data-index"));
      Player.playSection(zone.id, index);
    });
  });

  document.getElementById("changeZone").addEventListener("click", function () {
    openPick(zone.nextDefault || firstZoneId());
  });

  var scriptToggle = document.getElementById("scriptToggle");
  var imagePane = viewEl.querySelector('[data-pane="image"]');
  var textPane = viewEl.querySelector('[data-pane="text"]');

  loadSectionScript(section, viewEl.querySelector(".script"));

  scriptToggle.addEventListener("click", function () {
    state.scriptTab = state.scriptTab === "image" ? "text" : "image";
    var showText = state.scriptTab === "text";
    textPane.hidden = !showText;
    imagePane.hidden = showText;
    scriptToggle.setAttribute("aria-label", showText ? "切换到图片" : "切换到文本");
  });

  var sectionImage = document.getElementById("sectionImage");
  var mediaFallback = document.getElementById("mediaFallback");
  var imageSources = [
    "img/" + section.id + ".jpg",
    "img/" + section.id + ".png",
    "img/" + zone.id + ".jpg",
    "img/" + zone.id + ".png"
  ];
  var imageIndex = 0;

  function tryNextImage() {
    if (imageIndex >= imageSources.length) {
      sectionImage.hidden = true;
      mediaFallback.hidden = false;
      return;
    }
    sectionImage.src = imageSources[imageIndex];
    imageIndex += 1;
  }

  sectionImage.addEventListener("load", function () {
    sectionImage.hidden = false;
    mediaFallback.hidden = true;
  });

  sectionImage.addEventListener("error", function () {
    tryNextImage();
  });

  tryNextImage();

  var pauseButton = document.getElementById("pauseBtn");
  var seekBar = document.getElementById("seekBar");
  var speedSelect = document.getElementById("speedSelect");

  pauseButton.addEventListener("click", function () {
    Player.togglePause();
    updatePauseButton();
  });

  seekBar.addEventListener("pointerdown", function () {
    state.seeking = true;
  });
  seekBar.addEventListener("input", function () {
    state.seeking = true;
    Player.seek(Number(seekBar.value));
    updateProgressUI();
  });
  seekBar.addEventListener("change", function () {
    state.seeking = false;
    Player.seek(Number(seekBar.value));
    updateProgressUI();
  });

  speedSelect.addEventListener("change", function () {
    Player.setRate(Number(speedSelect.value));
  });

  if (prompt) {
    document.getElementById("resumeContinue").addEventListener("click", function () {
      Player.playSection(zone.id, prompt.index, { startAt: prompt.position });
    });
    document.getElementById("resumeRestart").addEventListener("click", function () {
      state.resumePrompt = null;
      Player.playSection(zone.id, 0);
    });
  }

  updateProgressUI();
  updatePauseButton();
}

function renderPick() {
  hideContinue();
  var progress = Player.getProgress();
  var done = new Set(progress ? progress.doneZones : []);
  var allDone = ZONES.length > 0 && ZONES.every(function (zone) {
    return done.has(zone.id);
  });
  var systems = [];

  ZONES.forEach(function (zone) {
    if (systems.indexOf(zone.systems) === -1) {
      systems.push(zone.systems);
    }
  });

  var recommendedId = state.recommendId || firstZoneId();
  var visibleZones = ZONES.filter(function (zone) {
    return state.filter === "all" || zone.systems === state.filter;
  });

  var chips = ['<button class="chip' + (state.filter === "all" ? " is-active" : "") + '" type="button" data-filter="all">全部</button>']
    .concat(systems.map(function (system) {
      return (
        '<button class="chip' + (state.filter === system ? " is-active" : "") + '" type="button" data-filter="' + esc(system) + '">' +
          esc(system) +
        "</button>"
      );
    }))
    .join("");

  var list = visibleZones.map(function (zone) {
    var recommended = zone.id === recommendedId;
    var isDone = done.has(zone.id);
    return (
      '<button class="zone-choice' + (recommended ? " is-recommended" : "") + '" type="button" data-zone="' + esc(zone.id) + '">' +
        '<span class="zone-choice-main">' +
          '<span class="zone-choice-id">' + esc(zoneLabel(zone)) + "</span>" +
          '<span class="zone-choice-title">' + esc(zone.title) + "</span>" +
          '<span class="zone-choice-meta">' + esc(zone.systems) + " · " + esc(zone.location) + "</span>" +
        "</span>" +
        '<span class="zone-choice-side">' +
          (recommended ? '<span class="badge">推荐</span>' : "") +
          (isDone ? '<span class="done-mark">✓ 已听</span>' : "") +
        "</span>" +
      "</button>"
    );
  }).join("");

  document.title = "选择下一站 · " + (VENUE.name || "自助讲解");

  viewEl.innerHTML =
    '<section class="screen page pick-page">' +
      '<p class="eyebrow">选择下一站</p>' +
      "<h1>" + (allDone ? "参观完成" : "想去哪里？") + "</h1>" +
      '<p class="pick-lead">' + (allDone
        ? "全部展区已听完，共约 " + (Number(VENUE.totalMinutes) || 0) + " 分钟。可以回顾任意展区。"
        : "点选展区后先看前往指引，走到展柜前再点“我到了”。") + "</p>" +
      (allDone ? '<div class="done-card"><p>参观完成 · 共 ' + (Number(VENUE.totalMinutes) || 0) + " 分钟</p></div>" : "") +
      '<div class="filter-row">' + chips + "</div>" +
      (list
        ? '<div class="zone-list">' + list + "</div>"
        : '<p class="empty-state">该分类下暂无展区</p>') +
    "</section>";

  viewEl.querySelectorAll(".chip").forEach(function (button) {
    button.addEventListener("click", function () {
      state.filter = button.getAttribute("data-filter");
      renderPick();
      scrollTop();
    });
  });

  viewEl.querySelectorAll(".zone-choice").forEach(function (button) {
    button.addEventListener("click", function () {
      goToGo(button.getAttribute("data-zone"));
    });
  });
}

function renderView() {
  if (state.view === "home") {
    renderHome();
    return;
  }
  if (state.view === "go") {
    var goZone = getZone(state.param);
    if (goZone) {
      renderGo(goZone);
    } else {
      renderHome();
    }
    return;
  }
  if (state.view === "zone") {
    var zone = getZone(state.param);
    if (zone) {
      renderZone(zone);
    } else {
      renderHome();
    }
    return;
  }
  if (state.view === "pick") {
    renderPick();
    return;
  }
  renderHome();
}

function goHome() {
  Player.stop();
  hideContinue();
  state.view = "home";
  state.param = "";
  state.resumePrompt = null;
  state.startAt = 0;
  renderView();
  syncHash();
  scrollTop();
}

function goToGo(zoneId) {
  var zone = getZone(zoneId);
  if (!zone) {
    goHome();
    return;
  }
  Player.stop();
  hideContinue();
  state.view = "go";
  state.param = zone.id;
  state.recommendId = zone.id;
  state.resumePrompt = null;
  state.startAt = 0;
  renderView();
  syncHash();
  scrollTop();
}

function openPick(recommendId) {
  Player.stop();
  hideContinue();
  state.recommendId = recommendId || state.recommendId || firstZoneId();
  state.filter = "all";
  state.view = "pick";
  state.param = "";
  state.resumePrompt = null;
  state.startAt = 0;
  renderView();
  syncHash();
  scrollTop();
}

function enterZone(zoneId) {
  var zone = getZone(zoneId);
  if (!zone) {
    return;
  }

  Player.stop();
  hideContinue();
  var prompt = getResumePrompt(zone.id);

  if (prompt) {
    state.zoneId = zone.id;
    state.sectionIndex = prompt.index;
    state.resumePrompt = prompt;
    state.startAt = 0;
    state.view = "zone";
    state.param = zone.id;
    renderView();
    syncHash();
    scrollTop();
    return;
  }

  state.resumePrompt = null;
  state.startAt = 0;
  Player.playSection(zone.id, 0);
}

function openZoneFromHash(zoneId) {
  var zone = getZone(zoneId);
  if (!zone) {
    goHome();
    return;
  }

  Player.stop();
  hideContinue();
  var prompt = getResumePrompt(zone.id);

  state.zoneId = zone.id;
  state.sectionIndex = prompt ? prompt.index : 0;
  state.resumePrompt = prompt;
  state.startAt = 0;
  state.view = "zone";
  state.param = zone.id;
  renderView();
  syncHash();
  scrollTop();

  if (prompt) {
    return;
  }

  showContinue("▶ 开始播放", function () {
    Player.playSection(zone.id, 0);
  });
}

function playPrevious() {
  var zone = getZone(state.zoneId);
  if (!zone) {
    return;
  }

  if (state.sectionIndex > 0) {
    Player.playSection(zone.id, state.sectionIndex - 1);
    return;
  }

  var stops = getMainStops();
  var position = stops.indexOf(zone.id);
  var previousId = "";

  if (position > 0) {
    previousId = stops[position - 1];
  } else if (position === 0) {
    previousId = stops[stops.length - 1];
  } else {
    var index = ZONES.findIndex(function (item) {
      return item.id === zone.id;
    });
    if (index >= 0) {
      previousId = ZONES[(index - 1 + ZONES.length) % ZONES.length].id;
    }
  }

  var previous = getZone(previousId);
  if (!previous || !previous.sections.length) {
    return;
  }

  Player.playSection(previous.id, previous.sections.length - 1);
  toast("已返回上一展区最后一段");
}

function playNext() {
  var zone = getZone(state.zoneId);
  if (!zone) {
    return;
  }
  if (state.sectionIndex < zone.sections.length - 1) {
    Player.playSection(zone.id, state.sectionIndex + 1);
  } else {
    toast("已经是最后一节");
  }
}

function handleHashChange() {
  var route = parseHash();
  if (route.view === state.view && (route.param || "") === (state.param || "")) {
    return;
  }

  if (route.view === "zone") {
    openZoneFromHash(route.param);
    return;
  }

  Player.stop();
  hideContinue();

  if (route.view === "go") {
    var zone = getZone(route.param);
    if (!zone) {
      goHome();
      return;
    }
    state.view = "go";
    state.param = zone.id;
    state.recommendId = zone.id;
    state.resumePrompt = null;
    state.startAt = 0;
    renderView();
    syncHash();
    scrollTop();
    return;
  }

  if (route.view === "pick") {
    state.view = "pick";
    state.param = "";
    state.filter = "all";
    state.resumePrompt = null;
    state.startAt = 0;
    renderView();
    syncHash();
    scrollTop();
    return;
  }

  state.view = "home";
  state.param = "";
  state.resumePrompt = null;
  state.startAt = 0;
  renderView();
  syncHash();
  scrollTop();
}

Player.on("sectionStart", function (payload) {
  state.zoneId = payload.zoneId;
  state.sectionIndex = payload.index;
  state.startAt = Number(payload.startAt) || 0;
  state.resumePrompt = null;
  state.view = "zone";
  state.param = payload.zoneId;
  hideContinue();
  renderView();
  syncHash();
  scrollTop();
});

Player.on("welcomeEnd", function () {
  goToGo(firstZoneId());
});

Player.on("guideEnd", function (payload) {
  if (payload.to) {
    goToGo(payload.to);
  } else {
    goHome();
  }
});

Player.on("zoneEnd", function (payload) {
  if (payload.to) {
    goToGo(payload.to);
  } else {
    goHome();
  }
});

Player.on("needTap", function () {
  var wasHidden = resumeBtn.hidden;
  showContinue("▶ 继续播放");
  updatePauseButton();
  var script = viewEl.querySelector(".script");
  if (script) {
    script.classList.add("is-error");
  }
  if (wasHidden) {
    toast("音频未就绪，请点顶部按钮继续");
  }
});

Player.on("needResume", function () {
  showContinue("▶ 继续");
  updatePauseButton();
});

Player.on("playing", function () {
  hideContinue();
  updatePauseButton();
  var script = viewEl.querySelector(".script.is-error");
  if (script) {
    script.classList.remove("is-error");
  }
});

Player.on("timeupdate", function () {
  updateProgressUI();
});

Player.on("loadedmetadata", function () {
  updateProgressUI();
});

resumeBtn.addEventListener("click", function () {
  var action = state.continueAction;
  state.continueAction = null;
  hideContinue();
  if (typeof action === "function") {
    action();
    return;
  }
  Player.resume();
});

window.addEventListener("hashchange", handleHashChange);
window.addEventListener("pointerup", function () {
  state.seeking = false;
});

(function init() {
  var route = parseHash();

  if (route.view === "zone") {
    openZoneFromHash(route.param);
    return;
  }

  if (route.view === "go") {
    var zone = getZone(route.param);
    if (zone) {
      state.view = "go";
      state.param = zone.id;
      state.recommendId = zone.id;
      renderView();
      syncHash();
      return;
    }
  }

  if (route.view === "pick") {
    state.view = "pick";
    state.param = "";
    state.filter = "all";
    renderView();
    syncHash();
    return;
  }

  state.view = "home";
  state.param = "";
  renderView();
  syncHash();
})();
