// Word Garden — a large-print, voice-friendly five-letter word game.

const MAX_GUESSES = 8;
const WORD_LEN = 5;
const STORE_KEY = "Wordle";

const $ = sel => document.querySelector(sel);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const STATUS_RANK = { absent: 1, present: 2, correct: 3 };
const MARK = { correct: "✓", present: "↔", absent: "✕" };
const STATUS_WORDS = {
  correct: "right letter, right spot",
  present: "in the word, wrong spot",
  absent: "not in the word",
};

const INSTRUCTIONS =
  "Here's how to play. I'm thinking of a five-letter word, and you have eight tries to guess it. " +
  "After each guess, the tiles change colour. Green with a tick means the letter is in the right spot. " +
  "Gold with arrows means the letter is in the word, but in a different spot. " +
  "Grey with a cross means the letter is not in the word. " +
  "You can type, or tap the letters on screen and then press Check word. Or tap the microphone and say a word, like: guess crane. " +
  "You can also spell it, one letter at a time. " +
  "If you get stuck, press the hint button, or say: give me a hint. " +
  "Other things you can say are: delete, clear, read my guesses, which letters have I used, give me a hint, and new game.";


const state = {
  answer: "",
  guesses: [],      // [{ word, result: ['correct'|'present'|'absent'] }]
  current: "",
  over: false,
  won: false,
  hintsUsed: [],
  pending: null,    // { type: 'guess' | 'new_game' } — awaiting yes/no
  busy: false,      // true while tiles are flipping
};

// Where the Rasa assistant lives. Running locally with start.sh (port 8000) it's
// on localhost:5005; online, it's the Cloud Run address set in config.js.
const LOCAL_RASA = "http://localhost:5005";
const IS_LOCAL = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const DEFAULT_RASA = IS_LOCAL || !window.RASA_URL ? LOCAL_RASA : window.RASA_URL;

const settings = {
  size: "size-large",
  palette: "palette-standard",
  speak: true,
  rate: 0.85,
  confirm: true,
  dict: true,
  rasa: DEFAULT_RASA,
};

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(`${STORE_KEY}:${key}`)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(`${STORE_KEY}:${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
}


// Helpers for speech-friendly text

const spell = word => word.split("").join(", ");
function listJoin(items) {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const ordinal = n => ["first", "second", "third", "fourth", "fifth"][n];


// Scoring
function score(guess, answer) {
  const result = Array(WORD_LEN).fill("absent");
  const remaining = {};
  for (let i = 0; i < WORD_LEN; i++) {
    if (guess[i] === answer[i]) result[i] = "correct";
    else remaining[answer[i]] = (remaining[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < WORD_LEN; i++) {
    if (result[i] !== "correct" && remaining[guess[i]] > 0) {
      result[i] = "present";
      remaining[guess[i]]--;
    }
  }
  return result;
}

function describeGuess(word, result) {
  const groups = { correct: [], present: [], absent: [] };
  result.forEach((s, i) => groups[s].push(word[i]));
  const parts = [];
  if (groups.correct.length === WORD_LEN) return `${spell(word)}. Every letter is right!`;
  if (groups.correct.length) {
    parts.push(`${listJoin(groups.correct)} ${groups.correct.length === 1 ? "is" : "are"} in the right spot.`);
  }
  if (groups.present.length) {
    parts.push(`${listJoin(groups.present)} ${groups.present.length === 1 ? "is" : "are"} in the word, but in a different spot.`);
  }
  if (groups.absent.length) {
    parts.push(`${listJoin([...new Set(groups.absent)])} ${groups.absent.length === 1 ? "is" : "are"} not in the word.`);
  }
  return `${spell(word)}. ` + parts.join(" ");
}

// Rendering
const boardEl = $("#board");
const keyboardEl = $("#keyboard");
const KEY_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "+ZXCVBNM-"];

function buildBoard() {
  boardEl.innerHTML = "";
  for (let r = 0; r < MAX_GUESSES; r++) {
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "row");
    for (let c = 0; c < WORD_LEN; c++) {
      const tile = document.createElement("div");
      tile.className = "tile empty";
      tile.setAttribute("role", "gridcell");
      tile.setAttribute("aria-label", "empty");
      row.appendChild(tile);
    }
    boardEl.appendChild(row);
  }
}

function buildKeyboard() {
  keyboardEl.innerHTML = "";
  for (const line of KEY_ROWS) {
    const row = document.createElement("div");
    row.className = "kb-row";
    for (const ch of line) {
      const key = document.createElement("button");
      key.className = "key";
      if (ch === "+") {
        key.textContent = "ENTER";
        key.classList.add("wide");
        key.dataset.key = "Enter";
        key.setAttribute("aria-label", "Enter guess");
      } else if (ch === "-") {
        key.textContent = "DELETE";
        key.classList.add("wide");
        key.dataset.key = "Backspace";
        key.setAttribute("aria-label", "Delete letter");
      } else {
        key.textContent = ch;
        key.dataset.key = ch;
      }
      row.appendChild(key);
    }
    keyboardEl.appendChild(row);
  }
  keyboardEl.addEventListener("click", e => {
    const key = e.target.closest(".key");
    if (key) handleKey(key.dataset.key);
  });
}

function rowEl(i) { return boardEl.children[i]; }

function renderCheckButton() {
  const btn = $("#btn-check");
  const ready = !state.over && state.current.length === WORD_LEN;
  btn.disabled = state.over;
  btn.classList.toggle("ready", ready);
  btn.innerHTML = state.over ? "Game over"
    : ready ? "Check word"
    : `Check word<small>${state.current.length} of ${WORD_LEN} letters</small>`;
}

function renderCurrentRow() {
  renderCheckButton();
  const r = state.guesses.length;
  if (r >= MAX_GUESSES) return;
  [...boardEl.children].forEach((row, i) => row.classList.toggle("current", i === r && !state.over));
  const tiles = rowEl(r).children;
  for (let c = 0; c < WORD_LEN; c++) {
    const ch = state.current[c] || "";
    tiles[c].textContent = ch;
    tiles[c].className = "tile " + (ch ? "filled" : "empty");
    tiles[c].setAttribute("aria-label", ch ? `letter ${ch}` : "empty");
  }
}

function paintRow(r, word, result, animate) {
  const tiles = rowEl(r).children;
  return Promise.all([...tiles].map(async (tile, c) => {
    if (animate && !reducedMotion) await sleep(c * 220);
    tile.className = `tile ${result[c]}` + (animate && !reducedMotion ? " reveal" : "");
    tile.innerHTML = `${word[c]}<i class="mark" aria-hidden="true">${MARK[result[c]]}</i>`;
    tile.setAttribute("aria-label", `${word[c]}, ${STATUS_WORDS[result[c]]}`);
    if (animate && !reducedMotion) await sleep(300);
  }));
}

function renderKeyboard() {
  const best = {};
  for (const { word, result } of state.guesses) {
    [...word].forEach((ch, i) => {
      if (!best[ch] || STATUS_RANK[result[i]] > STATUS_RANK[best[ch]]) best[ch] = result[i];
    });
  }
  keyboardEl.querySelectorAll(".key").forEach(key => {
    const ch = key.dataset.key;
    key.classList.remove("correct", "present", "absent");
    if (best[ch]) {
      key.classList.add(best[ch]);
      key.setAttribute("aria-label", `${ch}, ${STATUS_WORDS[best[ch]]}`);
    }
  });
  return best;
}

function renderCounter() {
  $("#btn-hint").disabled = state.over;
  const n = Math.min(state.guesses.length + 1, MAX_GUESSES);
  $("#guess-counter").textContent = state.over
    ? (state.won ? `Solved in ${plural(state.guesses.length, "guess", "guesses")}!` : "Game over")
    : `Guess ${n} of ${MAX_GUESSES}`;
}

function renderAll() {
  buildBoard();
  state.guesses.forEach((g, i) => paintRow(i, g.word, g.result, false));
  renderCurrentRow();
  renderKeyboard();
  renderCounter();
}

function shakeRow() {
  const row = rowEl(state.guesses.length);
  if (!row) return;
  row.classList.remove("shake");
  void row.offsetWidth;
  row.classList.add("shake");
}

/** Show a message on screen and (if enabled) read it aloud. */
function say(text, { speak = true } = {}) {
  $("#message").textContent = text;
  return speak ? Speech.say(text) : Promise.resolve();
}

function persist() {
  save("game", { answer: state.answer, guesses: state.guesses, hintsUsed: state.hintsUsed, over: state.over, won: state.won });
}

// Game actions
function newGame({ announce = true } = {}) {
  let answer;
  do { answer = ANSWERS[Math.floor(Math.random() * ANSWERS.length)]; } while (answer === state.answer && ANSWERS.length > 1);
  Object.assign(state, { answer, guesses: [], current: "", over: false, won: false, hintsUsed: [], pending: null });
  persist();
  renderAll();
  if (announce) say("New game! I'm thinking of a five-letter word. You have eight guesses.");
}

function typeLetter(ch) {
  if (state.over || state.busy) return;
  if (state.current.length >= WORD_LEN) {
    say("That row is full. Press Enter to check it, or Delete to change a letter.");
    return;
  }
  state.current += ch;
  state.pending = null;
  renderCurrentRow();
}

function deleteLetter() {
  if (state.over || state.busy) return;
  if (!state.current) return say("There are no letters to delete.");
  state.current = state.current.slice(0, -1);
  state.pending = null;
  renderCurrentRow();
}

function clearRow() {
  if (state.over || state.busy) return;
  state.current = "";
  state.pending = null;
  renderCurrentRow();
}

function setRow(word) {
  state.current = word.slice(0, WORD_LEN);
  renderCurrentRow();
}

//Check the current row. Returns the spoken feedback
async function submitGuess() {
  if (state.busy) return;
  state.pending = null;
  if (state.over) return say("This game is finished. Say new game, or press New game, to play again.");

  const word = state.current;
  if (word.length < WORD_LEN) {
    shakeRow();
    const need = WORD_LEN - word.length;
    return say(word.length
      ? `Not enough letters. You have ${plural(word.length, "letter", "letters")}; please add ${need} more.`
      : "Please enter a five-letter word first.");
  }
  if (state.guesses.some(g => g.word === word)) {
    shakeRow();
    return say(`You've already tried ${spell(word)}. Please try a different word.`);
  }
  if (settings.dict && !VALID_WORDS.has(word)) {
    shakeRow();
    return say(`Sorry, I don't recognise ${spell(word)} as a word. Please try another word.`);
  }

  const result = score(word, state.answer);
  const r = state.guesses.length;
  state.guesses.push({ word, result });
  state.current = "";
  state.busy = true;
  await paintRow(r, word, result, true);
  state.busy = false;
  renderKeyboard();

  const left = MAX_GUESSES - state.guesses.length;
  let text = describeGuess(word, result);

  if (word === state.answer) {
    state.over = state.won = true;
    text = `Wonderful! ${word} is the word! You solved it in ${plural(state.guesses.length, "guess", "guesses")}.`;
    showEnd("Well done!", text);
  } else if (left === 0) {
    state.over = true;
    text += ` That was your last guess. The word was ${state.answer}, spelled ${spell(state.answer)}. Good try!`;
    showEnd("Good try!", `The word was ${state.answer}.`);
  } else {
    text += ` You have ${plural(left, "guess", "guesses")} left.`;
  }
  persist();
  renderCurrentRow();
  renderCounter();
  return say(text);
}

function readBoard() {
  if (!state.guesses.length) return say("You haven't made any guesses yet. Say a five-letter word to begin.");
  const parts = state.guesses.map((g, i) => `Guess ${i + 1}: ${describeGuess(g.word, g.result)}`);
  if (state.current) parts.push(`You've typed ${spell(state.current)} so far on this row.`);
  return say(parts.join(" "));
}

function letterStatus() {
  if (!state.guesses.length) return say("You haven't used any letters yet.");
  const best = renderKeyboard();
  const placed = [];
  state.guesses.forEach(g => g.result.forEach((s, i) => {
    const item = `${g.word[i]} in the ${ordinal(i)} spot`;
    if (s === "correct" && !placed.includes(item)) placed.push(item);
  }));
  const present = Object.keys(best).filter(ch => best[ch] === "present");
  const absent = Object.keys(best).filter(ch => best[ch] === "absent").sort();
  const unused = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").filter(ch => !best[ch]);
  const parts = [];
  if (placed.length) parts.push(`Letters in the right spot: ${listJoin(placed)}.`);
  if (present.length) parts.push(`Letters in the word, but not yet placed: ${listJoin(present)}.`);
  if (absent.length) parts.push(`Letters not in the word: ${listJoin(absent)}.`);
  parts.push(`Letters you haven't tried yet: ${listJoin(unused)}.`);
  return say(parts.join(" "));
}

function guessesLeft() {
  const left = MAX_GUESSES - state.guesses.length;
  if (state.over) return say("This game is finished. Say new game to play again.");
  return say(`You've used ${plural(state.guesses.length, "guess", "guesses")}, and you have ${plural(left, "guess", "guesses")} left.`);
}

function hint() {
  if (state.over) return say("This game is finished. Say new game to play again.");
  const found = new Set();
  const placed = new Set();
  state.guesses.forEach(g => g.result.forEach((s, i) => {
    if (s !== "absent") found.add(g.word[i]);
    if (s === "correct") placed.add(i);
  }));
  // First: reveal a letter they haven't discovered at all.
  const unseen = [...new Set(state.answer)].filter(ch => !found.has(ch) && !state.hintsUsed.includes(ch));
  if (unseen.length) {
    const ch = unseen[Math.floor(Math.random() * unseen.length)];
    state.hintsUsed.push(ch);
    persist();
    return say(`Here's a hint: the word contains the letter ${ch}.`);
  }
  // Otherwise: reveal a position they haven't placed yet.
  const open = [...Array(WORD_LEN).keys()].filter(i => !placed.has(i) && !state.hintsUsed.includes(i));
  if (open.length) {
    const i = open[0];
    state.hintsUsed.push(i);
    persist();
    return say(`Here's a hint: the ${ordinal(i)} letter is ${state.answer[i]}.`);
  }
  return say("You've found every letter already! Try putting them in the right order.");
}

function giveUp() {
  if (state.over) return say(`The word was ${state.answer}.`);
  state.over = true;
  persist();
  renderCurrentRow();
  renderCounter();
  const text = `No problem. The word was ${state.answer}, spelled ${spell(state.answer)}.`;
  showEnd("The answer", `The word was ${state.answer}.`);
  return say(text);
}

function requestNewGame({ fromVoice = false } = {}) {
  const inProgress = !state.over && state.guesses.length > 0;
  if (!inProgress) return newGame();
  if (fromVoice) {
    state.pending = { type: "new_game" };
    return say("Would you like to stop this game and start a new one? Say yes or no.");
  }
  if (confirm("Start a new game? Your current game will end.")) newGame();
}

function showEnd(title, text) {
  $("#end-title").textContent = title;
  $("#end-text").textContent = text;
  setTimeout(() => { if (!$("#dlg-end").open) $("#dlg-end").showModal(); }, reducedMotion ? 0 : 900);
}

// Keyboard input
function handleKey(key) {
  if (key === "Enter") return submitGuess();
  if (key === "Backspace") return deleteLetter();
  if (/^[A-Z]$/.test(key)) return typeLetter(key);
}

document.addEventListener("keydown", e => {
  if (document.querySelector("dialog[open]")) return;
  if (e.target.matches("input, select, textarea")) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === " ") { e.preventDefault(); return toggleMic(); }
  if (e.key === "Escape") return Speech.stop();
  if (e.key === "Enter" && e.target.closest("button")) return; // let focused buttons work
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (k === "Enter" || k === "Backspace" || /^[A-Z]$/.test(k)) {
    e.preventDefault();
    handleKey(k);
  }
});

// Voice: microphone to Rasa (or built-in parser) to game command to spoken reply

const micBtn = $("#btn-mic");
let listening = false;

function setMic(on) {
  listening = on;
  micBtn.classList.toggle("listening", on);
  micBtn.setAttribute("aria-pressed", String(on));
  $("#mic-label").textContent = on ? "Listening… tap to stop" : "Tap to speak";
}

async function toggleMic() {
  if (!Speech.canListen) {
    $("#heard").textContent = `(Page address: ${location.href})`;
    return say(voiceProblem());
  }
  if (listening) { Speech.cancelListening(); return; }
  await listenOnce();
}

/** Explain why the browser isn't offering speech recognition. */
function voiceProblem() {
  if (location.protocol === "file:") {
    return "Voice input can't work when the game is opened as a file. Please start the game with start dot s h, " +
      "then open the address localhost colon 8000 in your browser.";
  }
  if (!window.isSecureContext) {
    return "Voice input only works on a secure address. Please open the game's address starting with h t t p s, " +
      "or localhost colon 8000 if you are running it on your own computer.";
  }
  if (isSafari) {
    return "Safari's speech recognition is switched off. In Safari, open Settings, then Advanced, and tick " +
      "Show features for web developers. Then open the Develop menu, choose Feature Flags, search for Speech Recognition, " +
      "and turn it on. Then reload this page. Or use Google Chrome, where voice works straight away.";
  }
  return "Sorry, voice input isn't available in this browser. Please try Google Chrome or Microsoft Edge.";
}

const isSafari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

const MIC_ERRORS = {
  "not-allowed": isSafari
    ? "Safari isn't allowing the microphone. In the Safari menu, choose Settings, then Websites, then Microphone, and set this website to Allow. Then reload the page."
    : "I need permission to use the microphone. Click the microphone icon in the address bar, choose Allow, then try again.",
  "service-not-allowed": isSafari
    ? "Safari's speech recognition is turned off. Open System Settings, then Keyboard, and turn on Dictation. Then reload the page."
    : "Speech recognition isn't allowed in this browser. Please check your browser's microphone settings.",
  "audio-capture": "I can't find a microphone. Please check that one is connected and selected in System Settings, under Sound.",
  "network": "I couldn't reach the speech recognition service. Please check your internet connection and try again.",
  "language-not-supported": "Speech recognition for English isn't available. Please check your Dictation language in System Settings.",
  "busy": "The microphone is still busy. Please wait a moment and try again.",
};

/** auto = true when we start listening by ourselves (e.g. waiting for "yes"/"no"). */
async function listenOnce({ auto = false } = {}) {
  setMic(true);
  $("#heard").textContent = "";
  let heard = null;
  try {
    heard = await Speech.listen(text => { $("#heard").textContent = `Hearing: “${text}”`; });
  } catch (err) {
    setMic(false);
    console.warn("Speech recognition error:", err.message);
    // Some browsers (Safari) only allow the microphone right after a tap.
    if (auto) return say("Tap the microphone and say yes or no, or press Enter to check the word.");
    $("#heard").textContent = `(Microphone error: ${err.message})`;
    return say(MIC_ERRORS[err.message] || "Sorry, something went wrong with the microphone. Please try again.");
  }
  setMic(false);
  if (!heard || !heard.transcript) {
    $("#heard").textContent = "";
    return say("I didn't hear anything. Tap the microphone and try again.");
  }
  $("#heard").textContent = `You said: “${heard.transcript}”`;
  await handleUtterance(heard.transcript);
}

async function handleUtterance(text) {
  const wasOnline = Assistant.online;
  const { messages } = await Assistant.interpret(text);
  if (wasOnline !== Assistant.online) refreshAssistantStatus();
  const spoken = [];
  let listenAgain = false;

  for (const m of messages) {
    if (m.custom && m.custom.command) {
      const out = await runCommand(m.custom);
      if (out && out.listenAgain) listenAgain = true;
    }
    if (m.text) spoken.push(m.text);
  }
  if (spoken.length) await say(spoken.join(" "));
  if (listenAgain && settings.confirm) await listenOnce({ auto: true });
}

/** Execute a command coming from Rasa or the built-in parser. */
async function runCommand(c) {
  switch (c.command) {
    case "guess": {
      if (state.over) { await say("This game is finished. Say new game to play again."); return; }
      const word = String(c.word || "").toUpperCase().replace(/[^A-Z]/g, "");
      if (word.length !== WORD_LEN) {
        await say(`I heard ${spell(word) || "nothing"}, which isn't five letters. Please say a five-letter word, or spell it.`);
        return;
      }
      setRow(word);
      if (settings.confirm) {
        state.pending = { type: "guess" };
        await say(`I heard ${spell(word)}. Shall I check it? Say yes or no.`);
        return { listenAgain: true };
      }
      await submitGuess();
      return;
    }
    case "letters": {
      const letters = (c.letters || []).map(l => String(l).toUpperCase()).filter(l => /^[A-Z]$/.test(l));
      letters.forEach(typeLetter);
      if (letters.length) await say(`Added ${spell(letters.join(""))}. The row now reads ${spell(state.current) || "empty"}.`);
      return;
    }
    case "affirm": {
      const p = state.pending;
      state.pending = null;
      if (p?.type === "guess") return void await submitGuess();
      if (p?.type === "new_game") return void newGame();
      if (state.current.length === WORD_LEN) return void await submitGuess();
      await say("Okay! Say a five-letter word whenever you're ready.");
      return;
    }
    case "deny": {
      const p = state.pending;
      state.pending = null;
      if (p?.type === "guess") { clearRow(); await say("Okay, let's try again. Say the word, or spell it one letter at a time."); return; }
      if (p?.type === "new_game") { await say("Okay, we'll carry on with this game."); return; }
      await say("Okay.");
      return;
    }
    case "delete": {
      if (!state.current) { await say("There are no letters to delete."); return; }
      deleteLetter();
      await say(state.current ? `Deleted. The row now reads ${spell(state.current)}.` : "Deleted. The row is now empty.");
      return;
    }
    case "clear": clearRow(); await say("I've cleared the row."); return;
    case "submit": await submitGuess(); return;
    case "new_game": await requestNewGame({ fromVoice: true }); return;
    case "help": await say(INSTRUCTIONS); return;
    case "read_board": await readBoard(); return;
    case "letter_status": await letterStatus(); return;
    case "hint": await hint(); return;
    case "guesses_left": await guessesLeft(); return;
    case "give_up": await giveUp(); return;
    case "repeat": await Speech.repeat(); return;
    case "slower": changeRate(-0.15); await say("Okay, I'll speak more slowly."); return;
    case "faster": changeRate(0.15); await say("Okay, I'll speak a little faster."); return;
    case "stop_talking": Speech.stop(); return;
    default: console.warn("Unknown command", c);
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function applySettings() {
  document.body.className = `${settings.size} ${settings.palette}`;
  Speech.enabled = settings.speak;
  Speech.rate = settings.rate;
  Assistant.url = settings.rasa;
  $("#set-size").value = settings.size;
  $("#set-palette").value = settings.palette;
  $("#set-speak").checked = settings.speak;
  $("#set-rate").value = String(settings.rate);
  $("#set-confirm").checked = settings.confirm;
  $("#set-dict").checked = settings.dict;
  $("#set-rasa").value = settings.rasa;
  save("settings", settings);
}

function changeRate(delta) {
  settings.rate = Math.round(Math.min(1.2, Math.max(0.55, settings.rate + delta)) * 100) / 100;
  // keep the dropdown meaningful if the rate moved off a preset
  const sel = $("#set-rate");
  if (![...sel.options].some(o => o.value === String(settings.rate))) {
    sel.add(new Option("Custom", String(settings.rate)));
  }
  applySettings();
}

function bindSettings() {
  $("#set-size").onchange = e => { settings.size = e.target.value; applySettings(); };
  $("#set-palette").onchange = e => { settings.palette = e.target.value; applySettings(); };
  $("#set-speak").onchange = e => { settings.speak = e.target.checked; applySettings(); };
  $("#set-rate").onchange = e => { settings.rate = parseFloat(e.target.value); applySettings(); Speech.say("This is how fast I will speak."); };
  $("#set-confirm").onchange = e => { settings.confirm = e.target.checked; applySettings(); };
  $("#set-dict").onchange = e => { settings.dict = e.target.checked; applySettings(); };
  $("#set-rasa").onchange = e => { settings.rasa = e.target.value.trim(); applySettings(); refreshAssistantStatus(); };
}

async function refreshAssistantStatus() {
  const el = $("#ai-status");
  const ok = await Assistant.checkConnection();
  el.className = "status-dot " + (ok ? "online" : "offline");
  el.textContent = ok ? "AI assistant connected" : "Basic voice mode (AI assistant offline)";
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
function init() {
  Object.assign(settings, load("settings", {}));
  // Online, a saved localhost address is never right (e.g. saved before config.js was filled in).
  if (!IS_LOCAL && (!settings.rasa || settings.rasa === LOCAL_RASA)) settings.rasa = DEFAULT_RASA;
  if (!Speech.canListen) {
    // Keep the button clickable so a tap explains what to fix.
    micBtn.classList.add("unavailable");
    $("#mic-label").textContent = "Voice is off – tap for help";
    console.warn("Voice input unavailable:", voiceProblem());
  }
  buildKeyboard();
  bindSettings();
  applySettings();

  const saved = load("game", null);
  if (saved && saved.answer && ANSWERS.includes(saved.answer)) {
    Object.assign(state, saved, { current: "", pending: null });
    renderAll();
    if (state.over) $("#message").textContent = "Your last game is finished. Press New game to play again.";
    else if (state.guesses.length) $("#message").textContent = `Welcome back! You're on guess ${state.guesses.length + 1} of ${MAX_GUESSES}.`;
  } else {
    newGame({ announce: false });
  }

  micBtn.addEventListener("click", toggleMic);
  $("#btn-repeat").addEventListener("click", () => Speech.repeat());
  $("#btn-hint").addEventListener("click", () => hint());
  $("#btn-check").addEventListener("click", () => submitGuess());
  $("#btn-new").addEventListener("click", () => requestNewGame());
  $("#btn-play-again").addEventListener("click", () => { $("#dlg-end").close(); newGame(); });
  $("#btn-help").addEventListener("click", () => $("#dlg-help").showModal());
  $("#btn-settings").addEventListener("click", () => $("#dlg-settings").showModal());
  $("#btn-read-help").addEventListener("click", () => Speech.say(INSTRUCTIONS, { force: true }));
  document.querySelectorAll("[data-close]").forEach(b =>
    b.addEventListener("click", () => { Speech.stop(); b.closest("dialog").close(); }));

  // First visit: show the rules.
  if (!load("seen-help", false)) {
    $("#dlg-help").showModal();
    save("seen-help", true);
  }

  refreshAssistantStatus();
  setInterval(() => { if (!Assistant.online) refreshAssistantStatus(); }, 15000);
}

init();
