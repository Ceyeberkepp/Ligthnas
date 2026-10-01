# KB-001 — Install or update LightVisor

## Applies to

Dedicated LightNAS Hypervisor edition / LightVisor.

## Install

Run as root on Debian/Ubuntu:

```bash
curl -fsSL https://raw.githubusercontent.com/Ceyeberkepp/Ligthnas/main/install-hypervisor.sh | bash
```

The installer sets `LIGHTNAS_PRODUCT_MODE=hypervisor`, writes the product-mode environment configuration, and restarts `lightnas.service`.

## Verify product mode

```bash
cat /etc/lightnas/product-mode.env
systemctl cat lightnas | sed -n '/product-mode/,+8p'
```

Expected mode:

```text
LIGHTNAS_PRODUCT_MODE=hypervisor
```

## Update an existing Git installation

```bash
cd /opt/lightnas
git pull
systemctl restart lightnas-host-agent
systemctl restart lightnas
```

Verify:

```bash
systemctl is-active lightnas
systemctl is-active lightnas-host-agent
git log -3 --oneline
```

Hard-refresh the browser after an update.

## If the UI still shows old code

See [KB-007](KB-007-ui-refresh.md).
