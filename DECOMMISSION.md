# Decommission after the move

Complete these steps only after exporting and preserving the final backup.

1. In the account settings on each phone, choose `Sign out and clear this device's local move data`.
2. Remove the Home Screen PWA from each phone.
3. Clear the GitHub Pages deployment or disable Pages in the repository settings.
4. Disable or delete the three Firebase Authentication users.
5. Delete the dedicated Firebase project if no longer needed. This removes the private inventory, memberships, and event records.
6. Delete any local service-account JSON and `users.local.json` files.
7. Archive or delete the GitHub repository.
8. Securely retain only the final backup and any records the family actually needs.

Deleting only the GitHub site does not delete Firestore. Deleting only Firebase does not remove a cached copy from previously authorized phones. Complete both sides.
