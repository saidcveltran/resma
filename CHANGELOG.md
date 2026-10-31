# Changelog

All notable changes to resma are written here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [v0.1.0] - not yet released

The first release. The date is set when the tag is created.

### Added

- **Unir PDF** (`/unir-pdf/`): merge two or more PDF files into one, reorder them with the Subir and Bajar buttons, and download the result.
- **JPG a PDF** (`/jpg-a-pdf/`): turn JPG and PNG images into one PDF, with page size (A4, Letter or fit to the image), orientation and margin options. Location and camera data in JPG files are not copied into the PDF.
- Clear per-file errors for password-protected, damaged and wrong-type files, with a summary alert when the action is pressed with a bad file in the list.
- A privacy design with no uploads: all work happens in a web worker in the browser, and the site sets no cookies and stores nothing on the device.
- Spanish interface for Spain and Mexico, light and dark themes that follow the system, and a layout for phones and desktops.
- Home page, "Como funciona" page, and the legal, privacy, cookies, terms, accessibility and licences pages.
- A static build (`python -I tools/build.py`) with per-page size budgets and a content security policy in the `_headers` file it writes.
- Brand package copies: favicon set, web manifest, Open Graph image and the README header.
- `SECURITY.md` with the contact address and scope, and this changelog.

