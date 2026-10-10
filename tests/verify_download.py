"""Check an actual browser download contains the synthetic unencrypted document."""

import sys
from pathlib import Path
from pypdf import PdfReader


def verify_download(path):
    """Ensure downloaded bytes preserve readable pages, metadata, outline and attachment."""
    reader = PdfReader(Path(path))
    assert not reader.is_encrypted
    assert len(reader.pages) == 2
    assert reader.pages[0].extract_text() == "First synthetic page"
    assert reader.pages[1].extract_text() == "Second synthetic page"
    assert reader.metadata.title == "Synthetic document"
    assert reader.outline[0].title == "First page"
    assert reader.attachments["note.txt"] == [b"Synthetic attachment preserved."]


if __name__ == "__main__":
    verify_download(sys.argv[1])
