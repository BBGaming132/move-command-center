# Move Command Center v0.3.0 specification

## Purpose

Provide a dependable phone-first command center for a short household delivery. The system supports rapid search, destination routing, receiving confirmation, issue logging, printable room signs, backups, multiple family devices, and unreliable connectivity.

## Authentication

The application uses Firebase Email/Password Authentication behind a username-style login screen. A username is converted locally to a reserved internal email alias. The user never needs to enter or remember the alias.

There is no signup page. Accounts and move memberships are created only by the local Firebase Admin bootstrap script.

## Data confidentiality

The verified master inventory is stored in the private local setup folder and then uploaded to an authenticated Firestore document. It is excluded from Git and from the production PWA bundle. A public visitor can download only the generic app shell and login screen, not the inventory.

After an authorized first sign-in, the inventory is copied into the device's IndexedDB cache. That allows the already-authorized device to reopen and operate offline.

## Session and device behavior

- Default authentication persistence: local.
- Session lifetime: until explicit sign-out, browser-site-data clearing, or account revocation.
- First sign-in: requires internet.
- Subsequent offline opening: supported on a previously authorized and cached device.
- Device identity: random UUID stored in IndexedDB and preserved independently from the user account.
- Device name: editable from the account settings panel.

## Synchronization

Edits are append-only events. Firestore creates are allowed only when the event actor UID matches the signed-in Firebase UID and the actor username matches the active membership document. Existing events may be written again only if the document remains exactly unchanged; deletion is denied.

Offline events are retained locally and uploaded after connectivity and membership confirmation return.

## No AI dependency

No AI model, API, inference service, or external content-generation service is used. Search and routing operate entirely through deterministic local code.
