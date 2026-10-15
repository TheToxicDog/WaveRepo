from wavegrab import lrc


def test_offset_multistamp_and_continuation():
    text = """[ar:Someone]
[ti:Song]
[offset:+500]
intro text without stamp
[00:01.00][00:05.00] Hello
[00:02.00]Haritsumeta yumi no
The stretching bow


[00:03.50] <00:03.50>Word <00:04.00>sync
"""
    p = lrc.parse(text)
    assert p["synced"]
    times = [l["t"] for l in p["lines"]]
    assert times == sorted(times)
    # offset +500 shifts everything 500 ms earlier
    assert times[0] == 500
    texts = [l["text"] for l in p["lines"]]
    assert texts.count("Hello") == 2
    assert "Haritsumeta yumi no\nThe stretching bow" in texts
    assert "Word sync" in texts
    word_line = [l for l in p["lines"] if l["text"] == "Word sync"][0]
    assert [w["t"] for w in word_line["words"]] == [3500, 4000]
    assert "Someone" not in p["plain"] and "intro" not in p["plain"]


def test_plain_lyrics():
    p = lrc.parse("line one\n\n\nline two\n")
    assert not p["synced"]
    assert p["plain"] == "line one\n\nline two"


def test_fraction_precision():
    p = lrc.parse("[01:02.5]a\n[01:02.05]b\n[01:02.005]c")
    assert [l["t"] for l in p["lines"]] == [62005, 62050, 62500]


def test_track_filenames_sort_in_album_order():
    from wavegrab.downloader import track_filename
    names = [track_filename(t, n) for t, n in [("Intro", 1), ("Song: Two?", 2), ("Ten", 10)]]
    assert names == ["01 Intro", "02 Song_ Two_", "10 Ten"]
    assert sorted(names) == names
    assert track_filename("A", 3, 2) == "2-03 A"
    assert track_filename("A", 3, 1, multi_disc=True) == "1-03 A"
