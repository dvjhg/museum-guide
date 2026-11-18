(function () {
  "use strict";

  var CONTENT = window.CONTENT || {};
  var ZONES = Array.isArray(CONTENT.zones) ? CONTENT.zones : [];
  var GUIDES = Array.isArray(CONTENT.guides) ? CONTENT.guides : [];
  var audio = document.getElementById("au");
  var STORAGE_KEY = "museum-progress";

  var SILENT_AUDIO = "data:audio/wav;base64,UklGRmQGAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YUAGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  var listeners = {};
  var unlocked = false;
  var mode = "idle";
  var zoneId = null;
  var sectionIndex = 0;
  var afterGuide = null;
  var pendingAfterUnlock = null;
  var lastRequest = null;
  var resumeAt = 0;
  var visibilityPaused = false;
  var lastSave = 0;
  var playbackRate = 1;
  var loadToken = 0;
  var objectUrl = null;

  function on(name, handler) {
    if (!listeners[name]) {
      listeners[name] = [];
    }
    listeners[name].push(handler);
    return function () {
      off(name, handler);
    };
  }

  function off(name, handler) {
    var bucket = listeners[name];
    if (!bucket) {
      return;
    }
    var index = bucket.indexOf(handler);
    if (index !== -1) {
      bucket.splice(index, 1);
    }
  }

  function emit(name, payload) {
    var bucket = listeners[name];
    if (!bucket) {
      return;
    }
    bucket.slice().forEach(function (handler) {
      try {
        handler(payload || {});
      } catch (error) {
        return;
      }
    });
  }

  function findZone(id) {
    return ZONES.find(function (zone) {
      return zone.id === id;
    }) || null;
  }

  function findGuide(to) {
    return GUIDES.find(function (guide) {
      return guide.to === to;
    }) || null;
  }

  function readProgress() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return null;
      }
      var data = JSON.parse(raw);
      if (!data || typeof data !== "object") {
        return null;
      }
      return {
        zoneId: typeof data.zoneId === "string" ? data.zoneId : null,
        sectionIndex: Number.isInteger(data.sectionIndex) ? data.sectionIndex : 0,
        position: Number.isFinite(Number(data.position)) ? Math.max(0, Number(data.position)) : 0,
        doneZones: Array.isArray(data.doneZones)
          ? data.doneZones.filter(function (id) {
              return typeof id === "string";
            })
          : []
      };
    } catch (error) {
      return null;
    }
  }

  function writeProgress(progress) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    } catch (error) {
    }
  }

  function saveProgress(options) {
    if (!zoneId) {
      return;
    }
    var settings = options || {};
    var previous = readProgress() || {};
    var position = settings.position;

    if (position === undefined) {
      position = mode === "section" ? audio.currentTime : 0;
    }
    if (!Number.isFinite(Number(position)) || Number(position) < 0) {
      position = 0;
    }

    writeProgress({
      zoneId: zoneId,
      sectionIndex: sectionIndex,
      position: Number(position),
      doneZones: previous.doneZones || []
    });
  }

  function markZoneDone(id) {
    var previous = readProgress() || {};
    var doneZones = Array.from(new Set((previous.doneZones || []).concat(id)));
    writeProgress({
      zoneId: zoneId || id,
      sectionIndex: sectionIndex,
      position: Number(previous.position) || 0,
      doneZones: doneZones
    });
  }

  function saveLivePosition() {
    if (mode !== "section") {
      return;
    }
    if (audio.currentTime > 0.1) {
      saveProgress({ position: audio.currentTime });
    }
  }

  function fail(error) {
    if (mode === "unlock") {
      mode = "idle";
    }
    emit("needTap", { error: error });
  }

  function setAudioSource(logical, playable) {
    if (objectUrl && objectUrl !== playable) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch (error) {
      }
      objectUrl = null;
    }
    if (playable.indexOf("blob:") === 0) {
      objectUrl = playable;
    }
    audio.dataset.src = logical;
    audio.src = playable;
  }

  function safePlay(src, options) {
    var settings = options || {};
    var startAt = Math.max(0, Number(settings.startAt) || 0);
    var onStarted = settings.onStarted;
    var sameSource = audio.dataset.src === src && audio.getAttribute("src");
    var token = ++loadToken;

    function startPlayback(same) {
      function begin() {
        if (startAt > 0) {
          try {
            audio.currentTime = startAt;
          } catch (error) {
          }
        } else if (same) {
          try {
            audio.currentTime = 0;
          } catch (error) {
          }
        }

        var promise;
        try {
          audio.playbackRate = playbackRate;
          promise = audio.play();
        } catch (error) {
          fail(error);
          return;
        }

        if (promise && typeof promise.then === "function") {
          promise
            .then(function () {
              if (typeof onStarted === "function") {
                onStarted();
              }
            })
            .catch(fail);
        } else if (typeof onStarted === "function") {
          onStarted();
        }
      }

      if (startAt > 0 && audio.readyState < 1) {
        audio.addEventListener("loadedmetadata", begin, { once: true });
      } else {
        begin();
      }
    }

    if (sameSource) {
      startPlayback(true);
      return;
    }

    if (/^data:/.test(src)) {
      setAudioSource(src, src);
      startPlayback(false);
      return;
    }

    audio.dataset.src = "";
    fetch(src, { cache: "force-cache" })
      .then(function (response) {
        if (!response.ok) {
          throw new Error("音频加载失败：" + response.status);
        }
        return response.blob();
      })
      .then(function (blob) {
        if (token !== loadToken) {
          return;
        }
        var playable = URL.createObjectURL(blob);
        setAudioSource(src, playable);
        startPlayback(false);
      })
      .catch(function (error) {
        if (token === loadToken) {
          fail(error);
        }
      });
  }

  function unlock() {
    if (unlocked || mode === "unlock") {
      return;
    }
    mode = "unlock";
    lastRequest = { type: "unlock" };
    resumeAt = 0;

    safePlay(SILENT_AUDIO, {
      onStarted: function () {
        unlocked = true;
      }
    });
  }

  function ensureReady(action) {
    if (unlocked) {
      action();
      return true;
    }
    pendingAfterUnlock = action;
    unlock();
    return false;
  }

  function playWelcome(startAt) {
    ensureReady(function () {
      var welcome = CONTENT.venue && CONTENT.venue.welcome;
      if (!welcome || !welcome.audio) {
        mode = "idle";
        lastRequest = null;
        emit("welcomeEnd");
        return;
      }

      mode = "welcome";
      lastRequest = { type: "welcome" };
      resumeAt = 0;
      visibilityPaused = false;
      safePlay(welcome.audio, { startAt: Math.max(0, Number(startAt) || 0) });
    });
  }

  function playSection(id, index, options) {
    var zone = findZone(id);
    var section = zone && zone.sections[index];
    if (!section) {
      return;
    }
    var settings = options || {};
    var startAt = Math.max(0, Number(settings.startAt) || 0);

    ensureReady(function () {
      if (mode === "section") {
        saveProgress({ position: audio.currentTime });
      }

      zoneId = id;
      sectionIndex = index;
      mode = "section";
      afterGuide = null;
      resumeAt = 0;
      visibilityPaused = false;
      lastRequest = { type: "section", zoneId: id, index: index };

      saveProgress({ zoneId: id, sectionIndex: index, position: startAt });
      emit("sectionStart", { zoneId: id, index: index, startAt: startAt });
      safePlay(section.audio, { startAt: startAt });
    });
  }

  function playGuide(to, options) {
    var guide = findGuide(to);
    if (!guide || !guide.audio) {
      mode = "idle";
      lastRequest = null;
      emit("zoneEnd", { to: to });
      return;
    }

    var settings = options || {};
    var startAt = Math.max(0, Number(settings.startAt) || 0);

    ensureReady(function () {
      mode = "guide";
      afterGuide = to;
      lastRequest = { type: "guide", to: to };
      resumeAt = 0;
      visibilityPaused = false;
      emit("guideStart", { to: to });
      safePlay(guide.audio, { startAt: startAt });
    });
  }

  function handleEnded() {
    resumeAt = 0;

    if (mode === "unlock") {
      unlocked = true;
      mode = "idle";
      var callback = pendingAfterUnlock;
      pendingAfterUnlock = null;
      if (typeof callback === "function") {
        callback();
      }
      return;
    }

    if (mode === "welcome") {
      mode = "idle";
      lastRequest = null;
      emit("welcomeEnd");
      return;
    }

    if (mode === "section") {
      var zone = findZone(zoneId);
      if (!zone) {
        return;
      }
      var index = sectionIndex;
      saveProgress({ position: zone.sections[index].duration });
      emit("sectionEnd", { zoneId: zone.id, index: index });

      if (index < zone.sections.length - 1) {
        playSection(zone.id, index + 1);
        return;
      }

      markZoneDone(zone.id);
      if (zone.nextDefault && findGuide(zone.nextDefault)) {
        playGuide(zone.nextDefault);
      } else {
        mode = "idle";
        lastRequest = null;
        emit("zoneEnd", { to: zone.nextDefault || null });
      }
      return;
    }

    if (mode === "guide") {
      var next = afterGuide;
      mode = "idle";
      lastRequest = null;
      afterGuide = null;
      emit("guideEnd", { to: next });
    }
  }

  function stop() {
    loadToken++;
    saveLivePosition();
    if (!audio.paused) {
      try {
        audio.pause();
      } catch (error) {
      }
    }
    mode = "idle";
    lastRequest = null;
    pendingAfterUnlock = null;
    afterGuide = null;
    resumeAt = 0;
    visibilityPaused = false;
  }

  function pause() {
    if (audio.paused) {
      return;
    }
    resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    if (mode === "section") {
      saveLivePosition();
    }
    try {
      audio.pause();
    } catch (error) {
    }
  }

  function togglePause() {
    if (!audio.paused) {
      pause();
      return false;
    }
    if (!audio.dataset.src) {
      return false;
    }
    var at = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    safePlay(audio.dataset.src, { startAt: at });
    return true;
  }

  function seek(seconds) {
    var target = Number(seconds);
    if (!Number.isFinite(target)) {
      return 0;
    }

    var section = findZone(zoneId) && findZone(zoneId).sections[sectionIndex];
    var fallback = section ? Number(section.duration) || 0 : 0;
    var duration = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : fallback;

    target = Math.max(0, target);
    if (duration > 0) {
      target = Math.min(target, Math.max(0, duration - 0.05));
    }

    try {
      audio.currentTime = target;
    } catch (error) {
      return audio.currentTime;
    }

    if (mode === "section") {
      saveProgress({ position: target });
    }
    return target;
  }

  function setRate(rate) {
    var value = Number(rate);
    if (!Number.isFinite(value) || value < 0.5 || value > 3) {
      return playbackRate;
    }
    playbackRate = value;
    audio.defaultPlaybackRate = value;
    audio.playbackRate = value;
    return playbackRate;
  }

  function isPaused() {
    return audio.paused;
  }

  function getRate() {
    return playbackRate;
  }

  function resume() {
    if (!unlocked) {
      if (mode === "unlock") {
        mode = "idle";
      }
      unlock();
      return;
    }
    if (!lastRequest || lastRequest.type === "unlock") {
      return;
    }

    var request = lastRequest;
    var position = Math.max(0, Number(resumeAt) || Number(audio.currentTime) || 0);
    resumeAt = 0;

    if (request.type === "welcome") {
      playWelcome(position);
      return;
    }

    if (request.type === "guide") {
      playGuide(request.to, { startAt: position });
      return;
    }

    if (request.type === "section") {
      var zone = findZone(request.zoneId);
      var section = zone && zone.sections[request.index];
      if (!section) {
        return;
      }
      if (!position) {
        var previous = readProgress();
        if (
          previous &&
          previous.zoneId === request.zoneId &&
          previous.sectionIndex === request.index
        ) {
          position = previous.position;
        }
      }
      if (!Number.isFinite(position) || position < 0 || position >= Number(section.duration)) {
        position = 0;
      }
      playSection(request.zoneId, request.index, { startAt: position });
    }
  }

  function getState() {
    return {
      unlocked: unlocked,
      mode: mode,
      zoneId: zoneId,
      sectionIndex: sectionIndex,
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : 0,
      afterGuide: afterGuide
    };
  }

  function getProgress() {
    return readProgress();
  }

  function getTime() {
    return Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  }

  function getDuration() {
    return Number.isFinite(audio.duration) ? audio.duration : 0;
  }

  audio.addEventListener("playing", function () {
    emit("playing", getState());
  });

  audio.addEventListener("timeupdate", function () {
    if (mode === "section") {
      var now = Date.now();
      if (now - lastSave > 1000) {
        lastSave = now;
        saveLivePosition();
      }
    }
    emit("timeupdate", {
      time: getTime(),
      duration: getDuration(),
      zoneId: zoneId,
      sectionIndex: sectionIndex
    });
  });

  audio.addEventListener("loadedmetadata", function () {
    emit("loadedmetadata", {
      time: getTime(),
      duration: getDuration(),
      zoneId: zoneId,
      sectionIndex: sectionIndex
    });
  });

  audio.addEventListener("ended", handleEnded);

  audio.addEventListener("error", function () {
    if (audio.dataset.src) {
      fail(audio.error || new Error("audio error"));
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (!audio.paused && mode !== "idle") {
        visibilityPaused = true;
        resumeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
        if (mode === "section") {
          saveLivePosition();
        }
        try {
          audio.pause();
        } catch (error) {
        }
        emit("hiddenPause");
      }
      return;
    }

    if (visibilityPaused) {
      visibilityPaused = false;
      emit("needResume", { reason: "visibility" });
    }
  });

  window.addEventListener("beforeunload", function () {
    saveLivePosition();
  });

  audio.volume = 1;

  window.Player = {
    on: on,
    off: off,
    unlock: unlock,
    playWelcome: playWelcome,
    playSection: playSection,
    playGuide: playGuide,
    resume: resume,
    stop: stop,
    pause: pause,
    togglePause: togglePause,
    seek: seek,
    setRate: setRate,
    isPaused: isPaused,
    getRate: getRate,
    getState: getState,
    getProgress: getProgress,
    getTime: getTime,
    getDuration: getDuration
  };
})();
