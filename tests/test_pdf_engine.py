"""Verify document decryption and preservation using real pypdf inputs and outputs."""

import importlib.util
import io
import unittest
from pathlib import Path

from pypdf import PdfReader
from pdf_fixtures import document_bytes

spec = importlib.util.spec_from_file_location("pdf_engine", Path(__file__).resolve().parents[1] / "src/pdf-engine.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


class PdfEngineTests(unittest.TestCase):
    """Guard real PDF content, encryption and validation behavior independently of the UI."""

    def assert_document(self, output):
        """Ensure an output is unencrypted and preserves pages, metadata, outline and attachment."""
        reader = PdfReader(io.BytesIO(output))
        self.assertFalse(reader.is_encrypted)
        self.assertEqual(len(reader.pages), 2)
        self.assertEqual(reader.pages[0].extract_text(), "First synthetic page")
        self.assertEqual(reader.pages[1].extract_text(), "Second synthetic page")
        self.assertEqual(reader.metadata.title, "Synthetic document")
        self.assertEqual(reader.outline[0].title, "First page")
        self.assertEqual(reader.attachments["note.txt"], [b"Synthetic attachment preserved."])
        return reader

    def test_rc4_password_removal(self):
        """Ensure real RC4 decryption removes encryption while preserving document contents."""
        status, output, encrypted, count = engine.unlock_pdf(document_bytes("secret"), "secret")
        self.assertEqual((status, encrypted, count), ("ok", True, 2))
        self.assert_document(output)

    def test_aes_128_password_removal(self):
        """Ensure AES-128 documents decrypt successfully with a crypto provider."""
        status, output, encrypted, count = engine.unlock_pdf(document_bytes("secret", "AES-128"), "secret")
        self.assertEqual((status, encrypted, count), ("ok", True, 2))
        self.assert_document(output)

    def test_aes_256_password_removal(self):
        """Ensure AES-256 documents decrypt successfully and retain readable pages."""
        status, output, encrypted, count = engine.unlock_pdf(document_bytes("secret", "AES-256"), "secret")
        self.assertEqual((status, encrypted, count), ("ok", True, 2))
        self.assert_document(output)

    def test_wrong_password(self):
        """Ensure incorrect passwords never return document bytes or a successful result."""
        self.assertEqual(engine.unlock_pdf(document_bytes("secret"), "wrong"), ("password", None, True, 0))

    def test_unencrypted_pdf_is_unchanged(self):
        """Ensure an unencrypted input is returned byte-for-byte without a destructive rewrite."""
        original = document_bytes()
        self.assertEqual(engine.unlock_pdf(original, "anything"), ("ok", original, False, 2))

    def test_explicit_whitespace_password(self):
        """Ensure meaningful leading and trailing spaces in passwords are not trimmed."""
        original = document_bytes("  secret  ")
        self.assertEqual(engine.unlock_pdf(original, "secret")[0], "password")
        self.assert_document(engine.unlock_pdf(original, "  secret  ")[1])

    def test_form_field_preservation(self):
        """Ensure document cloning keeps form fields and values when removing encryption."""
        output = engine.unlock_pdf(document_bytes("secret", form=True), "secret")[1]
        reader = self.assert_document(output)
        self.assertEqual(reader.get_fields()["sample"]["/V"], "Preserved value")

    def test_invalid_and_empty_documents(self):
        """Ensure invalid and empty documents report a read error rather than a password error."""
        for contents in [b"", b"not a pdf", b"%PDF-1.7\nmalformed\n%%EOF"]:
            self.assertEqual(engine.unlock_pdf(contents, "secret"), ("invalid", None, False, 0))

    def test_zero_page_document(self):
        """Ensure a document without pages cannot produce an unusable unlocked download."""
        from pypdf import PdfWriter
        output = io.BytesIO()
        PdfWriter().write(output)
        self.assertEqual(engine.unlock_pdf(output.getvalue(), "secret")[0], "invalid")


if __name__ == "__main__":
    unittest.main()
