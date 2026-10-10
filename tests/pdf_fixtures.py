"""Generate synthetic documents for encryption, content and browser regressions."""

import io
import sys
from pathlib import Path

from pypdf import PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, RectangleObject, TextStringObject


def document_bytes(password=None, algorithm="RC4-128", form=False):
    """Create two readable pages with metadata, outline and attachment; optionally encrypt."""
    writer = PdfWriter()
    font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
    resources = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
    for text, width in [("First synthetic page", 300), ("Second synthetic page", 400)]:
        page = writer.add_blank_page(width=width, height=420)
        page[NameObject("/Resources")] = resources
        content = DecodedStreamObject()
        content.set_data(f"BT /F1 16 Tf 30 320 Td ({text}) Tj ET".encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(content)
    writer.add_metadata({"/Title": "Synthetic document", "/Author": "PDF Unlocker tests"})
    writer.add_outline_item("First page", 0)
    writer.add_attachment("note.txt", b"Synthetic attachment preserved.")
    if form:
        field = DictionaryObject({NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Widget"), NameObject("/FT"): NameObject("/Tx"), NameObject("/T"): TextStringObject("sample"), NameObject("/V"): TextStringObject("Preserved value"), NameObject("/Rect"): RectangleObject([30, 30, 170, 55]), NameObject("/F"): NumberObject(4), NameObject("/DA"): TextStringObject("/F1 12 Tf 0 g")})
        reference = writer._add_object(field)
        writer.pages[0][NameObject("/Annots")] = ArrayObject([reference])
        writer._root_object[NameObject("/AcroForm")] = writer._add_object(DictionaryObject({NameObject("/Fields"): ArrayObject([reference]), NameObject("/DR"): resources, NameObject("/DA"): TextStringObject("/F1 12 Tf 0 g")}))
    if password is not None:
        writer.encrypt(password, algorithm=algorithm)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def write_fixtures(directory):
    """Write repeatable plaintext/default/whitespace/RC4/AES fixtures for browser testing."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for name, password, algorithm in [("plain.pdf", None, "RC4-128"), ("locked.pdf", "secret", "RC4-128"), ("default.pdf", "password", "RC4-128"), ("whitespace.pdf", "  secret  ", "RC4-128"), ("aes128.pdf", "secret", "AES-128"), ("aes256.pdf", "secret", "AES-256")]:
        (directory / name).write_bytes(document_bytes(password, algorithm))
    (directory / "malformed.pdf").write_bytes(b"%PDF-1.7\nThis is not a valid PDF.\n%%EOF")


if __name__ == "__main__":
    write_fixtures(sys.argv[1])
