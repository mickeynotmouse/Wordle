"""Turns what a speech recogniser heard into game letters.

Handles the ways people actually say a guess out loud:
    "guess crane"            -> CRANE
    "I think it's crane"     -> CRANE
    "C R A N E" / "c-r-a-n-e"-> CRANE
    "see are a en e"         -> CRANE   (letter names written as words)
    "charlie romeo alpha november echo" -> CRANE
    "c as in cat, r, a, n, e"           -> CRANE

Kept in sync with LocalParser in frontend/assistant.js.
"""
from __future__ import annotations

import re
from typing import List, Optional

NATO = {
    "alpha": "a", "alfa": "a", "bravo": "b", "charlie": "c", "delta": "d", "echo": "e",
    "foxtrot": "f", "golf": "g", "hotel": "h", "india": "i", "juliet": "j", "juliett": "j",
    "kilo": "k", "lima": "l", "mike": "m", "november": "n", "oscar": "o", "papa": "p",
    "quebec": "q", "romeo": "r", "sierra": "s", "tango": "t", "uniform": "u", "victor": "v",
    "whiskey": "w", "whisky": "w", "xray": "x", "yankee": "y", "zulu": "z",
}

# How speech recognisers often transcribe spoken letter names.
SOUNDS = {
    "ay": "a", "eh": "a", "bee": "b", "be": "b", "see": "c", "sea": "c", "cee": "c",
    "dee": "d", "ef": "f", "eff": "f", "gee": "g", "aitch": "h", "eye": "i", "jay": "j",
    "kay": "k", "el": "l", "ell": "l", "em": "m", "en": "n", "oh": "o", "pee": "p",
    "pea": "p", "queue": "q", "cue": "q", "que": "q", "ar": "r", "are": "r", "our": "r",
    "ess": "s", "tee": "t", "tea": "t", "you": "u", "vee": "v", "ex": "x", "why": "y",
    "zed": "z", "zee": "z",
}

FILLER = set(
    "guess guessing try trying the word is my i ill i'll id i'd want to lets let's let me "
    "please how about what maybe it its it's spelled spell spelling as in enter type put going "
    "gonna say think thinking go with use answer okay ok um uh hmm so and then like".split()
)

LETTER_COMMAND_WORDS = {"letter", "letters", "add", "type", "put", "and", "the", "please", "press"}

FIVE = re.compile(r"^[a-z]{5}$")


def _normalise(text: str) -> str:
    t = text.lower()
    t = re.sub(r"double[\s-]?(u|you)\b", "w", t)
    t = re.sub(r"\bx[\s-]ray\b", "xray", t)
    t = re.sub(r"[^a-z' ]+", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    # "c as in charlie" -> "c"
    t = re.sub(r" as in [a-z]+\b", "", " " + t + " ").strip()
    return t


def _letter_of(token: str) -> Optional[str]:
    if len(token) == 1:
        return token
    return NATO.get(token) or SOUNDS.get(token)


def extract_word(text: str) -> Optional[str]:
    """Return an upper-case five-letter word found in ``text``, or None."""
    tokens = [t for t in _normalise(text).split(" ") if t]
    content = [t for t in tokens if t not in FILLER]

    # 1) A single word: "crane", "guess crane"
    if len(content) == 1 and FIVE.match(content[0]):
        return content[0].upper()

    # 2) Spelled out: "c r a n e", "charlie romeo alpha november echo", "see are a en e"
    letters = [_letter_of(t) for t in content]
    if len(letters) == 5 and all(letters):
        return "".join(letters).upper()

    # 3) Spelled, where a filler word ("i", "a") was itself one of the letters
    spelled = [t if len(t) == 1 else NATO.get(t) for t in tokens]
    spelled = [s for s in spelled if s]
    if len(spelled) == 5 and sum(1 for t in tokens if len(t) == 1) >= 4:
        return "".join(spelled).upper()

    # 4) Otherwise the last five-letter word in the sentence
    fives = [t for t in content if FIVE.match(t) and t not in NATO]
    if fives:
        return fives[-1].upper()
    return None


def extract_letters(text: str) -> List[str]:
    """Letters to add to the row: "letter b", "add charlie", "type a and n"."""
    out = []
    for t in _normalise(text).split(" "):
        if not t or t in LETTER_COMMAND_WORDS:
            continue
        letter = _letter_of(t)
        if letter:
            out.append(letter.upper())
    return out[:5]


def is_short_guess(text: str) -> bool:
    """True when the utterance is just a word or a spelled word, e.g. "nymph",
    "guess nymph", "n y m p h" — not a longer sentence that happens to contain one."""
    tokens = [t for t in _normalise(text).split(" ") if t]
    content = [t for t in tokens if t not in FILLER]
    if len(content) == 1 and FIVE.match(content[0]):
        return True
    return len(content) == 5 and all(_letter_of(t) for t in content)
