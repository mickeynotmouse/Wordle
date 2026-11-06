// Text-to-speech (reading aloud) and speech-to-text (microphone) helpers.
// Uses the browser's built-in Web Speech API — works best in Chrome, Edge and Safari.

const Speech = (() => {
  const hasTTS = "speechSynthesis" in window;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  let enabled = true;
  let rate = 0.85;
  let voice = null;
  let lastSpoken = "";
  let queueToken = 0;

  // Prefer a clear, natural-sounding English voice when one is installed.
  function pickVoice() {
    if (!hasTTS) return;
    const voices = speechSynthesis.getVoices().filter(v => v.lang && v.lang.startsWith("en"));
    const preferred = [/natural/i, /google us english/i, /samantha/i, /daniel/i, /karen/i, /serena/i];
    for (const re of preferred) {
      const v = voices.find(v => re.test(v.name));
      if (v) { voice = v; return; }
    }
    voice = voices.find(v => v.default) || voices[0] || null;
  }
  if (hasTTS) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  // Chrome stops long utterances after ~15 s, so speak sentence by sentence.
  function chunks(text) {
    return text.match(/[^.!?]+[.!?]*/g)?.map(s => s.trim()).filter(Boolean) || [text];
  }

  function speakOne(text, token) {
    return new Promise(resolve => {
      if (token !== queueToken) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = rate;
      u.pitch = 1;
      u.volume = 1;
      if (voice) u.voice = voice;
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }

  /** Read text aloud. Returns a promise that resolves when finished. */
  async function say(text, { force = false } = {}) {
    if (!text) return;
    lastSpoken = text;
    if (!hasTTS || (!enabled && !force)) return;
    stop();
    const token = ++queueToken;
    await new Promise(r => setTimeout(r, 60)); // Chrome needs a beat after cancel()
    for (const part of chunks(text)) {
      if (token !== queueToken) return;
      await speakOne(part, token);
    }
  }

  function stop() {
    queueToken++;
    if (hasTTS) speechSynthesis.cancel();
  }

  function repeat() { return say(lastSpoken, { force: true }); }

  // ----- Microphone -----
  let active = null;

  /**
   * Listen for one phrase. onInterim(text) is called while the person is speaking.
   * Resolves with { transcript, alternatives } or null if nothing was heard.
   */
  function listen(onInterim) {
    if (!Recognition) return Promise.reject(new Error("unsupported"));
    stop(); // never listen to ourselves
    return new Promise((resolve, reject) => {
      const rec = new Recognition();
      rec.lang = "en-US";
      rec.interimResults = true;
      rec.maxAlternatives = 3;
      rec.continuous = false;
      let result = null;
      let interim = "";
      let failed = false;

      rec.onresult = e => {
        // Join every segment: Safari can split one phrase into several results.
        const text = Array.from(e.results).map(r => r[0].transcript).join(" ").replace(/\s+/g, " ").trim();
        const last = e.results[e.results.length - 1];
        if (last.isFinal) {
          result = { transcript: text, alternatives: Array.from(last).map(a => a.transcript.trim()) };
        } else {
          interim = text;
          if (onInterim) onInterim(text);
        }
      };
      rec.onerror = e => {
        if (e.error === "no-speech" || e.error === "aborted") return; // handled in onend
        failed = true;
        active = null;
        reject(new Error(e.error));
      };
      rec.onend = () => {
        active = null;
        if (failed) return;
        // Safari often ends without ever marking the result final — use what we heard.
        if (!result && interim) result = { transcript: interim, alternatives: [interim] };
        resolve(result);
      };
      active = rec;
      try {
        rec.start();
      } catch (err) {
        active = null;
        reject(new Error(err.name === "InvalidStateError" ? "busy" : "not-allowed"));
      }
    });
  }

  function cancelListening() { if (active) active.abort(); }

  return {
    say, stop, repeat, listen, cancelListening,
    get canListen() { return !!Recognition; },
    get canSpeak() { return hasTTS; },
    get rate() { return rate; },
    set rate(v) { rate = Math.min(1.3, Math.max(0.5, v)); },
    get enabled() { return enabled; },
    set enabled(v) { enabled = !!v; if (!v) stop(); },
  };
})();
