(() => {
  const FILE_SAVE_DISABLED = true;

  const DEFAULTS = {
    enabled: false,
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    voiceURI: "",
    sourceMode: "track",
    debug: false,
    autoRate: true,
    autoRateMin: 1.3,
    autoRateMax: 1.8,
    summaryMode: false,
    autoSummary: false,
    integrationUrl: "http://127.0.0.1:8765"
  };

  const state = {
    ...DEFAULTS,
    initialized: false,
    lastSpoken: "",
    lastCaptureKeyBySource: {},
    lastEnqueueKey: "",
    lastEnqueueAt: 0,
    trackListenersBound: false,
    observer: null,
    debug: false,
    diagnostics: [],
    pendingCaptures: [],
    composeCapture: null,
    composeFlushTimer: null,
    isSpeaking: false,
    activeUtterances: 0,
    activeSpeechMeta: [],
    nextSpeechId: 1,
    summaryBuffer: [],
    summaryFlushTimer: null,
    summaryContext: null,
    lastAutoSummarizedKey: "",
    activeVideoEl: null,
    summarySeenByLesson: {},
    transcriptAutoMeta: {},
    autoSummaryInFlight: false,
    lastTranscriptWaitDiagAt: 0,
    lastLessonPickDiag: "",
    ttsWarmedUp: false,
    lastAdaptiveRate: 0,
    live: {
      lastCaptureAt: "",
      lastCaptureSource: "",
      lastCaptureText: "",
      lastSummarySource: "",
      currentCourse: "",
      currentLesson: "",
      currentKey: "",
      lastAppendAt: "",
      lastAppendTarget: "",
      lastAppendCount: 0,
      lastSummaryAt: "",
      lastSummaryTarget: "",
      lastError: ""
    }
  };

  function isUdemyCoursePage() {
    return /udemy\.com\/course\//i.test(location.href);
  }

  function normalize(text) {
    return String(text || "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function joinSpeechChunks(leftText, rightText) {
    const left = normalize(leftText).replace(/[.!?…;:]+$/g, "");
    const right = normalize(rightText).replace(/^[,.;:!?-]+\s*/g, "");
    if (!left) return right;
    if (!right) return left;
    return `${left}, ${right}`;
  }

  function captureKey(text) {
    return normalize(text).toLowerCase();
  }

  function isLikelySpeech(text) {
    const clean = normalize(text);
    if (!clean) return false;
    if (clean.length < 12) return false;

    const lower = clean.toLowerCase();
    const blocked = [
      "reproduzir",
      "pausar",
      "parar",
      "play",
      "pause",
      "settings",
      "configura",
      "tela inteira",
      "fullscreen",
      "volume",
      "velocidade",
      "retroceder",
      "avancar",
      "avançar",
      "segundos"
    ];
    const blockedRe = new RegExp(`(?:^|\\W)(?:${blocked.join("|")})(?:\\W|$)`, "i");
    if (blockedRe.test(lower)) return false;

    const words = clean.split(" ").filter(Boolean);
    return words.length >= 3;
  }

  function canSpeak() {
    return state.enabled && "speechSynthesis" in window;
  }

  function addDiag(event, data) {
    if (!state.debug) return;
    const line = `[${new Date().toISOString()}] ${event} ${data || ""}`.trim();
    state.diagnostics.push(line);
    if (state.diagnostics.length > 200) {
      state.diagnostics.splice(0, state.diagnostics.length - 200);
    }
  }

  function sanitizeName(name, fallback) {
    const raw = normalize(name || "");
    const clean = raw
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return clean || fallback;
  }

  function normalizeLessonTitle(raw) {
    const t = normalize(raw || "");
    if (!t) return "";
    const embedded = t.match(
      /(?:^|[^0-9])(\d+)\.\s*(.+?)(?=(?:\d+\s*[mh]\b)|Recursos|Resources|Glossary|Course notes|Flashcards|$)/i
    );
    if (embedded) {
      return `${embedded[1]} - ${normalize(embedded[2])}`;
    }
    // "3. Titulo" -> "3 - Titulo"
    const byDot = t.match(/^(\d+)\.\s+(.+)$/);
    if (byDot) return `${byDot[1]} - ${byDot[2]}`;
    // "3 - Titulo" remains as is.
    return t;
  }

  function isNoisyLessonText(text) {
    const t = normalize(text || "");
    if (!t) return true;
    const lower = t.toLowerCase();
    const noisyTokens = [
      "reproduzir",
      "parar",
      "pausar",
      "recursos",
      "resources",
      "transcri",
      "transcript",
      "caption",
      "glossary",
      "course notes",
      "flashcards",
      ".xlsx",
      ".pdf"
    ];
    return noisyTokens.some((token) => lower.includes(token));
  }

  function getPlayerLessonTitle() {
    const selectors = [
      "[data-purpose='video-viewer-title']",
      "[data-purpose='lecture-title']",
      "[data-purpose='player-header'] h1",
      "[data-purpose='player-header-title']",
      "[class*='lecture-title']",
      "h1"
    ];
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const node of nodes) {
        const text = normalize(node.textContent || "");
        if (!text || isNoisyLessonText(text)) continue;
        const normalized = normalizeLessonTitle(text);
        if (!normalized || isNoisyLessonText(normalized)) continue;
        return normalized;
      }
    }
    return "";
  }

  function getActiveCurriculumLessonTitle() {
    const selectors = [
      "[data-purpose*='curriculum-item-link'][aria-current='true'] [data-purpose*='title']",
      "[data-purpose*='curriculum-item-link'][aria-current='true']",
      "[data-purpose*='curriculum-item'][aria-current='true'] [data-purpose*='title']",
      "[data-purpose='item-title'][aria-current='true']",
      "[data-purpose='item-title']"
    ];
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      if (!node) continue;
      const text = normalize(node.textContent || "");
      if (!text) continue;
      return normalizeLessonTitle(text);
    }
    return "";
  }

  function getCurrentLectureIdFromUrl() {
    const href = String(location.href || "");
    const m = href.match(/\/lecture\/(\d+)/i);
    return m ? m[1] : "";
  }

  function getLessonTitleByLectureId(lectureId) {
    if (!lectureId) return "";
    const byHrefSelectors = [
      `a[href*="/lecture/${lectureId}"] [data-purpose*="title"]`,
      `a[href*="/lecture/${lectureId}"]`,
      `[data-purpose*="curriculum-item-link"][href*="/lecture/${lectureId}"] [data-purpose*="title"]`,
      `[data-purpose*="curriculum-item-link"][href*="/lecture/${lectureId}"]`
    ];
    for (const sel of byHrefSelectors) {
      const node = document.querySelector(sel);
      if (!node) continue;
      const text = normalize(node.textContent || "");
      if (!text) continue;
      return normalizeLessonTitle(text);
    }
    return "";
  }

  function getVisibleNumericLessonTitle() {
    const selectors = [
      "[data-purpose*='title']",
      "[class*='title']",
      "[aria-current='true']",
      "h1",
      "h2",
      "h3"
    ];
    const seen = {};
    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const node of nodes) {
        const el = /** @type {HTMLElement} */ (node);
        if (!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length))) {
          continue;
        }
        const text = normalize(el.textContent || "");
        if (!text || seen[text]) continue;
        seen[text] = true;
        if (/^\d+\.\s+\S+/.test(text)) {
          return normalizeLessonTitle(text);
        }
      }
    }
    return "";
  }

  function getLessonContext() {
    const courseCandidates = [
      "[data-purpose='course-header-title']",
      "[data-purpose='course-title-url']",
      "a[href*='/course/'][data-purpose*='course']",
      "h1"
    ];
    let course = "";
    for (const sel of courseCandidates) {
      const node = document.querySelector(sel);
      if (node && normalize(node.textContent || "")) {
        course = normalize(node.textContent || "");
        break;
      }
    }

    const lectureId = getCurrentLectureIdFromUrl();
    const courseKeyEarly = normalize(course).toLowerCase();
    const lessonCandidates = [];
    const seen = {};

    function pushCandidate(source, rawText) {
      const base = normalize(rawText || "");
      if (!base || isNoisyLessonText(base)) return;
      const normalized = normalizeLessonTitle(base);
      if (!normalized || isNoisyLessonText(normalized)) return;
      const key = normalized.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;

      let score = 0;
      if (/^\d+\s*[-.]\s+\S+/.test(normalized)) score += 100;
      const words = normalized.split(" ").filter(Boolean).length;
      if (words >= 3 && words <= 14) score += 15;
      if (source === "player") score += 45;
      if (source === "byLectureId") score += 35;
      if (source === "activeCurriculum") score += 30;
      if (source === "docTitle") score += 20;
      if (source === "visibleNumeric") score += 10;
      if (courseKeyEarly && key === courseKeyEarly) score -= 250;
      if (/^aula-\d+$/i.test(normalized)) score -= 100;

      lessonCandidates.push({ source, text: normalized, score });
    }

    pushCandidate("player", getPlayerLessonTitle());
    const title = normalize(document.title || "");
    if (title.includes("|")) {
      const parts = title.split("|").map((p) => normalize(p));
      pushCandidate("docTitle", parts[0] || "");
      if (!course && parts.length > 1) {
        course = parts[1];
      }
    }
    pushCandidate("byLectureId", getLessonTitleByLectureId(lectureId));
    pushCandidate("activeCurriculum", getActiveCurriculumLessonTitle());
    pushCandidate("visibleNumeric", getVisibleNumericLessonTitle());

    const extraSelectors = [
      "[data-purpose='lecture-title']",
      "[data-purpose='player-header'] h1",
      "[data-purpose='curriculum-item-view-title']",
      "[data-purpose*='transcript'] [data-purpose*='title']",
      "[data-purpose*='curriculum'] [data-purpose*='title']",
      "h2",
      "h3"
    ];
    for (const sel of extraSelectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const node of nodes) {
        const text = normalize(node.textContent || "");
        if (!text) continue;
        pushCandidate(`dom:${sel}`, text);
      }
    }

    lessonCandidates.sort((a, b) => b.score - a.score);
    let lesson = lessonCandidates.length ? lessonCandidates[0].text : "";

    if (state.debug && lessonCandidates.length) {
      const pickKey = `${lessonCandidates[0].source}|${lessonCandidates[0].text}`;
      if (state.lastLessonPickDiag !== pickKey) {
        state.lastLessonPickDiag = pickKey;
        addDiag("lesson.pick", `${lessonCandidates[0].source} -> ${lessonCandidates[0].text}`);
        addDiag(
          "lesson.candidates",
          lessonCandidates
            .slice(0, 5)
            .map((c) => `${c.source}:${c.score}:${c.text}`)
            .join(" | ")
        );
      }
    }

    if (!course || !lesson) {
      if (title.includes("|")) {
        const parts = title.split("|").map((p) => normalize(p));
        if (!lesson && parts.length) {
          const fromTitle = normalizeLessonTitle(parts[0]);
          if (fromTitle && !isNoisyLessonText(fromTitle)) {
            lesson = fromTitle;
          }
        }
        if (!course && parts.length > 1) course = parts[1];
      }
    }

    course = sanitizeName(course, "curso-sem-nome");
    lesson = sanitizeName(lesson, "aula-sem-nome");

    // Guardrail: never allow lesson name to collapse to course name.
    const courseKey = normalize(course).toLowerCase();
    const lessonKey = normalize(lesson).toLowerCase();
    if (!lessonKey || lessonKey === courseKey) {
      const byLecture = normalizeLessonTitle(getLessonTitleByLectureId(lectureId) || "");
      if (byLecture && normalize(byLecture).toLowerCase() !== courseKey && !isNoisyLessonText(byLecture)) {
        lesson = sanitizeName(byLecture, lesson);
      } else if (lectureId) {
        lesson = `Aula-${lectureId}`;
      } else {
        lesson = "aula-sem-nome";
      }
      addDiag("lesson.guardrail", `course=${course} lesson=${lesson}`);
    }

    // Safety for summary files: use stable lecture id only.
    if (state.summaryMode && lectureId) {
      lesson = `L${lectureId}`;
    }

    return { course, lesson, lectureId };
  }

  function getLessonKey(context) {
    if (!context) return "";
    if (context.lectureId) {
      return `${context.course}::lecture:${context.lectureId}::${context.lesson}`;
    }
    return `${context.course}::${context.lesson}`;
  }

  function getSeenMapForLesson(context) {
    const key = getLessonKey(context);
    if (!key) return null;
    if (!state.summarySeenByLesson[key]) {
      state.summarySeenByLesson[key] = {};
    }
    return state.summarySeenByLesson[key];
  }

  function setLiveContext(context) {
    if (!context) return;
    state.live.currentCourse = context.course || "";
    state.live.currentLesson = context.lesson || "";
    state.live.currentKey = getLessonKey(context) || "";
  }

  function withTimeout(ms = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  }

  function getIntegrationBases() {
    const primary = normalize(state.integrationUrl || DEFAULTS.integrationUrl).replace(/\/+$/, "");
    const candidates = [primary];
    if (/127\.0\.0\.1/.test(primary)) {
      candidates.push(primary.replace("127.0.0.1", "localhost"));
    } else if (/localhost/.test(primary)) {
      candidates.push(primary.replace("localhost", "127.0.0.1"));
    }
    return [...new Set(candidates)];
  }

  async function callIntegrationViaBackground(path, payload, method, bases) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "INTEGRATION_REQUEST",
          path,
          payload,
          method,
          bases
        },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "runtime sendMessage failed"));
            return;
          }
          if (!response?.ok) {
            reject(new Error(response?.error || "integration request failed"));
            return;
          }
          resolve(response.data || {});
        }
      );
    });
  }

  async function callIntegration(path, payload, method = "POST") {
    const bases = getIntegrationBases();
    let lastErr = null;

    try {
      return await callIntegrationViaBackground(path, payload, method, bases);
    } catch (err) {
      lastErr = err;
      addDiag("integration.bg.error", String(err.message || err));
    }

    for (const base of bases) {
      const url = `${base}${path}`;
      const timeout = withTimeout(12000);
      try {
        const init = {
          method,
          headers: { "Content-Type": "application/json" },
          signal: timeout.signal
        };
        if (method !== "GET") {
          init.body = JSON.stringify(payload || {});
        }
        const res = await fetch(url, init);
        const text = await res.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (_) {
          data = { raw: text };
        }
        if (!res.ok || data.ok === false) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        return data;
      } catch (err) {
        lastErr = err;
        addDiag("integration.fetch.error", `${url} ${String(err.message || err)}`);
      } finally {
        timeout.done();
      }
    }

    throw lastErr || new Error("Integration request failed");
  }

  function queueSummaryLine(text) {
    if (!state.summaryMode) return;
    const clean = normalize(text);
    if (!clean) return;
    const currentContext = getLessonContext();
    const incomingKey = getLessonKey(currentContext);
    const currentKey = getLessonKey(state.summaryContext);

    if (!state.summaryContext) {
      state.summaryContext = currentContext;
      setLiveContext(state.summaryContext);
    } else if (incomingKey && currentKey && incomingKey !== currentKey) {
      flushSummaryBuffer(state.summaryContext);
      addDiag(
        "summary.context.switch",
        `${currentKey} -> ${incomingKey} (${state.summaryContext.lesson} -> ${currentContext.lesson})`
      );
      state.summaryContext = currentContext;
      setLiveContext(state.summaryContext);
    }

    const seen = getSeenMapForLesson(state.summaryContext || currentContext);
    if (seen && seen[clean]) {
      return;
    }
    if (seen) {
      seen[clean] = true;
    }

    state.summaryBuffer.push(clean);
    if (!state.summaryFlushTimer) {
      state.summaryFlushTimer = setTimeout(() => {
        flushSummaryBuffer(state.summaryContext);
      }, 4000);
    }
    if (state.summaryBuffer.length > 120) {
      flushSummaryBuffer(state.summaryContext);
      return;
    }
  }

  function getTranscriptLinesSnapshot() {
    const roots = Array.from(
      document.querySelectorAll("[data-purpose*='transcript'], [class*='transcript']")
    );
    if (!roots.length) return [];

    const cueSelectors = [
      "[data-purpose*='transcript-cue']",
      "[class*='transcript--underline-cue']",
      "[class*='transcript--cue']"
    ];

    const out = [];
    for (const root of roots) {
      for (const sel of cueSelectors) {
        const nodes = Array.from(root.querySelectorAll(sel));
        for (const node of nodes) {
          const t = normalize(node.textContent || "");
          if (isLikelySpeech(t)) {
            out.push(t);
          }
        }
      }
    }

    return [...new Set(out)];
  }

  function collectSummaryData(fallbackText = "") {
    if (!state.summaryMode) return;
    const context = state.summaryContext || getLessonContext();
    const transcriptLines = getTranscriptLinesSnapshot();
    if (transcriptLines.length) {
      for (const line of transcriptLines) {
        queueSummaryLine(line);
      }
      state.live.lastSummarySource = "transcript";
      addDiag("summary.source", `transcript +${transcriptLines.length}`);
      maybeAutoSummarizeFromTranscript(context, transcriptLines.length);
      return;
    }

    // Resumo/arquivo local deve usar somente a aba Transcricao.
    if (fallbackText) {
      state.live.lastSummarySource = "waiting-transcript";
      const now = Date.now();
      if (!state.lastTranscriptWaitDiagAt || now - state.lastTranscriptWaitDiagAt > 10000) {
        addDiag("summary.source", "waiting-transcript");
        state.lastTranscriptWaitDiagAt = now;
      }
    }
  }

  function maybeAutoSummarizeFromTranscript(context, lineCount) {
    if (!state.summaryMode || !state.autoSummary) return;
    if (!lineCount || lineCount < 3) return;
    if (state.autoSummaryInFlight) return;

    const key = getLessonKey(context);
    if (!key) return;

    const now = Date.now();
    if (!state.transcriptAutoMeta[key]) {
      state.transcriptAutoMeta[key] = {
        lastCount: lineCount,
        lastChangedAt: now,
        done: false
      };
      return;
    }

    const meta = state.transcriptAutoMeta[key];
    if (meta.done) return;

    if (meta.lastCount !== lineCount) {
      meta.lastCount = lineCount;
      meta.lastChangedAt = now;
      return;
    }

    const stableMs = now - meta.lastChangedAt;
    if (stableMs < 8000) return;

    state.autoSummaryInFlight = true;
    addDiag("summary.auto.trigger", `${key} lines=${lineCount} stableMs=${stableMs}`);
    finalizeCurrentLesson(true)
      .then(() => {
        meta.done = true;
      })
      .catch((err) => {
        addDiag("summary.auto.error", String(err?.message || err));
      })
      .finally(() => {
        state.autoSummaryInFlight = false;
      });
  }

  async function flushSummaryBuffer(contextOverride = null) {
    if (state.summaryFlushTimer) {
      clearTimeout(state.summaryFlushTimer);
      state.summaryFlushTimer = null;
    }
    if (!state.summaryMode) {
      state.summaryBuffer = [];
      return;
    }
    if (!state.summaryBuffer.length) return;

    const lines = state.summaryBuffer.splice(0, state.summaryBuffer.length);
    const context = contextOverride || state.summaryContext || getLessonContext();
    setLiveContext(context);
    try {
      await callIntegration("/append", {
        course: context.course,
        lesson: context.lesson,
        lines
      });
      state.live.lastAppendAt = new Date().toISOString();
      state.live.lastAppendTarget = `${context.course}/${context.lesson}`;
      state.live.lastAppendCount = lines.length;
      addDiag("summary.append", `${context.course}/${context.lesson} +${lines.length}`);
    } catch (err) {
      state.live.lastError = String(err.message || err);
      addDiag("summary.append.error", String(err.message || err));
    }
  }

  async function summarizeCurrentLesson(contextOverride = null, asyncMode = false) {
    const context = contextOverride || state.summaryContext || getLessonContext();
    setLiveContext(context);
    await flushSummaryBuffer(context);
    const result = await callIntegration(asyncMode ? "/summarize-async" : "/summarize", {
      course: context.course,
      lesson: context.lesson
    });
    state.live.lastSummaryAt = new Date().toISOString();
    state.live.lastSummaryTarget = `${context.course}/${context.lesson}`;
    addDiag(asyncMode ? "summary.queued" : "summary.done", `${context.course}/${context.lesson}`);
    return result;
  }

  async function finalizeCurrentLesson(autoTriggered = false) {
    if (!state.summaryMode) return;
    const context = state.summaryContext || getLessonContext();
    const key = getLessonKey(context);
    if (!key) return;
    if (autoTriggered && state.lastAutoSummarizedKey === key) return;
    try {
      const result = await summarizeCurrentLesson(context, autoTriggered);
      if (autoTriggered) {
        state.lastAutoSummarizedKey = key;
      }
      return result;
    } catch (err) {
      addDiag("summary.finalize.error", String(err.message || err));
      throw err;
    }
  }

  function getCurrentVideo() {
    return document.querySelector("video");
  }

  function getSelectedVoice() {
    const voices = window.speechSynthesis.getVoices();
    if (!voices.length) return null;
    if (state.voiceURI) {
      const byURI = voices.find((v) => v.voiceURI === state.voiceURI);
      if (byURI) return byURI;
    }
    const ptBr = voices.find((v) => /^pt-BR$/i.test(v.lang));
    return ptBr || voices[0];
  }

  function getWords(text) {
    return normalize(text).split(" ").filter(Boolean).length;
  }

  function normalizeAutoRateBounds(minValue, maxValue) {
    const min = Math.min(2, Math.max(0.5, Number(minValue) || 1.3));
    const max = Math.min(2, Math.max(0.5, Number(maxValue) || 1.8));
    if (min <= max) return { min, max };
    return { min: max, max: min };
  }

  function estimateSecondsAtRate1(text) {
    const words = getWords(text);
    if (!words) return 0;
    const punctuationCount = (text.match(/[.,;:!?]/g) || []).length;
    const baseWpm = 165;
    return words * (60 / baseWpm) + punctuationCount * 0.09 + 0.12;
  }

  function cleanupActiveSpeechMeta() {
    if (!state.activeSpeechMeta.length) return;
    const now = Date.now();
    state.activeSpeechMeta = state.activeSpeechMeta.filter((meta) => {
      const elapsedSec = Math.max(0, (now - Number(meta.startedAt || now)) / 1000);
      return elapsedSec <= Number(meta.estSec || 0) + 1.2;
    });
  }

  function removeActiveSpeechMeta(id) {
    if (!id) return;
    state.activeSpeechMeta = state.activeSpeechMeta.filter((meta) => meta.id !== id);
  }

  function getActiveRemainingSeconds() {
    cleanupActiveSpeechMeta();
    const now = Date.now();
    return state.activeSpeechMeta.reduce((acc, meta) => {
      const elapsedSec = Math.max(0, (now - Number(meta.startedAt || now)) / 1000);
      const remainingSec = Math.max(0, Number(meta.estSec || 0) - elapsedSec);
      return acc + remainingSec;
    }, 0);
  }

  function computeAdaptiveRate(capture) {
    const manualBaseRate = state.rate;
    if (!state.autoRate) return manualBaseRate;
    const bounds = normalizeAutoRateBounds(state.autoRateMin, state.autoRateMax);
    const autoMinRate = bounds.min;
    const autoMaxRate = bounds.max;
    const baseRate = autoMinRate;

    const ownText = capture?.text || "";
    const ownDuration = Number(capture?.cueDurationSec || 0);
    let requiredForCue = baseRate;
    const ownSecAtRate1 = estimateSecondsAtRate1(ownText);

    if (ownDuration > 0 && ownText) {
      const availableSec = Math.max(0.35, ownDuration - 0.1);
      requiredForCue = Math.max(baseRate, ownSecAtRate1 / availableSec);
    }

    const queuedWords = state.pendingCaptures.reduce((acc, item) => acc + getWords(item.text), 0);
    const totalQueuedWords = queuedWords + getWords(ownText);
    const queueCount = state.pendingCaptures.length + state.activeUtterances + 1;

    const activeRemainingSec = getActiveRemainingSeconds();
    const pendingSecAtBaseRate = state.pendingCaptures.reduce((acc, item) => {
      const atRate1 = estimateSecondsAtRate1(item.text);
      return acc + atRate1 / Math.max(0.5, baseRate);
    }, 0);
    const currentSecAtBaseRate = ownSecAtRate1 / Math.max(0.5, baseRate);
    const projectedLagSec = activeRemainingSec + pendingSecAtBaseRate + currentSecAtBaseRate;

    const targetLagSec = 1.4;
    const lagPressure = Math.max(0, projectedLagSec - targetLagSec);
    const countPressure = Math.max(0, queueCount - 2);
    const wordsPressure = Math.max(0, totalQueuedWords - 26);

    // Continuous pressure — no hard step thresholds to avoid sudden jumps
    const countBoost = countPressure * 0.18;
    const wordsBoost = wordsPressure / 220;
    const lagBoost = lagPressure * 0.24;
    // Soft saturation for extreme backlog (replaces hard if-then floors)
    const extremeLag = Math.max(0, projectedLagSec - 5);
    const extremeCount = Math.max(0, queueCount - 3);
    const softFloor = (extremeLag * 0.12) + (extremeCount * 0.08);

    const backlogBoost = 1 + countBoost + wordsBoost + lagBoost + softFloor;

    const rateByBacklog = baseRate * backlogBoost;
    const targetRate = Math.min(autoMaxRate, Math.max(autoMinRate, requiredForCue, rateByBacklog));

    // EMA smoothing with asymmetric alpha: ramp up faster, ramp down gently
    const prev = state.lastAdaptiveRate > 0 ? state.lastAdaptiveRate : targetRate;
    const goingUp = targetRate > prev;
    const alphaUp = 0.55;
    const alphaDown = 0.18;
    const alpha = goingUp ? alphaUp : alphaDown;
    let smoothedRate = prev + alpha * (targetRate - prev);

    // Hysteresis dead-zone: ignore tiny changes to prevent micro-oscillation
    if (Math.abs(smoothedRate - prev) < 0.04) {
      smoothedRate = prev;
    }

    // Clamp to bounds
    const finalRate = Math.min(autoMaxRate, Math.max(autoMinRate, smoothedRate));
    state.lastAdaptiveRate = finalRate;

    addDiag(
      "auto.rate.metric",
      `q=${queueCount} words=${totalQueuedWords} lag=${projectedLagSec.toFixed(
        2
      )}s req=${requiredForCue.toFixed(2)} boost=${backlogBoost.toFixed(2)} target=${targetRate.toFixed(
        2
      )} smooth=${finalRate.toFixed(2)}`
    );

    return finalRate;
  }

  function warmupTTS() {
    if (!canSpeak() || state.ttsWarmedUp) return;
    try {
      const utterance = new SpeechSynthesisUtterance(".");
      utterance.volume = 0;
      utterance.rate = 1;
      window.speechSynthesis.speak(utterance);
      // Keep warmup one-shot and clear immediately so it does not pollute queue.
      window.speechSynthesis.cancel();
      state.ttsWarmedUp = true;
      addDiag("tts.warmup", "ok");
    } catch (_) {
    }
  }

  function clearComposeTimer() {
    if (state.composeFlushTimer) {
      clearTimeout(state.composeFlushTimer);
      state.composeFlushTimer = null;
    }
  }

  function commitCaptureToQueue(capture, reason) {
    if (!capture?.text) return;
    const backlog = state.pendingCaptures.length + (state.isSpeaking ? 1 : 0);
    const lastQueued = state.pendingCaptures[state.pendingCaptures.length - 1];
    const mergedTextCandidate = lastQueued ? joinSpeechChunks(lastQueued.text, capture.text) : "";
    if (
      lastQueued &&
      backlog >= 1 &&
      mergedTextCandidate.length <= 360 &&
      getWords(mergedTextCandidate) <= 72
    ) {
      lastQueued.text = mergedTextCandidate;
      lastQueued.cueDurationSec += Number(capture.cueDurationSec || 0);
      addDiag(
        "merge",
        `${reason}/${capture.source} len=${lastQueued.text.length} -> ${lastQueued.text}`
      );
      return;
    }

    state.pendingCaptures.push(capture);
    addDiag(
      "enqueue",
      `${reason} source=${capture.source} cue=${Number(capture.cueDurationSec || 0).toFixed(
        2
      )}s queue=${state.pendingCaptures.length} text=${capture.text}`
    );
  }

  function flushComposeCapture(reason = "timer") {
    if (!state.composeCapture) return;
    clearComposeTimer();
    const buffered = state.composeCapture;
    state.composeCapture = null;
    commitCaptureToQueue(buffered, `compose:${reason}`);
    pumpSpeechQueue();
  }

  function enqueueCapture(capture) {
    const clean = normalize(capture?.text || "");
    const cleanKey = captureKey(clean);
    if (!clean || !canSpeak()) return;
    const now = Date.now();
    // Speech dedup: only immediate duplicate guard (anti-echo), never semantic skipping.
    if (cleanKey && cleanKey === state.lastEnqueueKey && now - state.lastEnqueueAt < 500) return;
    state.lastEnqueueKey = cleanKey;
    state.lastEnqueueAt = now;

    const normalizedCapture = {
      text: clean,
      source: capture?.source || "unknown",
      cueDurationSec: Number(capture?.cueDurationSec || 0)
    };
    state.live.lastCaptureAt = new Date().toISOString();
    state.live.lastCaptureSource = normalizedCapture.source;
    state.live.lastCaptureText = normalizedCapture.text;

    if (!state.composeCapture) {
      state.composeCapture = normalizedCapture;
    } else {
      const candidate = joinSpeechChunks(state.composeCapture.text, normalizedCapture.text);
      if (candidate.length <= 360 && getWords(candidate) <= 72) {
        state.composeCapture.text = candidate;
        state.composeCapture.cueDurationSec += normalizedCapture.cueDurationSec;
        addDiag("compose.join", `len=${candidate.length} text=${candidate}`);
      } else {
        flushComposeCapture("split");
        state.composeCapture = normalizedCapture;
      }
    }

    const backlog = state.pendingCaptures.length + state.activeUtterances;
    const composeWords = getWords(state.composeCapture?.text || "");
    if (composeWords >= 26 || backlog >= 2) {
      flushComposeCapture("threshold");
      return;
    }

    clearComposeTimer();
    const delayMs = backlog > 0 ? 140 : 65;
    state.composeFlushTimer = setTimeout(() => flushComposeCapture("debounce"), delayMs);
    // Keep TTS queue warm in case there is already pending content.
    pumpSpeechQueue();
  }

  function pumpSpeechQueue() {
    if (!canSpeak()) return;
    warmupTTS();

    if (!state.pendingCaptures.length && state.composeCapture) {
      flushComposeCapture("pump");
      if (!state.pendingCaptures.length) return;
    }

    // Keep small prebuffer for continuity while preserving order.
    const maxInFlight = 2;
    while (state.activeUtterances < maxInFlight && state.pendingCaptures.length) {
      const next = state.pendingCaptures.shift();
      if (!next) break;

      const voice = getSelectedVoice();
      const utterance = new SpeechSynthesisUtterance(next.text);
      const adaptiveRate = computeAdaptiveRate(next);
      const speechId = state.nextSpeechId++;
      const estSec = estimateSecondsAtRate1(next.text) / Math.max(0.5, adaptiveRate);
      utterance.rate = adaptiveRate;
      utterance.pitch = state.pitch;
      utterance.volume = state.volume;
      if (voice) utterance.voice = voice;

      state.activeSpeechMeta.push({
        id: speechId,
        startedAt: Date.now(),
        estSec
      });

      utterance.onend = () => {
        removeActiveSpeechMeta(speechId);
        state.activeUtterances = Math.max(0, state.activeUtterances - 1);
        state.isSpeaking = state.activeUtterances > 0;
        queueMicrotask(pumpSpeechQueue);
      };
      utterance.onerror = () => {
        removeActiveSpeechMeta(speechId);
        state.activeUtterances = Math.max(0, state.activeUtterances - 1);
        state.isSpeaking = state.activeUtterances > 0;
        queueMicrotask(pumpSpeechQueue);
      };

      state.activeUtterances += 1;
      state.isSpeaking = true;
      try {
        window.speechSynthesis.speak(utterance);
      } catch (_) {
        removeActiveSpeechMeta(speechId);
        state.activeUtterances = Math.max(0, state.activeUtterances - 1);
        state.isSpeaking = state.activeUtterances > 0;
        break;
      }

      state.lastSpoken = next.text;
      addDiag(
        "speak",
        `source=${next.source} rate=${adaptiveRate.toFixed(2)} cue=${next.cueDurationSec.toFixed(
          2
        )}s queueAfterDequeue=${state.pendingCaptures.length} active=${state.activeUtterances} text=${next.text}`
      );
    }
  }

  function stopSpeaking() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    clearComposeTimer();
    state.composeCapture = null;
    state.pendingCaptures = [];
    state.lastCaptureKeyBySource = {};
    state.lastEnqueueKey = "";
    state.lastEnqueueAt = 0;
    state.isSpeaking = false;
    state.activeUtterances = 0;
    state.activeSpeechMeta = [];
    state.ttsWarmedUp = false;
  }

  function getTrackCapture() {
    const video = getCurrentVideo();
    if (!video || !video.textTracks) return null;

    let selectedTrack = null;
    for (const track of video.textTracks) {
      if (!track) continue;
      const isCaption = track.kind === "captions" || track.kind === "subtitles";
      if (!isCaption) continue;
      const lang = (track.language || "").toLowerCase();
      const isPortuguese = lang.startsWith("pt");
      if (track.mode === "showing" || track.mode === "hidden") {
        if (isPortuguese) {
          selectedTrack = track;
          break;
        }
        selectedTrack = selectedTrack || track;
      }
      if (!selectedTrack) selectedTrack = track;
    }
    if (!selectedTrack) return null;

    if (selectedTrack.mode === "disabled") {
      selectedTrack.mode = "hidden";
    }

    const cues = selectedTrack.activeCues;
    if (!cues || !cues.length) return null;
    const text = normalize(Array.from(cues).map((c) => c.text).join(" "));
    if (!isLikelySpeech(text)) return null;

    let cueDurationSec = 0;
    try {
      const firstCue = cues[0];
      if (firstCue && Number.isFinite(firstCue.startTime) && Number.isFinite(firstCue.endTime)) {
        cueDurationSec = Math.max(0, firstCue.endTime - firstCue.startTime);
      }
    } catch (_) {
    }

    return {
      text,
      source: "track",
      cueDurationSec
    };
  }

  function getPlayerCaptionCapture() {
    const selectors = [
      "[data-purpose*='captions-cue-text']",
      "[data-purpose*='captions'] [class*='cue']",
      "[class*='captions-display'] [class*='cue']",
      "[class*='captions-display'] span",
      "[class*='captions'] [aria-live='assertive']",
      "[class*='captions'] [aria-live='polite']"
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (!nodes.length) continue;
      const visibleNodes = nodes.filter((n) => {
        const el = /** @type {HTMLElement} */ (n);
        return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      });
      const pool = visibleNodes.length ? visibleNodes : nodes;
      const last = pool[pool.length - 1];
      const text = normalize((last && last.textContent) || "");
      if (!isLikelySpeech(text)) continue;
      return {
        text,
        source: "player-dom",
        cueDurationSec: 0
      };
    }

    return null;
  }

  function findActiveTranscriptNode() {
    const transcriptRoots = Array.from(
      document.querySelectorAll(
        "[data-purpose*='transcript'], [class*='transcript']"
      )
    );
    if (!transcriptRoots.length) return null;

    const selectors = [
      "[class*='transcript--underline-cue'][class*='active']",
      "[class*='transcript--cue'][class*='active']",
      "[data-purpose*='transcript-cue'][aria-current='true']",
      "[aria-current='true']"
    ];

    for (const root of transcriptRoots) {
      for (const selector of selectors) {
        const node = root.querySelector(selector);
        if (node) return node;
      }
    }

    for (const root of transcriptRoots) {
      const node =
        root.querySelector("[class*='transcript--underline-cue'] span") ||
        root.querySelector("[class*='transcript--cue'] span") ||
        root.querySelector("span");
      if (node) return node;
    }

    return null;
  }

  function getTranscriptCapture() {
    const node = findActiveTranscriptNode();
    if (!node) return null;
    const text = normalize(node.textContent || "");
    if (!isLikelySpeech(text)) return null;
    return {
      text,
      source: "transcript",
      cueDurationSec: 0
    };
  }

  function processTick() {
    if (!isUdemyCoursePage()) return;
    const speechEnabled = canSpeak();
    if (!speechEnabled && !state.summaryMode) return;

    const video = getCurrentVideo();
    if (video && video.paused && !state.summaryMode) return;

    const mode = state.sourceMode;
    const trackCapture = getTrackCapture();
    const playerCapture = getPlayerCaptionCapture();
    const transcriptCapture = getTranscriptCapture();

    if (playerCapture && trackCapture && !playerCapture.cueDurationSec) {
      playerCapture.cueDurationSec = trackCapture.cueDurationSec;
    }

    const processCandidate = (capture) => {
      if (!capture?.text) return false;
      const keyBySource = captureKey(capture.text);
      const source = capture.source || "unknown";
      if (!keyBySource) return false;
      if (state.lastCaptureKeyBySource[source] === keyBySource) return false;
      state.lastCaptureKeyBySource[source] = keyBySource;

      addDiag(
        "capture",
        `${mode}/${capture.source} cue=${Number(capture.cueDurationSec || 0).toFixed(2)}s ${
          capture.text
        }`
      );
      collectSummaryData(capture.text);
      if (speechEnabled) {
        enqueueCapture(capture);
      }
      return true;
    };

    let processedAny = false;
    if (mode === "track") {
      // Single-source per tick to preserve ordering: player first, track as fallback.
      processedAny = processCandidate(playerCapture || trackCapture) || processedAny;
    } else {
      processedAny = processCandidate(transcriptCapture) || processedAny;
    }

    if (!processedAny && state.summaryMode) {
      // Even without a new spoken cue, transcript panel may have additional lines loaded.
      collectSummaryData("");
    }
  }

  function bindTrackEvents() {
    const video = getCurrentVideo();
    if (!video) return;

    if (state.activeVideoEl !== video) {
      state.trackListenersBound = false;
      state.activeVideoEl = video;
    }

    if (state.trackListenersBound) return;

    if (video.textTracks) {
      for (const track of video.textTracks) {
        if (!track) continue;
        try {
          track.addEventListener("cuechange", processTick);
        } catch (_) {
        }
      }
    }

    video.addEventListener("play", processTick);
    video.addEventListener("ended", () => {
      if (!state.autoSummary) return;
      addDiag("lesson.ended", "video ended; finalizing summary (autoSummary)");
      finalizeCurrentLesson(true);
    });
    state.trackListenersBound = true;
  }

  function setupObservers() {
    if (state.observer) return;
    const observer = new MutationObserver(() => {
      bindTrackEvents();
      processTick();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true
    });
    state.observer = observer;
  }

  function getPublicState() {
    const currentContext = state.summaryContext || getLessonContext();
    setLiveContext(currentContext);
    return {
      enabled: state.enabled,
      rate: state.rate,
      autoRateMin: state.autoRateMin,
      autoRateMax: state.autoRateMax,
      pitch: state.pitch,
      volume: state.volume,
      voiceURI: state.voiceURI,
      debug: state.debug,
      autoRate: state.autoRate,
      summaryMode: false,
      autoSummary: false,
      sourceMode: state.sourceMode,
      integrationUrl: state.integrationUrl,
      queueSize:
        state.pendingCaptures.length +
        (state.composeCapture ? 1 : 0) +
        (state.isSpeaking ? 1 : 0),
      summaryBufferSize: state.summaryBuffer.length,
      summaryContext: currentContext,
      live: { ...state.live },
      diagnostics: state.diagnostics,
      voices: window.speechSynthesis.getVoices().map((v) => ({
        name: v.name,
        lang: v.lang,
        voiceURI: v.voiceURI
      }))
    };
  }

  function applySettings(next) {
    const merged = { ...DEFAULTS, ...next };
    state.enabled = !!merged.enabled;
    state.rate = Math.min(2, Math.max(0.5, Number(merged.rate) || 1));
    state.pitch = Math.min(2, Math.max(0, Number(merged.pitch) || 1));
    state.volume = Math.min(1, Math.max(0, Number(merged.volume) || 1));
    state.voiceURI = merged.voiceURI || "";
    state.sourceMode = ["track", "transcript"].includes(merged.sourceMode)
      ? merged.sourceMode
      : "track";
    state.debug = !!merged.debug;
    state.autoRate = merged.autoRate !== false;
    const bounds = normalizeAutoRateBounds(merged.autoRateMin, merged.autoRateMax);
    state.autoRateMin = bounds.min;
    state.autoRateMax = bounds.max;
    state.summaryMode = FILE_SAVE_DISABLED ? false : !!merged.summaryMode;
    state.autoSummary = FILE_SAVE_DISABLED ? false : !!merged.autoSummary;
    state.integrationUrl = normalize(merged.integrationUrl || DEFAULTS.integrationUrl);
    state.summaryBuffer = [];
    state.summaryContext = null;
    state.summarySeenByLesson = {};
    state.transcriptAutoMeta = {};
    state.autoSummaryInFlight = false;
    state.lastTranscriptWaitDiagAt = 0;
    if (!state.enabled) {
      stopSpeaking();
    } else {
      warmupTTS();
      processTick();
      pumpSpeechQueue();
    }
  }

  chrome.storage.sync.get(DEFAULTS, (saved) => {
    applySettings(saved);
    bindTrackEvents();
    setupObservers();
    setInterval(processTick, 60);
    state.initialized = true;
  });

  window.addEventListener("beforeunload", () => {
    flushSummaryBuffer(state.summaryContext);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      flushSummaryBuffer(state.summaryContext);
    }
  });

  if ("speechSynthesis" in window) {
    window.speechSynthesis.onvoiceschanged = () => {};
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    if (message.type === "GET_STATE") {
      sendResponse({ ok: true, state: getPublicState() });
      return;
    }

    if (message.type === "SET_STATE") {
      const nextState = { ...message.state };
      chrome.storage.sync.set(nextState, () => {
        applySettings(nextState);
        sendResponse({ ok: true, state: getPublicState() });
      });
      return true;
    }

    if (message.type === "GET_DIAGNOSTICS") {
      sendResponse({ ok: true, diagnostics: state.diagnostics });
      return;
    }

    if (message.type === "CLEAR_DIAGNOSTICS") {
      state.diagnostics = [];
      sendResponse({ ok: true });
      return;
    }

    if (message.type === "CHECK_INTEGRATION") {
      callIntegration("/health", null, "GET")
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
      return true;
    }

    if (message.type === "SUMMARIZE_NOW") {
      sendResponse({ ok: false, error: "Resumo/salvamento está desativado temporariamente." });
      return;
    }

    if (message.type === "STOP") {
      stopSpeaking();
      sendResponse({ ok: true });
      return;
    }
  });
})();
