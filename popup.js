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
  summaryMode: document.getElementById("summaryMode"),
  autoSummary: document.getElementById("autoSummary"),
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

async function sendToActiveTab(message) {
  const [tab] = await queryActiveTab();
  if (!tab?.id) throw new Error("Nenhuma aba ativa.");
  return chrome.tabs.sendMessage(tab.id, message);
}

function populateVoices(voices, selectedVoiceURI) {
  els.voice.innerHTML = "";
  const sorted = [...voices].sort((a, b) => {
    const aPt = /^pt/i.test(a.lang) ? 0 : 1;
    const bPt = /^pt/i.test(b.lang) ? 0 : 1;
    if (aPt !== bPt) return aPt - bPt;
    return (a.name || "").localeCompare(b.name || "");
  });

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
    await sendToActiveTab({ type: "SET_STATE", state });
    cachedState = { ...cachedState, ...state };
    setStatus("Configuração salva.");
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
  els.summaryMode.addEventListener("change", saveState);
  els.autoSummary.addEventListener("change", saveState);
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
    const response = await sendToActiveTab({ type: "GET_STATE" });
    if (!response?.ok) throw new Error("Resposta inválida da aba.");

    const { state } = response;
    cachedState = { ...(state || {}) };
    els.enabled.checked = !!state.enabled;
    els.sourceMode.value = state.sourceMode === "transcript" ? "transcript" : "track";
    els.rate.value = state.rate ?? 1;
    els.rateOut.textContent = Number(els.rate.value).toFixed(1);
    els.autoRate.checked = state.autoRate !== false;
    syncRateModeUI();
    els.volume.value = state.volume ?? 1;
    els.volumeOut.textContent = Number(els.volume.value).toFixed(1);
    els.debug.checked = !!state.debug;
    els.summaryMode.checked = false;
    els.summaryMode.disabled = true;
    els.autoSummary.checked = false;
    els.autoSummary.disabled = true;
    populateVoices(state.voices || [], state.voiceURI || "");
    setStatus("Pronto.");
  } catch (_) {
    setStatus("Abra uma aula da Udemy para usar.");
  }
}

init();
