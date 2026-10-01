# LightNAS security and compliance readiness

LightNAS is designed to support secure deployments, but source code alone cannot make an installation HIPAA, SOC 2, GDPR, or other-framework compliant. Certification/readiness also depends on the operator's deployment, contracts, policies, access reviews, retention rules, incident response, backup testing, workforce practices, and evidence.

## Technical controls currently implemented

- Local passwords are stored with salted scrypt hashes.
- Session identifiers use cryptographically random values and expire after 12 hours.
- Session cookies are HttpOnly, SameSite=Strict, and gain the Secure flag when LightNAS is served through HTTPS.
- State-changing browser API calls require the LightNAS request header and cross-site requests are rejected.
- Login password checks are throttled after repeated failures.
- TOTP, SMS MFA, and WebAuthn/passkeys are supported.
- API tokens are scoped by permissions rather than receiving implicit owner access.
- The node shell and sensitive owner configuration are restricted to the appliance owner.
- VM/container/host privileged operations cross a narrow Unix-socket host-agent API instead of exposing a general root HTTP endpoint.
- Core state files and uploaded profile images are written with owner-only permissions.
- Profile uploads are size limited, MIME restricted, and checked against JPEG/PNG/WebP file signatures.
- CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Cross-Origin-Resource-Policy, and Permissions-Policy headers are emitted.
- Audit/activity records are retained with a SHA-256 hash chain. Retention count is configurable with LIGHTNAS_AUDIT_MAX_EVENTS.
- Security-sensitive settings changes and many administrative operations are recorded in activity history.
- Software updates are started through a fixed privileged host-agent action; the web application cannot supply arbitrary commands.
- Future Pro/Enterprise verification uses an HTTPS licensing endpoint plus a locally configured public key. Entitlement receipts must be cryptographically signed and bound to the appliance instance ID.
- Feature-lock enforcement remains disabled in current builds.

## Deployment controls still required

These items cannot be certified by the application itself and must be completed by the organization deploying LightNAS:

- Terminate access with trusted TLS certificates and enforce HTTPS at the reverse proxy/load balancer.
- Use encrypted disks/pools when regulated data requires encryption at rest and manage encryption keys outside normal application state.
- Define data classification, minimum-necessary access, retention, deletion, legal hold, and backup policies.
- Configure tested backups, recovery objectives, restore testing, and disaster-recovery evidence.
- Perform periodic access reviews and remove inactive users/tokens.
- Maintain incident-response, breach-notification, change-management, vulnerability-management, and business-continuity procedures.
- For HIPAA deployments, execute required BAAs and document the HIPAA risk analysis and Security Rule safeguards.
- For GDPR deployments, document lawful basis, controller/processor roles, subprocessors, retention, DSAR/export/deletion processes, and international-transfer safeguards where applicable.
- For SOC 2 readiness, collect operating evidence for access, change management, monitoring, incident handling, vendor management, backup/recovery, and periodic control reviews.

## Security work still recommended before certification

- Add signed release artifacts/SBOM verification to the update pipeline instead of relying only on repository integrity.
- Export audit events to a remote append-only/SIEM destination for stronger tamper resistance and longer retention.
- Add configurable idle session timeout and forced reauthentication for especially sensitive actions.
- Add first-class encrypted-volume/key-management workflows.
- Add automated dependency and container vulnerability scans to CI with blocking severity thresholds.
- Add privacy administration workflows for personal-data export/deletion where LightNAS itself stores regulated personal data.
- Add formal backup scheduling, restore verification reports, and immutable backup targets.
- Perform external penetration testing and independent control review before making compliance claims.

## Compliance claim policy

The UI and documentation must describe LightNAS as providing controls that support compliance readiness. Do not display "HIPAA compliant", "SOC 2 compliant", "GDPR compliant", or equivalent certification claims unless the specific deployment and organization have completed the corresponding legal, operational, and audit requirements.
