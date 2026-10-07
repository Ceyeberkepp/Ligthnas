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
- proprietary, closed-source, source-available-only, or otherwise non-open-source third-party code, libraries, snippets, SDKs, components, or dependencies unless the LightNAS maintainer has given an explicit written exception;
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

## Open-source code requirement

Any third-party code used in or added to LightNAS must be open source unless the LightNAS maintainer gives an explicit written exception.

This requirement applies to:

- libraries and packages;
- copied or adapted code snippets;
- SDKs and frameworks;
- frontend and backend components;
- system utilities bundled or redistributed with LightNAS;
- container/application recipes;
- build tools that become part of the distributed product;
- drivers or helper components included with a LightNAS build; and
- other third-party source code incorporated into the repository or distributed product.

Contributors must verify that the source code is publicly available under a recognized open-source license and that its license is compatible with how LightNAS uses and distributes it.

Code that is merely "source available" but does not provide open-source rights is **not considered open source for this requirement**.

Do not add proprietary, closed-source, evaluation-only, noncommercial-only, or otherwise restricted third-party code to LightNAS unless the maintainer has explicitly reviewed and approved that exception in writing.

The fact that LightNAS itself is currently distributed under the LightNAS Development and Community Evaluation License does not remove this requirement for third-party code used by the project.

When adding third-party code, the pull request should identify:

- the project or component name;
- the upstream source/repository;
- the version or commit used;
- the open-source license;
- whether the code is bundled, linked, executed externally, or used only during development; and
- any attribution or notice requirements.

If the license is unclear, do not add the code until it has been reviewed.

## Dependencies

New dependencies should have a clear need and must satisfy the open-source code requirement above.

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

Do not add a dependency with a proprietary, closed-source, source-available-only, evaluation-only, noncommercial-only, or otherwise incompatible license unless an explicit written maintainer exception has been granted.

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
