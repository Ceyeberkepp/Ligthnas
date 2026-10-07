# LightNAS Security Policy

## Development status

LightNAS is currently **pre-production software for development and early testing only**.

The current repository license does not permit production, enterprise, or commercial operational use without a separate license. See [LICENSE](LICENSE).

Even in test environments, LightNAS can interact with storage, networks, accounts, system containers, virtual machines, host services, application containers, and credentials. Security reports are taken seriously.

## Supported versions

Until LightNAS begins publishing stable supported releases, security fixes are targeted to the current `main` development line.

| Version | Security support |
| --- | --- |
| Current `main` development line | Yes |
| Older development snapshots/commits | Best effort only |
| Unofficial forks or modified distributions | No |
| Third-party applications and guest operating systems | Refer to their respective maintainers |

A fix may require updating to a newer development commit.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request containing an unpatched vulnerability or working exploit.**

Preferred reporting path:

1. Open the repository's **Security** tab.
2. Use **Report a vulnerability** / GitHub Private Vulnerability Reporting if that option is available.
3. Include the information listed below.

If private vulnerability reporting is not available, contact the repository owner or maintainers using an available private GitHub contact method. If no private method is available, you may open a minimal public issue stating only that you need a private channel for a security report. **Do not include vulnerability details in that public issue.**

## What to include

A useful report should contain:

- affected LightNAS component;
- affected commit or version;
- NAS edition, Hypervisor edition, or shared component;
- environment and operating system;
- required privileges or authentication level;
- clear reproduction steps;
- expected behavior;
- actual behavior;
- security impact;
- logs or screenshots with secrets removed;
- proof-of-concept details, if needed to validate the issue;
- any known workaround; and
- whether you believe active exploitation is occurring.

Never send real passwords, access tokens, private keys, recovery codes, production data, or unnecessary personal information.

## Vulnerabilities of particular interest

Please report issues involving:

- authentication or session bypass;
- privilege escalation;
- authorization/RBAC bypass;
- command injection;
- arbitrary host command execution;
- unsafe privileged host-agent operations;
- path traversal;
- arbitrary file read/write/delete;
- insecure file permissions;
- secret or credential exposure;
- CSRF or impactful cross-site scripting;
- SSRF with meaningful host/network impact;
- unsafe archive extraction;
- malicious image, ISO, or upload handling;
- container escape or unintended host access;
- VM isolation failures;
- noVNC or console authorization bypass;
- network/firewall configuration bypass;
- insecure update or installer behavior;
- dependency or supply-chain compromise;
- cryptographic misuse; or
- actions reported as successful when security-critical backend enforcement did not actually occur.

## Response process

For a valid private report, maintainers will aim to:

1. acknowledge the report;
2. reproduce and assess the issue;
3. determine affected components and severity;
4. develop and test a fix;
5. coordinate disclosure when appropriate; and
6. publish remediation information after users can reasonably update.

Because LightNAS is an early-stage project, fixed response-time or remediation-time guarantees are not currently offered.

## Coordinated disclosure

Please allow maintainers a reasonable opportunity to investigate and prepare a fix before public disclosure.

When appropriate, the project may:

- request a CVE or GitHub Security Advisory;
- credit the reporter if they want attribution;
- publish affected versions/commits;
- describe mitigations; and
- document the fixing commit or release.

Do not publicly disclose secrets or data obtained while testing, even after a vulnerability is fixed.

## Safe research guidelines

Good-faith security research should:

- use systems and data you own or are authorized to test;
- minimize access to data beyond what is necessary to demonstrate the problem;
- avoid persistence after testing;
- avoid disrupting services;
- avoid social engineering;
- avoid denial-of-service testing against systems you do not own;
- stop if testing could harm another person or system; and
- report findings privately.

This policy does not authorize activity that would otherwise be unlawful, violate third-party terms, or exceed the permissions granted by the LightNAS license.

## Security configuration notes

The current development build may not yet contain every control expected in a production appliance.

Follow the warnings and deployment limitations in [README.md](README.md), including network exposure and TLS guidance. Use isolated or trusted test networks, test data, and expendable workloads.

Do not use LightNAS development builds for regulated, mission-critical, or irreplaceable data.

## Third-party components

LightNAS uses and integrates third-party software. A vulnerability that exists entirely within an upstream component should normally be reported to that project's security process.

If LightNAS configures, exposes, packages, or integrates a third-party component in a way that creates a LightNAS-specific vulnerability, report it to LightNAS as described above.

## Public security improvements

General hardening changes that do not reveal an unpatched vulnerability may be submitted through the normal contribution process in [CONTRIBUTING.md](CONTRIBUTING.md).
