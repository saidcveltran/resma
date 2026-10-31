# Security policy

## Reporting a vulnerability

Write to **resma@aiskaron.com**. Please include the page or file involved, the steps to reproduce, and what you expected to happen. If the report involves a crafted PDF or image, attach it or say how to make it.

Please do not open a public issue for a vulnerability until it has been fixed. resma is a personal project, so replies are on a best-effort basis; no response time is promised.

## Scope

In scope:

- The site's own code in this repository: the pages, the scripts that run in the browser and the web worker that reads and writes PDF files.
- The handling of hostile input: PDF and image files that make the tools hang, run out of memory, read or write something they should not, or produce a PDF that does not match what the user chose.
- Anything that makes a user's files leave their device, or makes the site store something on it.
- The security headers the build writes to `dist/_headers` (content security policy and related headers).
- The build and its dependencies: `package-lock.json`, the pinned `@cantoo/pdf-lib` and the vendored copy of it.

Out of scope:

- Weaknesses in the services that host or deliver the site (the hosting platform, the DNS provider, GitHub). Report those to the provider.
- Vulnerabilities in a dependency that are already public and have no effect on resma; a report that shows the effect is welcome.
- Attacks that need control of the visitor's device or browser, and bugs in a browser itself.
- Spam, social engineering and denial of service by traffic volume against the host.

## Supported versions

Only the latest release is supported.
