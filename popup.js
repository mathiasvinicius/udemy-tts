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
  volume: document.getElementById("volume"),
  volumeOut: document.getElementById("volumeOut"),
  debug: document.getElementById("debug"),
  openConfigBtn: document.getElementById("openConfigBtn"),
  status: document.getElementById("status")
};

let cachedState = {};

function setStatus(text) {
  els.status.textContent = text;
}

function queryActiveTab() {
  return chrome.tabs.query({ active: true, currentWindow: true });
}

function isUdemyUrl(url) {
  return /https:\/\/(?:[^/]+\.)?udemy\.com\//i.test(String(url || ""));
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

async function sendToUdemyTab(message) {
  const tab = await getPreferredUdemyTab();
  if (!tab?.id) throw new Error("Nenhuma aba da Udemy aberta.");
  return chrome.tabs.sendMessage(tab.id, message);
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

function getBrowserVoices() {
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve([]);

  const immediate = synth.getVoices() || [];
  if (immediate.length) return Promise.resolve(immediate);

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      synth.removeEventListener("voiceschanged", onVoicesChanged);
      clearTimeout(timer);
      resolve(synth.getVoices() || []);
    };
    const onVoicesChanged = () => finish();
    const timer = setTimeout(finish, 900);
    synth.addEventListener("voiceschanged", onVoicesChanged);
  });
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

function readStateFromUI() {
  return {
    ...cachedState,
    enabled: els.enabled.checked,
    sourceMode: els.sourceMode.value,
    voiceURI: els.voice.value,
    rate: Number(els.rate.value),
    autoRate: els.autoRate.checked,
    volume: Number(els.volume.value),
    debug: els.debug.checked,
    summaryMode: false,
    autoSummary: false
  };
}

function syncRateModeUI() {
  const auto = !!els.autoRate.checked;
  els.rate.disabled = auto;
  els.rate.title = auto ? "Desative o modo automático para ajustar manualmente." : "";
}

async function saveState() {
  try {
    const state = readStateFromUI();
    await saveStoredState(state);
    const result = await broadcastStateToUdemyTabs(state);
    cachedState = { ...cachedState, ...state };
    if (!result.total) {
      setStatus("Configuração salva. Será aplicada quando abrir a Udemy.");
    } else {
      setStatus(`Configuração salva. Aplicada em ${result.applied}/${result.total} aba(s) da Udemy.`);
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
  els.volume.addEventListener("input", () => {
    els.volumeOut.textContent = Number(els.volume.value).toFixed(1);
  });
  els.volume.addEventListener("change", saveState);
  els.debug.addEventListener("change", saveState);
  els.openConfigBtn.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

async function init() {
  wireEvents();
  try {
    const storedState = await getStoredState();
    let effectiveState = { ...storedState };
    let voices = await getBrowserVoices();

    try {
      const response = await sendToUdemyTab({ type: "GET_STATE" });
      if (response?.ok) {
        const liveState = response.state || {};
        effectiveState = { ...storedState, ...liveState };
        voices = liveState.voices?.length ? liveState.voices : voices;
      }
    } catch (_) {
      // No connected Udemy tab; keep storage + local voices.
    }

    cachedState = { ...(effectiveState || {}) };
    els.enabled.checked = !!effectiveState.enabled;
    els.sourceMode.value = effectiveState.sourceMode === "transcript" ? "transcript" : "track";
    els.rate.value = effectiveState.rate ?? 1;
    els.rateOut.textContent = Number(els.rate.value).toFixed(1);
    els.autoRate.checked = effectiveState.autoRate !== false;
    syncRateModeUI();
    els.volume.value = effectiveState.volume ?? 1;
    els.volumeOut.textContent = Number(els.volume.value).toFixed(1);
    els.debug.checked = !!effectiveState.debug;
    populateVoices(voices, effectiveState.voiceURI || "");
    setStatus("Pronto.");
  } catch (error) {
    setStatus(`Falha ao carregar: ${error.message}`);
  }
}

init();
