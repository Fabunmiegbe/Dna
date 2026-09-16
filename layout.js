// GeneMatch shared layout loader
// Fetches the header/footer partials, injects them, then wires up interactivity.
// Kept dependency-free on purpose: no build step, works from any static host (Vercel).

async function loadPartial(url, mountId) {
  const mount = document.getElementById(mountId);
  if (!mount) return;
  try {
    const res = await fetch(url);
    mount.innerHTML = await res.text();
  } catch (err) {
    console.error('Could not load ' + url, err);
  }
}

function initMobileMenu() {
  const toggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('mobile-menu');
  if (!toggle || !menu) return;
  toggle.addEventListener('click', () => {
    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    toggle.setAttribute('aria-expanded', String(!isOpen));
  });
}

function highlightActiveNav() {
  const current = document.body.getAttribute('data-page');
  if (!current) return;
  document.querySelectorAll('header nav a, #mobile-menu a').forEach((link) => {
    const href = link.getAttribute('href') || '';
    if (href.includes(current)) {
      link.classList.add('text-teal');
    }
  });
}

function setFooterYear() {
  const el = document.getElementById('footer-year');
  if (el) el.textContent = String(new Date().getFullYear());
}

async function initLayout() {
  await Promise.all([
    loadPartial('/partials/header.html', 'site-header'),
    loadPartial('/partials/footer.html', 'site-footer'),
  ]);
  initMobileMenu();
  highlightActiveNav();
  setFooterYear();
  document.dispatchEvent(new CustomEvent('genematch:layout-ready'));
}

document.addEventListener('DOMContentLoaded', initLayout);
