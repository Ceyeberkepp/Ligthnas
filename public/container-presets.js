const fallbackPresets = [
  { name: 'Debian 13', category: 'Linux', image: 'debian:13-slim' },
  { name: 'Ubuntu 24.04 LTS', category: 'Linux', image: 'ubuntu:24.04' },
  { name: 'Alpine Linux', category: 'Linux', image: 'alpine:latest' },
  { name: 'Nginx', category: 'Web', image: 'nginx:stable-alpine' },
  { name: 'Apache HTTP Server', category: 'Web', image: 'httpd:2.4-alpine' },
  { name: 'Redis', category: 'Database', image: 'redis:alpine' },
  { name: 'PostgreSQL 17', category: 'Database', image: 'postgres:17-alpine' },
  { name: 'MariaDB 11.4', category: 'Database', image: 'mariadb:11.4' },
  { name: 'Node.js LTS', category: 'Development', image: 'node:lts-slim' },
  { name: 'Python 3', category: 'Development', image: 'python:3-slim' },
  { name: 'BusyBox', category: 'Utility', image: 'busybox:latest' }
];

let presets = fallbackPresets;
let loadingPresets = false;

async function refreshPresets() {
  if (loadingPresets) return;
  loadingPresets = true;
  try {
    const response = await fetch('/api/containers/inventory', { headers: { 'X-LightNAS-Request': '1' } });
    if (!response.ok) return;
    const body = await response.json();
    if (Array.isArray(body?.images) && body.images.length) {
      presets = body.images.map(item => ({
        name: item.label || item.name || item.id,
        category: item.source === 'template-library' ? 'Template library' : (item.category || 'Linux'),
        image: item.id
      }));
      const form = document.querySelector('#container-form');
      if (form) {
        form.dataset.imagePicker = '';
        enhanceContainerForm();
      }
    }
  } catch {
    // Keep the built-in fallback list when runtime inventory is temporarily unavailable.
  } finally {
    loadingPresets = false;
  }
}

function addPresetOptions(select) {
  const categories = [...new Set(presets.map(item => item.category || 'Other'))];
  for (const category of categories) {
    const group = document.createElement('optgroup');
    group.label = category;
    for (const item of presets.filter(entry => (entry.category || 'Other') === category)) {
      const option = document.createElement('option');
      option.value = item.image;
      option.textContent = `${item.name} — ${item.image}`;
      group.append(option);
    }
    select.append(group);
  }
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = 'Custom system image ID…';
  select.append(custom);
}

function enhanceContainerForm() {
  const form = document.querySelector('#container-form');
  if (!form || form.dataset.imagePicker === '1') return;
  const imageInput = form.querySelector('input[name="image"]');
  if (!imageInput) return;

  form.dataset.imagePicker = '1';
  const originalLabel = imageInput.closest('label');
  if (!originalLabel) return;

  const presetLabel = document.createElement('label');
  presetLabel.textContent = 'Container image';
  const select = document.createElement('select');
  select.name = 'image';
  select.required = true;
  select.id = 'container-image-preset';
  addPresetOptions(select);
  presetLabel.append(select);

  const help = document.createElement('small');
  help.className = 'muted';
  help.textContent = 'Choose a native Linux image or downloaded template. LightNAS prepares it automatically before creating the system container.';
  presetLabel.append(help);

  const customLabel = document.createElement('label');
  customLabel.textContent = 'Custom system image ID';
  customLabel.style.display = 'none';
  const customInput = document.createElement('input');
  customInput.placeholder = 'template:debian-13';
  customInput.pattern = '[a-z0-9][a-z0-9./:_-]{0,159}';
  customLabel.append(customInput);

  originalLabel.replaceWith(presetLabel, customLabel);

  const syncCustom = () => {
    const useCustom = select.value === '__custom__';
    customLabel.style.display = useCustom ? '' : 'none';
    if (useCustom) {
      select.removeAttribute('name');
      customInput.name = 'image';
      customInput.required = true;
      customInput.focus();
    } else {
      select.name = 'image';
      customInput.removeAttribute('name');
      customInput.required = false;
      customInput.value = '';
    }
  };
  select.addEventListener('change', syncCustom);
  syncCustom();
}

const observer = new MutationObserver(() => {
  if (document.querySelector('#container-form')) enhanceContainerForm();
});

observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener('hashchange', () => {
  if (location.hash === '#containers') setTimeout(enhanceContainerForm, 0);
});

refreshPresets();
enhanceContainerForm();
