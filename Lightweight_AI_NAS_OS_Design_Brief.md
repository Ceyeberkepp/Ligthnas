# Lightweight AI NAS OS — Product and Technical Design Brief

**Document status:** Vision and product-definition draft  
**Working title:** Lightweight AI NAS OS  
**Product category:** Self-hosted NAS, private cloud, application platform, virtualization host, and AI-assisted infrastructure appliance  
**Primary audiences:** Home users, creators, small businesses, IT administrators, labs, schools, and edge deployments

## 1. Executive vision

Create a lightweight, secure, modern NAS operating system that makes storage, applications, containers, virtual machines, identity, backup, and AI management feel like one coherent product.

The experience should combine the approachability of Synology DSM with the flexibility of Proxmox, Docker, TrueNAS, and a private AI platform—without requiring users to understand Linux administration before they can safely operate it.

The product must install on a broad range of x86 hardware, remain useful with as little as 2 GB of RAM, scale upward to modern multi-core servers with GPUs, and offer a responsive interface on phones, tablets, and desktop browsers.

The product promise is:

> Turn almost any compatible computer into a secure, intelligent private cloud in minutes.

## 2. Product principles

1. **Simple by default, powerful when needed.** Common tasks use guided workflows; expert controls remain available behind an Advanced view.
2. **One system, multiple hardware tiers.** The core NAS runs on low-resource hardware. Advanced capabilities activate only when hardware requirements are met.
3. **Local-first and private.** Core storage and administration work without a cloud account. AI can be local, remote, or disabled.
4. **No dead ends.** Every screen should explain what happened, what is required, and how to recover.
5. **Safe automation.** AI may diagnose and propose changes, but destructive or security-sensitive actions require explicit approval.
6. **Responsive everywhere.** The complete administration experience works on desktop, tablet, and mobile.
7. **Predictable performance.** Background work is resource-aware and must not make file access or the interface feel slow.
8. **Open integration.** Use documented APIs, standard protocols, exportable configurations, and portable application formats.

## 3. Reality-based hardware promise

Hardware sold between 2000 and 2026 spans incompatible CPU architectures, boot methods, instruction sets, device drivers, and virtualization capabilities. A single full-featured image cannot safely deliver every feature on every machine in that range.

The product should therefore use capability-based editions while maintaining one visual experience and one management model.

| Hardware tier | Suggested baseline | Intended capabilities |
| --- | --- | --- |
| Legacy Node | Older x86/x86-64 hardware, 2 GB RAM, no required virtualization extensions | SMB/NFS file sharing, users, basic software RAID where supported, SMART monitoring, scheduled backup, lightweight web UI, remote management node |
| Core NAS | 64-bit CPU, 2–4 GB RAM, 1–4 drives | Full file services, snapshots where supported, apps with strict memory limits, remote AI connection, backup, sync, media indexing |
| Plus | 64-bit multi-core CPU, 8 GB RAM, VT-x/AMD-V | Containers, multiple applications, one or more small VMs, richer indexing, optional directory services |
| AI/Enterprise | Modern 64-bit CPU, 16+ GB RAM, optional supported GPU/NPU | Local AI models, semantic search, multiple VMs, advanced observability, replication, clustering, high-performance storage |

**Non-negotiable product truth:** 2 GB RAM is the minimum for the core NAS experience, not a promise to run local generative AI, multiple containers, ZFS deduplication, or virtual machines. On constrained systems, AI runs through a user-selected remote provider or another AI-capable node on the local network.

For true early-2000s equipment, a separately maintained Legacy image may be required. It should be positioned as a limited compatibility edition because old processors, firmware, and network adapters may no longer receive safe upstream support.

## 4. Target user journeys

### First boot and setup

1. User boots from USB or an installer image.
2. The system detects CPU, RAM, storage controllers, disks, network adapters, virtualization support, and accelerators.
3. A local setup page appears automatically and displays the device name and secure connection instructions.
4. User selects language, time zone, keyboard, device name, administrator account, MFA/passkey, network configuration, and update policy.
5. A storage wizard recommends a layout based on available disks and explains capacity, redundancy, and failure tolerance in plain language.
6. The system completes setup, runs a health check, and opens the dashboard.

The installer must never silently erase a disk. Every destructive storage action must show the exact devices, their sizes, existing data signatures, and the resulting layout before confirmation.

### Everyday administration

- Create shared folders and assign access using a single guided workflow.
- Add a user locally, import users through LDAP, or join an existing directory.
- Install a trusted application from the App Center.
- Create a container or VM from a template.
- Ask the AI assistant why a service is slow or why a disk reports errors.
- Review the proposed fix, affected services, risk, and rollback plan before approval.
- Restore an earlier file, snapshot, application state, or full-system backup.

## 5. Information architecture

The primary navigation should remain stable across every device:

- **Home:** system overview, alerts, recent activity, shortcuts, capacity, and health
- **Storage:** disks, pools, volumes, shares, snapshots, cache, compression, replication
- **Files:** browser, upload/download, sharing links, version history, search
- **Apps:** catalog, installed apps, permissions, updates, resource use
- **Containers:** projects, images, networks, volumes, logs, console
- **Virtual Machines:** VMs, templates, ISO library, snapshots, console, networks
- **AI Center:** providers, local models, assistants, knowledge indexes, permissions, usage
- **Users & Identity:** local accounts, groups, LDAP, directory services, SSO, MFA
- **Network:** interfaces, bridges, bonds, VLANs, firewall, DNS, VPN, certificates
- **Data Protection:** backup jobs, destinations, replication, restore, disaster recovery
- **Monitoring:** performance, events, logs, service health, reports
- **Settings:** updates, hardware, notifications, appearance, API, support bundle

Navigation must be capability-aware. For example, Virtual Machines should display a hardware-requirement explanation when VT-x/AMD-V is unavailable rather than offering controls that cannot succeed.

## 6. UX and visual direction

### Experience goals

The interface should feel calm, premium, fast, and trustworthy. It should avoid the density of a traditional server control panel while preserving deep technical visibility.

- Modern card-and-panel layout with strong spacing and restrained use of color
- Light, dark, and system themes
- Accessible color contrast, visible keyboard focus, screen-reader labels, and reduced-motion support
- Consistent status language: Healthy, Attention, Degraded, Critical, Offline
- Progressive disclosure: Overview first, details second, raw configuration last
- Command palette and global search for desktop power users
- Bottom navigation or compact drawer for mobile
- Responsive tables that become useful cards on narrow screens
- Touch-friendly controls without weakening the desktop experience
- Real-time progress for long operations, including pause/cancel where safe

### Login experience

The login screen should include the appliance name, product mark, username/passkey or SSO options, security status, language selector, and a discreet device-health indicator. It should work cleanly at phone width and never expose sensitive system details before authentication.

### Dashboard

The main dashboard should answer five questions immediately:

1. Is my data safe?
2. Is the system healthy?
3. How much capacity is available?
4. Are backups current?
5. Does anything require my attention?

Widgets should be movable and role-aware, with a sensible default layout. The dashboard must remain responsive on a 2 GB system by using compact server responses, lazy-loaded details, and efficient event updates.

## 7. Core capabilities

### Storage and file services

- Storage pools, volumes, mount points, and shared folders
- ext4 and Btrfs as practical initial filesystems; optional ZFS only on qualified higher-memory systems
- Linux software RAID and hardware-controller awareness
- Snapshots, checksums where supported, scrubbing, SMART/NVMe health, bad-sector alerts
- SMB/CIFS, NFS, SFTP, WebDAV, optional S3-compatible object access, and iSCSI on capable systems
- Per-share quotas, recycle bin, file versioning, immutable retention policies, and audit history
- Client sync and secure expiring share links
- Compression profiles selected by workload and CPU capability
- Optional SSD read/write cache with clear failure-safety requirements
- Encryption at rest and in transit, with guided key backup and recovery

Deduplication must be disabled by default and shown only when memory and workload requirements are satisfied.

### Applications and containers

- Curated App Center backed by signed OCI images
- Docker-compatible application model, preferably managed through containerd or Podman with Compose compatibility
- One-click installation with declared storage, port, network, device, and permission requirements
- Per-app CPU, memory, storage, and network controls
- Automatic configuration backup before upgrades
- Staged updates, health checks, rollback, logs, terminal, and dependency visibility
- Community repository support clearly separated from verified applications

Applications must not receive host access by default. Privileged mode, raw devices, host networking, and access to user data require clear permission prompts.

### Virtual machines

- KVM/QEMU and libvirt on supported 64-bit processors with hardware virtualization
- Guided VM creation, templates, ISO library, UEFI/BIOS selection, virtual TPM, snapshots, clones, and scheduled backup
- Browser console using noVNC or SPICE-compatible access
- Linux bridges, VLAN tagging, isolated networks, and controlled device passthrough
- Import/export for common disk formats such as qcow2, raw, VMDK, and VHDX where conversion is supported
- Resource reservations and overcommit warnings

VM features must be unavailable on hardware without required CPU virtualization capabilities.

### Identity, LDAP, and domain services

- Local users and groups
- LDAP client integration
- LDAP server as an optional application
- Join Microsoft Active Directory or compatible Samba domains
- Optional Samba Active Directory Domain Controller role on qualified systems
- SSO through OpenID Connect and SAML where applicable
- MFA, WebAuthn/passkeys, API tokens, service accounts, and role-based access control
- Identity health tests, DNS validation, time-synchronization checks, and backup requirements

Creating a domain controller must use a dedicated expert wizard. It must validate static IP addressing, DNS, NTP, hostname, realm, backup, and conflict conditions. The product must not imply that Samba AD DC is identical to every Windows Server AD DS feature.

### Networking and remote access

- DHCP or static addressing, DNS, routes, link aggregation, bridges, VLANs, MTU, and interface failover
- Host firewall with service-aware rules
- WireGuard-based remote access and optional Tailscale integration
- Reverse proxy, certificate automation, and local certificate authority options
- UPnP disabled by default
- Network diagnostics, packet capture with access control, and connectivity tests

### Backup and disaster recovery

- File, volume, app, configuration, and VM backup policies
- Local disk, remote NAS, S3-compatible object storage, and supported cloud destinations
- Encrypted, incremental, deduplicated backup repository independent of live-storage deduplication
- Snapshot replication between compatible nodes
- Configurable retention using hourly, daily, weekly, monthly, and yearly policies
- Guided bare-metal recovery image and configuration export
- Routine restore testing and alerting when backups have not been verified

## 8. AI Center

AI should be a governed system capability, not a decorative chatbot.

### AI functions

- Natural-language administration and documentation search
- Explain alerts, logs, storage health, capacity trends, and configuration
- Generate safe step-by-step plans for approved administrative tasks
- Semantic search across user-selected documents and media metadata
- File organization suggestions, duplicate detection, tagging, and summarization
- Capacity forecasting and anomaly detection
- Application discovery and setup assistance
- Optional image, audio, and video indexing on capable hardware

### Provider model

- Local models through a lightweight runtime on supported CPU/GPU/NPU hardware
- Remote models through user-configured providers
- Network AI node: use a stronger machine on the LAN while keeping the NAS lightweight
- Per-user/provider budgets, model allowlists, usage reporting, and disable controls

### AI safety model

The AI assistant receives read-only access by default. Every action is represented as a typed operation with a preview. Storage deletion, permission changes, firewall changes, application privilege changes, user removal, key rotation, updates, reboot, and shutdown require explicit confirmation. All AI-proposed and AI-executed actions are written to the audit log.

User files must never be sent to a remote AI provider unless the administrator enables the provider and the relevant user or share policy permits that data flow.

## 9. Proposed software architecture

### Operating-system foundation

- Minimal Linux LTS base with a read-only or immutable system partition
- A/B atomic operating-system updates with automatic rollback after failed health checks
- Separate persistent configuration and user-data partitions
- systemd for service supervision
- Hardware discovery during installation and every boot
- Signed update metadata, signed packages/images, and secure-boot support where practical

### Control plane

- Resource-efficient backend services written primarily in Rust or Go
- Stable versioned REST API, with event streaming for live state changes
- Central authorization service enforcing RBAC for UI, API, apps, containers, and AI operations
- Transactional job engine for long-running work with progress, cancellation, retry, and rollback metadata
- SQLite for single-node configuration where appropriate, with careful migrations and backups; avoid a heavy database requirement on low-memory systems
- Structured event and audit logs with configurable retention

### Web application

- TypeScript-based responsive progressive web application
- Component system shared across desktop, tablet, and mobile layouts
- Server-driven capability flags so the client only offers supported operations
- Lazy-loaded feature modules and virtualized large lists
- Accessible charts and status summaries
- Offline-safe handling for interrupted operations; the backend remains the source of truth

### Extensibility

- Versioned API and event/webhook framework
- Signed app manifest describing permissions, resources, architectures, health checks, backup paths, and upgrade behavior
- CLI using the same public API as the web interface
- SDK for app developers
- No application may directly modify core configuration files

## 10. Performance and resource management

The system needs a resource governor that continuously protects file service latency and administrative access.

Priority order:

1. Filesystem integrity and disk recovery
2. Authentication, networking, and file services
3. Administration interface and monitoring
4. Backup and replication
5. Applications and containers
6. Indexing and local AI workloads

On low-memory devices, services should start on demand, indexes should remain optional, telemetry should be aggregated efficiently, and background tasks should pause under memory or I/O pressure. The UI should show when work has been intentionally throttled.

Initial performance objectives:

- Login screen interactive within 3 seconds on baseline supported hardware after services are ready
- Dashboard usable within 2 seconds on a local network under normal load
- Core idle memory target below 1 GB, leaving practical headroom on a 2 GB appliance
- File services remain responsive while background jobs are throttled
- Clean recovery after power loss using journaling, transactional configuration writes, and startup health checks

These objectives must be validated on a published hardware test matrix rather than treated as marketing claims.

## 11. Security requirements

- Secure defaults and no default administrator password
- MFA/passkey setup encouraged during onboarding
- TLS for the management interface; certificate warnings explained clearly
- Least-privilege services and application sandboxing
- Signed OS updates and signed trusted applications
- Secrets stored encrypted and never returned through standard APIs
- Session management, device history, login throttling, and lockout protection
- Tamper-evident audit events and export to external syslog/SIEM
- Regular vulnerability scanning and a documented security-response policy
- Automatic security updates as the recommended setting, with maintenance windows
- Recovery key and configuration backup workflows tested during onboarding

## 12. Reliability and observability

- Unified event system for disks, pools, shares, apps, containers, VMs, backups, identity, and network
- Notifications through email, push, webhook, and optional messaging integrations
- Plain-language incident timeline with related changes and metrics
- Downloadable support bundle with automatic secret redaction
- Prometheus-compatible metrics endpoint on capable systems
- Graceful degradation when an optional service fails
- Watchdog and health-check framework with bounded automatic remediation

## 13. Delivery roadmap

### Phase 0 — Feasibility and architecture

- Choose CPU architecture floor and define the separate Legacy strategy
- Prototype boot, hardware inventory, immutable updates, API, and responsive shell
- Benchmark the core stack on 2 GB RAM
- Validate filesystem, RAID, SMB/NFS, and recovery behavior
- Threat model the platform and application permission system

### Phase 1 — Minimum lovable NAS

- Installer and onboarding
- Users, groups, shares, SMB/NFS, disk health, storage pools, snapshots, backup
- Responsive dashboard and mobile administration
- Updates, notifications, audit events, and support bundle
- Initial hardware compatibility database

### Phase 2 — Application platform

- App Center, signed manifests, containers, Compose-compatible projects
- Reverse proxy, certificates, resource limits, app backup, update, and rollback
- Developer CLI, API documentation, and SDK preview

### Phase 3 — Virtualization and advanced networking

- KVM/QEMU VMs, templates, console, virtual networks, VLANs, import/export, backup
- WireGuard remote access and advanced firewall workflows

### Phase 4 — AI and intelligent search

- Remote and network-node AI providers first
- Permissioned AI assistant, log explanation, health analysis, and action previews
- Optional local inference and semantic file indexing on qualified hardware

### Phase 5 — Directory and multi-node services

- LDAP integrations and optional LDAP server
- AD domain joining and optional Samba AD DC
- Replication, centralized management, failover research, and fleet policy

## 14. MVP boundaries

The first production release should focus on doing the following exceptionally well:

- Install safely
- Create resilient storage
- Share files securely
- Manage users and permissions
- Monitor disk and system health
- Back up and restore data
- Update without breaking the appliance
- Deliver an excellent responsive web experience on 2 GB RAM

Local generative AI, full VM management, domain-controller creation, clustering, high availability, and a broad public app marketplace should not block the first reliable NAS release.

## 15. Success measures

- Median first-time setup completed in under 15 minutes, excluding disk initialization
- At least 90% of pilot users create a protected share without documentation
- No destructive storage operation can proceed without an exact impact preview
- Core services remain available during constrained background workloads
- Successful automatic rollback from a deliberately broken update in validation tests
- Backup restore tests achieve a published success target before general release
- Accessibility meets WCAG 2.2 AA for the management interface
- Hardware compatibility and unsupported features are visible before installation whenever detection is possible

## 16. Primary risks

| Risk | Mitigation |
| --- | --- |
| Hardware range becomes untestable | Publish a compatibility matrix and use separate Legacy and current images |
| “2 GB” conflicts with AI/VM expectations | Enforce capability tiers and offer remote/network AI |
| Storage bugs cause data loss | Keep storage scope conservative, test recovery aggressively, and require impact previews |
| App ecosystem weakens security | Signed manifests, sandboxing, declared permissions, verified/community separation |
| AI makes unsafe changes | Read-only default, typed operations, previews, approval gates, and audit logs |
| Feature breadth delays a reliable release | Protect the MVP boundary and deliver advanced modules in phases |
| ZFS consumes excessive resources | Make Btrfs/ext4 the low-memory defaults and qualify ZFS by hardware tier |
| Domain services create DNS/time conflicts | Expert wizard, prerequisite validation, configuration backup, and clear compatibility limits |

## 17. Product definition statement

Lightweight AI NAS OS is a capability-aware private-cloud operating system that turns compatible old or new hardware into a simple, secure storage appliance and scales into applications, containers, virtual machines, intelligent automation, and identity services as resources permit. Its defining advantage is not merely the number of features; it is that storage, infrastructure, and AI behave as one understandable, safe, responsive experience.

