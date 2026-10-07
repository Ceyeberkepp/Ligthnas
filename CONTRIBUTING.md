# Contributing to LightNAS

Thank you for helping improve LightNAS.

LightNAS is currently pre-production software for development and early testing. The current source is **not open source** and is distributed under the **LightNAS Development and Community Evaluation License**. Read [LICENSE](LICENSE) before using, modifying, or contributing code.

A contribution to LightNAS does not grant production, enterprise, commercial, hosting, redistribution, or other rights beyond those provided by the license.

## Before you contribute

Please review:

- [README.md](README.md) for the current product state and architecture;
- [LICENSE](LICENSE) for permitted use and contribution terms;
- [SECURITY.md](SECURITY.md) for vulnerability reporting;
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations;
- [docs/PLATFORM-REQUIREMENTS.md](docs/PLATFORM-REQUIREMENTS.md) for platform targets; and
- [docs/BUILD-VALIDATION.md](docs/BUILD-VALIDATION.md) for validation requirements.

## What we welcome

Useful contributions include:

- bug fixes;
- performance improvements;
- accessibility and mobile UX improvements;
- tests and test coverage;
- documentation;
- storage and filesystem reliability work;
- networking and firewall improvements;
- LXC/system-container functionality;
- QEMU/KVM/libvirt VM functionality;
- noVNC and guest-console improvements;
- App Store and OCI application improvements;
- installer and ISO improvements;
- security hardening; and
- hardware and architecture compatibility fixes.

Large changes should begin with an issue or design discussion before substantial implementation work.

## Do not submit

Do not submit:

- secrets, passwords, tokens, certificates, private keys, or production data;
- proprietary, closed-source, source-available-only, evaluation-only, noncommercial-only, or otherwise non-open-source code, libraries, snippets, SDKs, components, or dependencies;
- copied code you do not have the right to contribute;
- code with incompatible licensing;
- malware, backdoors, credential harvesting, or hidden remote access;
- changes that falsely report an operation as successful when the requested VM, container, application, storage, or network change did not actually occur;
- placeholder or simulated infrastructure behavior presented as real functionality; or
- vulnerability details that should be handled privately under [SECURITY.md](SECURITY.md).

## Development setup

LightNAS currently requires Node.js 22 or newer for the control plane.

Clone your permitted development copy and install dependencies as required by the repository:

```bash
git clone https://github.com/Ceyeberkepp/Ligthnas.git
cd Ligthnas
npm install
npm test
npm start
```

Open the local development interface at:

```text
http://127.0.0.1:3080
```

For LAN testing:

```bash
NAS_HOST=0.0.0.0 npm start
```

Do not expose a development instance directly to the public Internet.

## Branch and pull request workflow

1. Synchronize with the current `main` branch.
2. Create a focused branch for one logical change.
3. Make the smallest complete change that solves the problem.
4. Add or update tests.
5. Run the relevant validation locally.
6. Update documentation when behavior, configuration, installation, security, or UI changes.
7. Commit with a clear message.
8. Open a pull request against `main`.

A fork or temporary copy used only as reasonably necessary to prepare and submit a contribution is subject to the repository [LICENSE](LICENSE), including its redistribution restrictions.

## Pull request requirements

A good pull request should explain:

- what problem is being solved;
- why the change is needed;
- what behavior changed;
- how it was tested;
- any security implications;
- any migration or compatibility impact;
- whether NAS edition, Hypervisor edition, or shared code is affected; and
- screenshots or recordings for meaningful UI changes.

Keep unrelated cleanup out of feature or bug-fix pull requests unless it is required for the change.

## Required validation

At minimum, run:

```bash
npm test
```

Also run any repository validation relevant to the files you changed.

Changes must not weaken platform-contract checks simply to make CI pass. If a requirement itself needs to change, explain the requirement change explicitly in the pull request.

## Infrastructure behavior must be real

LightNAS manages infrastructure. UI state must reflect actual backend state.

For operations such as creating a VM, creating a system container, installing an application, changing networking, modifying storage, or starting a service:

- do not show success before the backend operation succeeds;
- return actionable errors when the backend fails;
- verify the created resource exists where practical;
- surface job/progress state for long-running operations;
- do not silently replace a real operation with mock data; and
- preserve logs needed for troubleshooting.

## UI contributions

LightNAS aims for a modern, simple, efficient interface.

UI changes should:

- work on desktop, tablet, and mobile where applicable;
- support light, dark, and system appearance where the affected component uses them;
- avoid unnecessary visual clutter;
- keep interactions responsive;
- avoid requiring manual refreshes for data that should update automatically;
- provide loading, empty, error, and success states;
- preserve keyboard accessibility where practical; and
- avoid hiding backend failures behind optimistic UI.

## Security contributions

Security fixes are welcome, but do not disclose an unpatched vulnerability in a public pull request before coordinating disclosure.

Start with [SECURITY.md](SECURITY.md).

Security-sensitive code should favor:

- least privilege;
- narrow host-agent operations;
- input validation;
- authorization checks;
- secure session handling;
- secret protection;
- safe file permissions;
- explicit network exposure; and
- auditable actions.

## Open-source contribution requirement

**Every line of code written or submitted by a contributor for LightNAS must be open source. There are no exceptions.**

By contributing code to LightNAS, the contributor must ensure that the contribution is released under a recognized open-source license that permits source-code access, modification, redistribution, and use consistent with accepted open-source principles.

This requirement applies to all contributor-authored or contributor-submitted code, including:

- new features;
- bug fixes;
- frontend code;
- backend code;
- APIs;
- scripts;
- installers;
- build tooling;
- tests;
- drivers;
- integrations;
- application recipes;
- container definitions;
- infrastructure code;
- copied or adapted snippets;
- libraries and packages;
- SDKs and frameworks;
- helper utilities; and
- any other code intended to become part of LightNAS.

The following are **not permitted** in contributor submissions:

- proprietary code;
- closed-source code;
- source-available-only code that is not open source;
- evaluation-only code;
- noncommercial-only code;
- code whose source is unavailable;
- code with licensing terms that prohibit normal open-source modification or redistribution;
- code copied from a source that the contributor does not have the legal right to use; or
- code with licensing terms incompatible with LightNAS.

There is **no maintainer exception, private exception, commercial exception, or one-off exception** to this rule for contributor code.

Contributor code must remain attributable to its original author and must carry or preserve any required license and copyright notices.

When contributing third-party open-source code, the pull request must identify:

- the project or component name;
- the upstream source repository;
- the version or commit used;
- the open-source license;
- whether the code is bundled, linked, executed externally, or used only during development; and
- any attribution or notice requirements.

If the license cannot be clearly verified as open source and compatible, the code must not be submitted.

This contributor requirement is separate from the current LightNAS project distribution license. Contributor-submitted code itself must satisfy this open-source requirement even while LightNAS as a whole is distributed under the license stated in [LICENSE](LICENSE).

## Dependencies

New dependencies should have a clear need and must satisfy the open-source contribution requirement above.

Before adding one, consider:

- maintenance activity;
- security history;
- whether the source repository is publicly available;
- whether it uses a recognized open-source license;
- license compatibility;
- attribution or notice requirements;
- package size;
- runtime overhead;
- platform support; and
- whether the same result can be achieved safely with existing dependencies or platform tools.

Do not add a dependency with a proprietary, closed-source, source-available-only, evaluation-only, noncommercial-only, or otherwise non-open-source license.

There are no exceptions to the open-source requirement for contributor-added dependencies.

Do not add any dependency with a license that conflicts with LightNAS distribution or intended use.

## Commit guidance

Use short, descriptive commit messages, for example:

```text
fix vm creation storage validation
add mobile media upload progress
harden host-agent network validation
document lxc troubleshooting workflow
```

## Contribution licensing

By submitting a contribution, you agree to the contribution terms in Section 8 of [LICENSE](LICENSE).

Unless a separate contributor agreement applies, you represent that you have the right to submit the contribution and grant the Licensor the rights described in that section.

## Review and acceptance

A submitted contribution is not guaranteed to be merged.

Maintainers may request changes for architecture, testing, security, licensing, maintainability, product direction, performance, compatibility, or release-readiness reasons.

By participating, you also agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
