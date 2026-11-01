# Changelog

All notable changes to resma are written here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [v0.1.0] - 2026-11-01

First release.

### Added

- **Unir PDF** (`/unir-pdf/`): merges two or more PDF files into one, in the order you choose with the «Subir» and «Bajar» buttons, and downloads the result.
- **JPG a PDF** (`/jpg-a-pdf/`): converts JPG and PNG images into a single PDF, with page size (A4, Letter or fitted to the image), orientation and margin options. Location and camera data of JPG photos are not copied into the PDF.
- Per-file error messages that say what to do: password-protected PDF, damaged file or wrong file type. If the button is pressed with a wrong file in the list, a notice sums up how many must be removed.
- Privacy by design: your files are never uploaded anywhere. All the work happens in your browser, inside a background worker; the tool keeps working offline once the page has loaded. The site uses no cookies and stores nothing on your device. The only server-side record is the technical access log of the provider that serves the pages, described on the privacy page.
- Accessibility: designed for WCAG 2.2 level AA. The automated checks find no violations on any page or state of the two tools, in light and dark themes. Both tools work with the keyboard and with a screen reader; results are announced as status messages and focus returns to a useful control after each action. The `/accesibilidad/` page explains the scope and how to report a problem.
- Spanish interface for Spain and Mexico, light and dark themes following the system, and a layout for phones and desktops.
- Home page, «Cómo funciona» and the legal pages: legal notice, privacy, cookies, terms, accessibility and licences.
- Static build (`python -I tools/build.py`) with per-page size limits and a content security policy in the `_headers` file it generates.
- Brand package: icons, web manifest, social image and README header.
- `SECURITY.md` with the contact address and the scope, and this changelog.

### Known limits

- **iPhone and iPad**: iOS Safari was tested only through emulation in a desktop browser, not on a real device. Failures that show only on iOS (memory, file picker, download) may appear.
- **Very large files, or many at once**: the limit is your device's memory. On a phone, a set of about 100 MB of PNG images completed in tests on an Android phone with 11 GB of memory; phones with less memory were not tested. Above about 100 MB the tool warns that it may take long or fail.
- **PNG images over 16 megapixels**: reduce them before use.
- **Formats**: «JPG a PDF» accepts JPG and PNG. On Android, the system picker shows other formats (for example HEIC) as unavailable.
- **Password-protected PDFs**: they cannot be merged; the tool explains how to save them without a password and choose them again.
- **When merging PDFs**: some PDFs may lose bookmarks, and fillable forms are flattened (still visible, no longer editable). The result keeps whatever active content the source files had: the tool joins files, it does not clean them.
- **PDF accessibility**: resma does not make the PDFs you merge or create accessible, and converted images carry no alternative text.
- **Legal texts**: published as drafts, without review by a lawyer or an adviser.
- **Keyboard and screen reader on desktop**: the keyboard-only pass was done in Chrome on desktop (dark theme); the pass with NVDA in Firefox, and the keyboard pass in Firefox, are pending at the date of this version. TalkBack was checked on a real Android phone.

