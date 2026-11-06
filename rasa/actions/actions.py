"""Custom actions for the Word Garden voice assistant.

The browser owns the game (board, answer, scoring). Rasa's job is to understand
what the player said and hand back a command. Commands are sent as custom JSON
payloads, which the REST channel delivers as {"custom": {...}}.
"""
from typing import Any, Dict, List, Text

from rasa_sdk import Action, Tracker
from rasa_sdk.executor import CollectingDispatcher

from .word_parser import extract_letters, extract_word, is_short_guess


class ActionParseGuess(Action):
    """'guess crane', 'c r a n e', 'is it toast' -> {"command": "guess", "word": "CRANE"}"""

    def name(self) -> Text:
        return "action_parse_guess"

    def run(self, dispatcher: CollectingDispatcher, tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        text = tracker.latest_message.get("text", "")
        word = extract_word(text)

        if not word:
            # Fall back to the entity the NLU model found, if it looks like a word.
            entity = next(tracker.get_latest_entity_values("word"), None)
            if entity and len(entity.strip()) == 5 and entity.strip().isalpha():
                word = entity.strip().upper()

        if word:
            dispatcher.utter_message(json_message={"command": "guess", "word": word})
        else:
            dispatcher.utter_message(response="utter_no_word")
        return []


class ActionParseLetters(Action):
    """'letter b', 'add charlie', 'type a and n' -> {"command": "letters", "letters": [...]}"""

    def name(self) -> Text:
        return "action_parse_letters"

    def run(self, dispatcher: CollectingDispatcher, tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        letters = extract_letters(tracker.latest_message.get("text", ""))
        if not letters:
            letters = [e.upper() for e in tracker.get_latest_entity_values("letter")
                       if len(e) == 1 and e.isalpha()]

        if letters:
            dispatcher.utter_message(json_message={"command": "letters", "letters": letters})
        else:
            dispatcher.utter_message(response="utter_no_letter")
        return []


class ActionFallbackGuess(Action):
    """Low-confidence turn. If the player said a lone five-letter word (one the
    model hasn't seen before, like "nymph"), treat it as a guess; otherwise ask
    them to rephrase. The game asks for confirmation, so a wrong guess is cheap."""

    def name(self) -> Text:
        return "action_fallback_guess"

    def run(self, dispatcher: CollectingDispatcher, tracker: Tracker,
            domain: Dict[Text, Any]) -> List[Dict[Text, Any]]:
        text = tracker.latest_message.get("text", "")
        word = extract_word(text) if is_short_guess(text) else None
        if word:
            dispatcher.utter_message(json_message={"command": "guess", "word": word})
        else:
            dispatcher.utter_message(response="utter_please_rephrase")
        return []
