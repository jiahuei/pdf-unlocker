"""Browser-local PDF decryption, also importable for document regression tests."""

import io

from pypdf import PdfReader, PdfWriter
from pypdf.errors import PdfReadError


def unlock_pdf(input_pdf, password):
    """Return status, unlocked bytes, encryption flag and page count without retaining inputs."""
    try:
        original = bytes(input_pdf)
        reader = PdfReader(io.BytesIO(original))
        encrypted = reader.is_encrypted
        if encrypted and not reader.decrypt(password):
            return ("password", None, True, 0)
        page_count = len(reader.pages)
        if not page_count:
            return ("invalid", None, encrypted, 0)
        if not encrypted:
            return ("ok", original, False, page_count)
        # Clone the document to preserve metadata, outlines, forms and attachments.
        writer = PdfWriter(clone_from=reader)
        output = io.BytesIO()
        writer.write(output)
        return ("ok", output.getvalue(), True, page_count)
    except (PdfReadError, ValueError, TypeError, KeyError, OSError):
        return ("invalid", None, False, 0)
