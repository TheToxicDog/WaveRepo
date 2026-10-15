"""Resilient .lrc parser.

Handles the real-world cases described in the research report:
  * header tags ([ar:], [ti:], [la:] ...) are dropped, except [offset:+/-ms]
  * multi-timestamp lines ([01:00.00][02:15.00] Chorus) are unrolled
  * un-timestamped lines continue the previous timestamped line(s)
  * preamble before the first timestamp and trailing blanks are stripped
  * runs of blank lines are collapsed to one
  * inline word timings (<00:01.20> or [00:01.20] mid-line) are kept in
    `words` and stripped from the text
"""
import re

TIME_TAG = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
WORD_TAG = re.compile(r"<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>")
META_TAG = re.compile(r"^\[([a-zA-Z#]+):(.*)\]\s*$")


def _ms(m, s, frac):
    frac = frac or "0"
    # ".5" = 500ms, ".05" = 50ms, ".005" = 5ms
    frac_ms = int(frac.ljust(3, "0")[:3])
    return (int(m) * 60 + int(s)) * 1000 + frac_ms


def parse(text: str) -> dict:
    """Return {"synced": bool, "lines": [{"t": ms, "text": str, "words": [...]}], "plain": str}."""
    if not text:
        return {"synced": False, "lines": [], "plain": ""}
    text = text.lstrip("﻿")
    offset = 0
    entries = []          # (timestamps[], text_parts[], words[])
    plain_only = []
    for raw in text.splitlines():
        line = raw.rstrip()
        meta = META_TAG.match(line.strip())
        if meta and not TIME_TAG.match(line.strip()):
            if meta.group(1).lower() == "offset":
                try:
                    offset = int(meta.group(2).strip())
                except ValueError:
                    pass
            continue
        stamps = []
        rest = line.strip()
        while True:
            m = TIME_TAG.match(rest)
            if not m:
                break
            stamps.append(_ms(*m.groups()))
            rest = rest[m.end():]
        if stamps:
            words = _split_words(rest) if WORD_TAG.search(rest) else []
            clean = TIME_TAG.sub("", WORD_TAG.sub("", rest)).strip()
            entries.append([stamps, [clean], words])
        elif entries:
            # continuation (or blank line) attaches to previous timestamp(s)
            entries[-1][1].append(rest)
        else:
            plain_only.append(rest)

    if not entries:
        lines = _collapse_blank([l for l in plain_only])
        plain = "\n".join(lines).strip()
        return {"synced": False, "lines": [{"t": None, "text": l, "words": []} for l in plain.splitlines()],
                "plain": plain}

    out = []
    for stamps, parts, words in entries:
        # trailing blank continuation lines become a single blank marker
        while len(parts) > 1 and not parts[-1]:
            parts.pop()
        body = "\n".join(_collapse_blank(parts))
        for t in stamps:
            # LRC [offset:+500] means lyrics appear 500ms earlier
            out.append({"t": max(0, t - offset), "text": body, "words": words})
    out.sort(key=lambda e: e["t"])
    # strip trailing empty entries
    while out and not out[-1]["text"]:
        out.pop()
    plain = "\n".join(e["text"] for e in out if e["text"])
    return {"synced": True, "lines": out, "plain": plain}


def _split_words(rest: str):
    """Split '<00:01.00>Hello <00:01.50>world' into timed words."""
    words = []
    parts = re.split(r"(<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>)", rest)
    t = None
    for p in parts:
        m = WORD_TAG.fullmatch(p)
        if m:
            t = _ms(*m.groups())
        elif p.strip() and t is not None:
            words.append({"t": t, "w": p})
    return words


def _collapse_blank(lines):
    out = []
    for l in lines:
        if not l and out and not out[-1]:
            continue
        out.append(l)
    while out and not out[0]:
        out.pop(0)
    return out
