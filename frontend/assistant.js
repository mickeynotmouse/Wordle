// Talks to the Rasa assistant. Rasa decides what the player meant ("guess crane",
// "read my guesses", "delete") and replies with a command for the game plus any
// text to read aloud. If Rasa isn't running, a small built-in parser takes over so
// voice play still works.

const Assistant = (() => {
  let baseUrl = "http://localhost:5005";
  let online = false;
  const senderId = "player-" + Math.random().toString(36).slice(2, 10);

  async function checkConnection() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(baseUrl + "/", { signal: ctrl.signal });
      clearTimeout(t);
      online = res.ok;
    } catch {
      online = false;
    }
    return online;
  }

  /** Returns a list of messages: { text } and/or { custom: { command, ... } }. */
  async function interpret(text) {
    if (online) {
      try {
        const res = await fetch(baseUrl + "/webhooks/rest/webhook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sender: senderId, message: text }),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const messages = await res.json();
        if (messages.length) return { source: "rasa", messages };
      } catch (err) {
        console.warn("Rasa unavailable, using built-in parser:", err);
        online = false;
      }
    }
    return { source: "local", messages: LocalParser.interpret(text) };
  }

  return {
    interpret, checkConnection,
    get online() { return online; },
    set url(v) { baseUrl = v.replace(/\/+$/, ""); },
  };
})();


// ---------------------------------------------------------------------------
// Built-in fallback parser (mirrors rasa/actions/word_parser.py)
// ---------------------------------------------------------------------------
const LocalParser = (() => {
  const NATO = {
    alpha: "a", alfa: "a", bravo: "b", charlie: "c", delta: "d", echo: "e", foxtrot: "f",
    golf: "g", hotel: "h", india: "i", juliet: "j", juliett: "j", kilo: "k", lima: "l",
    mike: "m", november: "n", oscar: "o", papa: "p", quebec: "q", romeo: "r", sierra: "s",
    tango: "t", uniform: "u", victor: "v", whiskey: "w", whisky: "w", xray: "x",
    yankee: "y", zulu: "z",
  };
  // How speech recognisers often write letter names.
  const SOUNDS = {
    ay: "a", eh: "a", bee: "b", be: "b", see: "c", sea: "c", cee: "c", dee: "d",
    ef: "f", eff: "f", gee: "g", aitch: "h", eye: "i", jay: "j", kay: "k", el: "l", ell: "l",
    em: "m", en: "n", oh: "o", pee: "p", pea: "p", queue: "q", cue: "q", que: "q",
    ar: "r", are: "r", our: "r", ess: "s", tee: "t", tea: "t", you: "u", vee: "v",
    ex: "x", why: "y", zed: "z", zee: "z",
  };
  const FILLER = new Set(("guess guessing try trying the word is my i ill i'll id i'd want to lets let's let me " +
    "please how about what maybe it its it's spelled spell spelling as in enter type put going gonna " +
    "say think thinking go with use answer okay ok um uh hmm so and then like").split(" "));

  function normalise(text) {
    return " " + text.toLowerCase()
      .replace(/double[\s-]?(u|you)\b/g, "w")
      .replace(/\bx[\s-]ray\b/g, "xray")
      .replace(/[^a-z' ]+/g, " ")
      .replace(/\s+/g, " ").trim() + " ";
  }

  function letterOf(tok) {
    if (tok.length === 1) return tok;
    return NATO[tok] || SOUNDS[tok] || null;
  }

  /** Pull a five-letter word out of a phrase like "guess crane" or "c r a n e". */
  function extractWord(text) {
    // "c as in charlie" -> "c"
    const cleaned = normalise(text).replace(/ as in [a-z]+ /g, " ");
    const tokens = cleaned.trim().split(" ").filter(Boolean);
    const content = tokens.filter(t => !FILLER.has(t));

    // 1) A single real word: "crane", "guess crane"
    const fives = content.filter(t => /^[a-z]{5}$/.test(t) && !NATO[t]);
    if (content.length === 1 && /^[a-z]{5}$/.test(content[0])) return content[0].toUpperCase();

    // 2) Spelled out: "c r a n e", "charlie romeo alpha november echo"
    const letters = content.map(letterOf);
    if (letters.length === 5 && letters.every(Boolean)) return letters.join("").toUpperCase();

    // 3) Spelled with filler kept (e.g. "c r a n e please" with an unknown word dropped)
    const spelled = tokens.map(t => (t.length === 1 ? t : NATO[t] || null)).filter(Boolean);
    if (spelled.length === 5 && tokens.filter(t => t.length === 1).length >= 4) return spelled.join("").toUpperCase();

    if (fives.length) return fives[fives.length - 1].toUpperCase();
    return null;
  }

  /** Letters to add: "letter b", "add charlie", "type a and n". */
  function extractLetters(text) {
    const tokens = normalise(text).replace(/ as in [a-z]+ /g, " ").trim().split(" ");
    const out = [];
    for (const t of tokens) {
      if (["letter", "letters", "add", "type", "put", "and", "the", "please", "press"].includes(t)) continue;
      const l = letterOf(t);
      if (l) out.push(l.toUpperCase());
    }
    return out.slice(0, 5);
  }

  const cmd = (command, extra = {}) => ({ custom: { command, ...extra } });

  const RULES = [
    // An explicit "guess ..." always wins, so words like "clear" or "quiet" can be guessed.
    [/^(guess|try|my guess is|the word is|is it)\b/, t => {
      const word = extractWord(t);
      return word ? [cmd("guess", { word })] : null;
    }],
    [/^(yes|yeah|yep|yup|correct|right|sure|ok(ay)?|do it|go ahead|that'?s (right|it|correct)|submit it)\b/, () => [cmd("affirm")]],
    [/^(no|nope|nah|wrong|that'?s wrong|not (that|right)|cancel)\b/, () => [cmd("deny")]],
    [/\b(help|how (do|to) (i )?play|instructions|rules|what do i do)\b/, () => [cmd("help")]],
    [/\b(read|tell me|what (are|were)|go over|review)\b.*\b(guess(es)?|board|so far|tried)\b|\bwhat have i (guessed|tried)\b/, () => [cmd("read_board")]],
    [/\b(which|what) letters\b|\bletters (left|used|remaining)\b|\bkeyboard\b/, () => [cmd("letter_status")]],
    [/\b(hint|clue|help me out|i'?m stuck)\b/, () => [cmd("hint")]],
    [/\bhow many\b.*\b(guess(es)?|tries|turns)\b|\b(guesses|tries) left\b/, () => [cmd("guesses_left")]],
    [/\b(new|another|next|fresh) (game|word|puzzle)\b|\bstart (over|again)\b|\bplay again\b/, () => [cmd("new_game")]],
    [/\b(give up|i give up|show (me )?the answer|what was the word|tell me the answer)\b/, () => [cmd("give_up")]],
    [/\b(clear|erase|wipe)\b|\bstart the row\b/, () => [cmd("clear")]],
    [/\b(delete|backspace|back space|remove|undo|take (that|it) back|go back)\b/, () => [cmd("delete")]],
    [/^(enter|submit|send|done|check( it)?|that'?s my guess|go)$/, () => [cmd("submit")]],
    [/\b(repeat|say (that|it) again|again please|pardon|what did you say|come again)\b/, () => [cmd("repeat")]],
    [/\b(slower|slow down|too fast)\b/, () => [cmd("slower")]],
    [/\b(faster|speed up|too slow)\b/, () => [cmd("faster")]],
    [/\b(stop talking|be quiet|hush|stop|silence)\b/, () => [cmd("stop_talking")]],
    [/^(hi|hello|hey|good (morning|afternoon|evening))\b/, () => [{ text: "Hello! Say a five-letter word whenever you're ready, or say help to hear the rules." }]],
    [/\b(thank(s| you))\b/, () => [{ text: "You're very welcome." }]],
    [/^(letter|add|type|put|press)\b/, t => {
      const letters = extractLetters(t);
      return letters.length ? [cmd("letters", { letters })] : null;
    }],
  ];

  function interpret(text) {
    const t = text.toLowerCase().trim();
    for (const [re, fn] of RULES) {
      if (re.test(t)) {
        const out = fn(t);
        if (out) return out;
      }
    }
    const word = extractWord(text);
    if (word && word.length === 5) return [cmd("guess", { word })];
    return [{ text: "Sorry, I didn't catch a five-letter word. You can say the word, or spell it one letter at a time." }];
  }

  return { interpret, extractWord, extractLetters };
})();
