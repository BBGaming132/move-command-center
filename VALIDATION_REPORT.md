# v0.3.0 validation report

Completed before packaging:

- Verified private inventory schema: 14 physical crates, 388 records, 388 unique continuous IDs.
- Verified move ID alignment across browser config, bootstrap script, and Firestore Rules.
- Verified private-data Git exclusions.
- Verified event actor rules bind writes to the authenticated UID and active member username.
- Passed TypeScript compilation.
- Passed Vite production build.
- Generated the PWA service worker and offline app shell.
- Passed the public-build privacy scan; no complete private inventory source rows were found in `dist`.
- Passed `npm audit --omit=dev` with zero production dependency vulnerabilities.
- Passed JavaScript syntax checks for bootstrap, security validation, inventory validation, and privacy validation scripts.
- Confirmed the public GitHub Actions build does not require the private inventory file.

Known validation limitation:

- A local Firestore Emulator rule-execution test could not be completed in the build environment because the emulator JAR download was unavailable. The rule file uses standard Firebase Rules constructs, but the final setup must still deploy the rules to the dedicated Firebase project and complete the authorized-user and unauthorized-user tests in `SETUP_GUIDE.md`.

Dependency note:

- The local-only Firebase Admin bootstrap dependency currently reports moderate transitive development-tool advisories involving an old UUID helper. The browser production dependency audit reports zero vulnerabilities, and the affected Admin package is used only on the trusted setup computer for one-time account and inventory provisioning.
