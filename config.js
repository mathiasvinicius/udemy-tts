const DEFAULT_STATE = {
  enabled: false,
  sourceMode: "track",
  voiceURI: "",
  rate: 1.0,
  autoRate: true,
  autoRateMin: 1.3,
  autoRateMax: 1.8,
  volume: 1.0,
  debug: false,
  summaryMode: false,
  autoSummary: false
};

const els = {
  enabled: document.getElementById("enabled"),
  sourceMode: document.getElementById("sourceMode"),
  voice: document.getElementById("voice"),
  rate: document.getElementById("rate"),
  rateOut: document.getElementById("rateOut"),
  autoRate: document.getElementById("autoRate"),
  autoRateMin: document.getElementById("autoRateMin"),
  autoRateMinOut: document.getElementById("autoRateMinOut"),
  autoRateMax: document.getElementById("autoRateMax"),
  autoRateMaxOut: document.getElementById("autoRateMaxOut"),
  volume: document.getElementById("volume"),
  volumeOut: document.getElementById("volumeOut"),
  debug: document.getElementById("debug"),
  stopBtn: document.getElementById("stopBtn"),
  refreshLogBtn: document.getElementById("refreshLogBtn"),
  copyLogBtn: document.getElementById("copyLogBtn"),
  clearLogBtn: document.getElementById("clearLogBtn"),
  liveBox: document.getElementById("liveBox"),
  logBox: document.getElementById("logBox"),
  status: document.getElementById("status")
};

function setStatus(text) {
  els.status.textContent = text;
}

function isUdemyUrl(url) {
  return /https:\/\/(?:[^/]+\.)?udemy\.com\//i.test(String(url || ""));
}

function queryActiveTab() {
  return chrome.tabs.query({ active: true, currentWindow: true });
}

function queryUdemyTabs() {
  return chrome.tabs.query({ url: ["https://*.udemy.com/*"] });
}

async function getPreferredUdemyTab() {
  const [active] = await queryActiveTab();
  if (active?.id && isUdemyUrl(active.url)) {
    return active;
  }
  const tabs = await queryUdemyTabs();
  return tabs[0] || null;
}

async function sendToUdemyTab(message, required = true) {
  const tab = await getPreferredUdemyTab();
  if (!tab?.id) {
    if (required) throw new Error("Nenhuma aba da Udemy aberta.");
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

async function getStoredState() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_STATE, (saved) => {
      resolve({ ...DEFAULT_STATE, ...(saved || {}) });
    });
  });
}

async function saveStoredState(state) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(state, resolve);
  });
}

async function broadcastStateToUdemyTabs(state) {
  const tabs = await queryUdemyTabs();
  if (!tabs.length) return { total: 0, applied: 0 };

  const results = await Promise.allSettled(
    tabs.map((tab) => chrome.tabs.sendMessage(tab.id, { type: "SET_STATE", state }))
  );
  const applied = results.filter((r) => r.status === "fulfilled").length;
  return { total: tabs.length, applied };
}

function populateVoices(voices, selectedVoiceURI) {
  els.voice.innerHTML = "";
  const sorted = [...(voices || [])].sort((a, b) => {
    const aPt = /^pt/i.test(a.lang) ? 0 : 1;
    const bPt = /^pt/i.test(b.lang) ? 0 : 1;
    if (aPt !== bPt) return aPt - bPt;
    return (a.name || "").localeCompare(b.name || "");
  });

  if (!sorted.length) {
    const option = document.createElement("option");
    option.value = selectedVoiceURI || "";
    option.textContent = selectedVoiceURI
      ? `Voz salva (${selectedVoiceURI})`
      : "Padrão automático (abra a Udemy para listar vozes)";
    option.selected = true;
    els.voice.appendChild(option);
    return;
  }

  for (const voice of sorted) {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})`;
    if (voice.voiceURI === selectedVoiceURI) {
      option.selected = true;
    }
    els.voice.appendChild(option);
  }
}

function syncRateModeUI() {
  const auto = !!els.autoRate.checked;
  els.rate.disabled = auto;
  els.rate.title = auto ? "Desative o modo automático para ajustar manualmente." : "";
}

function normalizeAutoRateBounds(minValue, maxValue) {
  const min = Math.min(2, Math.max(0.5, Number(minValue) || 1.3));
  const max = Math.min(2, Math.max(0.5, Number(maxValue) || 1.8));
  if (min <= max) return { min, max };
  return { min: max, max: min };
}

function refreshAutoBoundsOutputs() {
  const bounds = normalizeAutoRateBounds(els.autoRateMin.value, els.autoRateMax.value);
  els.autoRateMinOut.textContent = bounds.min.toFixed(1);
  els.autoRateMaxOut.textContent = bounds.max.toFixed(1);
}

function applyStateToUI(state, voices = []) {
  const bounds = normalizeAutoRateBounds(state.autoRateMin, state.autoRateMax);
  els.enabled.checked = !!state.enabled;
  const mode = state.sourceMode === "transcript" ? "transcript" : "track";
  els.sourceMode.value = mode;
  els.rate.value = state.rate ?? 1;
  els.rateOut.textContent = Number(els.rate.value).toFixed(1);
  els.autoRate.checked = state.autoRate !== false;
  syncRateModeUI();
  els.autoRateMin.value = bounds.min;
  els.autoRateMax.value = bounds.max;
  refreshAutoBoundsOutputs();
  els.volume.value = state.volume ?? 1;
  els.volumeOut.textContent = Number(els.volume.value).toFixed(1);
  els.debug.checked = !!state.debug;
  populateVoices(voices, state.voiceURI || "");
}

function readStateFromUI() {
  const bounds = normalizeAutoRateBounds(els.autoRateMin.value, els.autoRateMax.value);
  return {
    enabled: els.enabled.checked,
    sourceMode: els.sourceMode.value,
    voiceURI: els.voice.value,
    rate: Number(els.rate.value),
    autoRate: els.autoRate.checked,
    autoRateMin: bounds.min,
    autoRateMax: bounds.max,
    volume: Number(els.volume.value),
    debug: els.debug.checked,
    summaryMode: false,
    autoSummary: false
  };
}

function renderLiveState(state, online = false) {
  const live = state?.live || {};
  const lines = [
    `udemy: ${online ? "conectado" : "sem aba conectada"}`,
    `sourceMode: ${state?.sourceMode || "-"}`,
    `queue: ${Number(state?.queueSize || 0)}`,
    `curso: ${live.currentCourse || "-"}`,
    `aula: ${live.currentLesson || "-"}`,
    `chave: ${live.currentKey || "-"}`,
    `ultimaCaptura: ${live.lastCaptureAt || "-"} (${live.lastCaptureSource || "-"})`,
    `erro: ${live.lastError || "-"}`
  ];
  els.liveBox.value = lines.join("\n");
}

async function refreshDiagnostics() {
  const response = await sendToUdemyTab({ type: "GET_STATE" }, false);
  if (!response?.ok) {
    const stored = await getStoredState();
    renderLiveState(stored, false);
    return;
  }

  const state = response.state || {};
  const diagnostics = state.diagnostics || [];
  els.logBox.value = diagnostics.join("\n");
  renderLiveState(state, true);
}

async function saveState() {
  try {
    const state = readStateFromUI();
    els.autoRateMin.value = state.autoRateMin;
    els.autoRateMax.value = state.autoRateMax;
    refreshAutoBoundsOutputs();
    await saveStoredState(state);
    const result = await broadcastStateToUdemyTabs(state);
    if (!result.total) {
      setStatus("Configuração salva. Será aplicada quando abrir a Udemy.");
    } else {
      setStatus(`Configuração salva. Aplicada em ${result.applied}/${result.total} aba(s) da Udemy.`);
    }
    if (state.debug) {
      await refreshDiagnostics();
    }
  } catch (error) {
    setStatus(`Falha ao salvar: ${error.message}`);
  }
}

function wireEvents() {
  els.enabled.addEventListener("change", saveState);
  els.sourceMode.addEventListener("change", saveState);
  els.voice.addEventListener("change", saveState);
  els.rate.addEventListener("input", () => {
    els.rateOut.textContent = Number(els.rate.value).toFixed(1);
  });
  els.rate.addEventListener("change", saveState);
  els.autoRate.addEventListener("change", () => {
    syncRateModeUI();
    saveState();
  });
  els.autoRateMin.addEventListener("input", () => {
    refreshAutoBoundsOutputs();
  });
  els.autoRateMin.addEventListener("change", saveState);
  els.autoRateMax.addEventListener("input", () => {
    refreshAutoBoundsOutputs();
  });
  els.autoRateMax.addEventListener("change", saveState);
  els.volume.addEventListener("input", () => {
    els.volumeOut.textContent = Number(els.volume.value).toFixed(1);
  });
  els.volume.addEventListener("change", saveState);
  els.debug.addEventListener("change", saveState);

  els.stopBtn.addEventListener("click", async () => {
    try {
      await sendToUdemyTab({ type: "STOP" });
      setStatus("Leitura interrompida.");
    } catch (error) {
      setStatus(`Falha ao parar: ${error.message}`);
    }
  });

  els.refreshLogBtn.addEventListener("click", async () => {
    try {
      await refreshDiagnostics();
      setStatus("Estado atualizado.");
    } catch (error) {
      setStatus(`Falha ao atualizar: ${error.message}`);
    }
  });

  els.copyLogBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(els.logBox.value || "");
      setStatus("Log copiado.");
    } catch (error) {
      setStatus(`Falha ao copiar: ${error.message}`);
    }
  });

  els.clearLogBtn.addEventListener("click", async () => {
    try {
      const resp = await sendToUdemyTab({ type: "CLEAR_DIAGNOSTICS" }, false);
      if (resp?.ok) {
        els.logBox.value = "";
      }
      setStatus("Log limpo.");
    } catch (error) {
      setStatus(`Falha ao limpar: ${error.message}`);
    }
  });
}

async function init() {
  wireEvents();

  const storedState = await getStoredState();
  const liveResponse = await sendToUdemyTab({ type: "GET_STATE" }, false);

  if (liveResponse?.ok) {
    const liveState = liveResponse.state || {};
    applyStateToUI({ ...storedState, ...liveState }, liveState.voices || []);
    els.logBox.value = (liveState.diagnostics || []).join("\n");
    renderLiveState(liveState, true);
    setStatus("Pronto.");
  } else {
    applyStateToUI(storedState, []);
    els.logBox.value = "";
    renderLiveState(storedState, false);
    setStatus("Configuração carregada (sem aba da Udemy conectada).");
  }

  setInterval(() => {
    refreshDiagnostics().catch(() => {});
  }, 1200);
}

init();
