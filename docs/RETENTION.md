# Retention and legal holds

The default retention setting is zero days for every kind. Zero means off. The application does not delete anything automatically.

A leader can set a period for comments, ledger answers, closeout artifacts, or metering receipts. The administration page then shows eligible records as proposals for human review. This release does not provide a bulk-delete button or a background deletion job. An organization decides its policy, reviews candidates, and uses the existing erasure process where it is appropriate.

A leader can place a legal hold on an item or a group. A group hold covers items restricted to that group. While a hold is active, the live application refuses erasure for covered items and retention proposals omit them. Releasing a hold requires the same fresh sign-in check and is recorded in the administration audit.

An erasure request does not override a legal hold. If the organization receives a request to erase data that is on hold, it should explain that the request is being reviewed against its legal obligations, keep only what it must keep, and release the hold when it is allowed to do so. This project does not decide whether a hold is lawful, how long it should last, or what an organization must tell someone. Backups made before an erasure can still contain old data, as described in the runbook.
