from __future__ import annotations

import pytest


def test_restore_srt_structure_preserves_numbers_and_timestamps(app_module):
    source = """1
00:56:33,974 --> 00:56:35,183
...fondue?

2
00:56:36,143 --> 00:56:38,395
This is your transponder.
Activate it when you're ready"""

    translated = """99
00:56:33,974 --> 01:56:35,183
...fondue?

100
02:00:00,000 --> 02:00:01,000
Este es tu transpondedor.
Actívalo cuando estés listo"""

    repaired = app_module.restore_srt_structure(source, translated)

    assert repaired == """1
00:56:33,974 --> 00:56:35,183
...fondue?

2
00:56:36,143 --> 00:56:38,395
Este es tu transpondedor.
Actívalo cuando estés listo"""


def test_restore_srt_structure_rejects_changed_block_count(app_module):
    source = """1
00:00:01,000 --> 00:00:02,000
One

2
00:00:03,000 --> 00:00:04,000
Two"""

    translated = """1
00:00:01,000 --> 00:00:02,000
Uno"""

    with pytest.raises(ValueError, match="block count changed"):
        app_module.restore_srt_structure(source, translated)

