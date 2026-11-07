// Lets people arrange the tools inside each sidebar group. The order is saved on
// this computer. Drag a tool, or use right-click / Alt+↑ and Alt+↓ on a focused one.

const KEY = 'smoothyedit:nav-order';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; }
}
function save(order) {
  try { localStorage.setItem(KEY, JSON.stringify(order)); } catch { /* order just resets next launch */ }
}

const groups = () => [...document.querySelectorAll('.channel-group-items')];
const tabOf = (item) => item.dataset.tab;
const itemsOf = (container) => [...container.querySelectorAll(':scope > .nav-item[data-tab]')];

function persist() {
  const order = {};
  for (const container of groups()) order[container.id] = itemsOf(container).map(tabOf);
  save(order);
}

function applySaved() {
  const order = load();
  for (const container of groups()) {
    const wanted = order[container.id];
    if (!Array.isArray(wanted)) continue;
    const byTab = new Map(itemsOf(container).map((item) => [tabOf(item), item]));
    for (const tab of wanted) {
      const item = byTab.get(tab);
      if (item) container.append(item); // New tools not in the saved list stay at the end.
    }
    for (const item of itemsOf(container)) if (!wanted.includes(tabOf(item))) container.append(item);
  }
}

function move(item, delta) {
  const container = item.parentElement;
  const list = itemsOf(container);
  const index = list.indexOf(item);
  const target = list[index + delta];
  if (!target) return;
  if (delta < 0) container.insertBefore(item, target);
  else target.after(item);
  persist();
  item.focus();
}

function reset() {
  try { localStorage.removeItem(KEY); } catch { /* nothing saved */ }
  location.reload();
}

let menu = null;
function closeMenu() { menu?.remove(); menu = null; }

function openMenu(item, x, y) {
  closeMenu();
  menu = document.createElement('div');
  menu.className = 'nav-order-menu';
  menu.setAttribute('role', 'menu');
  const list = itemsOf(item.parentElement);
  const index = list.indexOf(item);
  const add = (label, enabled, run) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = !enabled;
    button.setAttribute('role', 'menuitem');
    button.addEventListener('click', () => { closeMenu(); run(); });
    menu.append(button);
  };
  add('Move up', index > 0, () => move(item, -1));
  add('Move down', index < list.length - 1, () => move(item, 1));
  add('Reset order', true, reset);
  document.body.append(menu);
  menu.style.left = `${Math.min(x, window.innerWidth - 160)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 130)}px`;
}

function bindDrag() {
  let dragging = null;
  const clear = () => document.querySelectorAll('.nav-item.drop-before, .nav-item.drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
  document.addEventListener('dragstart', (event) => {
    const item = event.target.closest?.('.nav-item[data-tab]');
    if (!item || !item.parentElement.matches('.channel-group-items')) return;
    dragging = item;
    item.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabOf(item));
  });
  document.addEventListener('dragover', (event) => {
    const over = event.target.closest?.('.nav-item[data-tab]');
    if (!dragging || !over || over === dragging || over.parentElement !== dragging.parentElement) return;
    event.preventDefault();
    clear();
    const rect = over.getBoundingClientRect();
    over.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
  });
  document.addEventListener('drop', (event) => {
    const over = event.target.closest?.('.nav-item[data-tab]');
    if (!dragging || !over || over === dragging || over.parentElement !== dragging.parentElement) return;
    event.preventDefault();
    const before = over.classList.contains('drop-before');
    if (before) over.parentElement.insertBefore(dragging, over);
    else over.after(dragging);
    persist();
  });
  document.addEventListener('dragend', () => { dragging?.classList.remove('is-dragging'); dragging = null; clear(); });
}

function init() {
  applySaved();
  for (const container of groups()) {
    for (const item of itemsOf(container)) {
      item.draggable = true;
      // Collapsed sidebar shows icons only, so every tool keeps a readable tooltip.
      const label = item.querySelector('.nav-label')?.textContent?.trim();
      if (label && !item.title) item.title = label;
    }
  }
  bindDrag();
  document.addEventListener('contextmenu', (event) => {
    const item = event.target.closest?.('.nav-item[data-tab]');
    if (!item || !item.parentElement.matches('.channel-group-items')) return;
    event.preventDefault();
    openMenu(item, event.clientX, event.clientY);
  });
  document.addEventListener('click', closeMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
    const item = event.target.closest?.('.nav-item[data-tab]');
    if (item && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      move(item, event.key === 'ArrowUp' ? -1 : 1);
    }
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
