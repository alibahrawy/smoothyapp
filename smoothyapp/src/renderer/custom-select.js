// Smoothy's own dropdown menu for every <select> in the app.
//
// The native <select> stays the source of truth (value, change events, forms,
// disabled state). We only stop the macOS popup from opening and show our own
// menu in its place, so existing code and dynamically created selects work
// without changes. Opt out with `data-native-select` on a select.
//
// Options can show an icon copied from the page with
// `data-menu-icon-from="<css selector>"` (an <img> or <svg>).
// A select can anchor its menu to another element with `data-menu-anchor="#id"`.

const OPEN_KEYS = new Set([' ', 'Enter', 'ArrowDown', 'ArrowUp']);
const CHECK_SVG = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let current = null; // { select, menu, items, active, typed, typedAt }

function eligible(select) {
  return select instanceof HTMLSelectElement
    && !select.multiple
    && (select.size || 0) <= 1
    && !select.disabled
    && !select.hasAttribute('data-native-select');
}

function isHidden(option) {
  return option.hidden || option.style.display === 'none';
}

function anchorFor(select) {
  const selector = select.dataset.menuAnchor;
  const anchor = selector ? document.querySelector(selector) : null;
  return anchor || select;
}

function iconFor(option) {
  // Reuse an icon that is already on the page, e.g. the editor logos on the switcher.
  const source = option.dataset.menuIconFrom ? document.querySelector(option.dataset.menuIconFrom) : null;
  if (!source) return null;
  const icon = source.cloneNode(true);
  icon.removeAttribute('id');
  icon.removeAttribute('width');
  icon.removeAttribute('height');
  icon.classList.add('smoothy-menu-icon');
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function buildItem(option, select) {
  const item = document.createElement('div');
  item.className = 'smoothy-menu-item';
  item.setAttribute('role', 'option');
  item.id = `smoothy-menu-item-${option.index}`;
  item.dataset.index = String(option.index);
  const selected = option.index === select.selectedIndex;
  item.setAttribute('aria-selected', String(selected));
  if (selected) item.classList.add('is-selected');
  const disabled = option.disabled || option.parentElement?.disabled;
  if (disabled) {
    item.classList.add('is-disabled');
    item.setAttribute('aria-disabled', 'true');
  }
  const check = document.createElement('span');
  check.className = 'smoothy-menu-check';
  check.innerHTML = CHECK_SVG;
  item.append(check);
  const icon = iconFor(option);
  if (icon) item.append(icon);
  const label = document.createElement('span');
  label.className = 'smoothy-menu-label';
  label.textContent = option.label || option.textContent || '';
  item.append(label);
  return item;
}

function buildMenu(select) {
  const menu = document.createElement('div');
  menu.className = 'smoothy-menu';
  menu.setAttribute('role', 'listbox');
  menu.tabIndex = -1;
  const name = select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim();
  if (name) menu.setAttribute('aria-label', name);
  const items = [];
  const addOption = (option, parent) => {
    if (isHidden(option)) return;
    const item = buildItem(option, select);
    parent.append(item);
    items.push(item);
  };
  for (const child of select.children) {
    if (child instanceof HTMLOptGroupElement) {
      if (child.hidden) continue;
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      const heading = document.createElement('div');
      heading.className = 'smoothy-menu-group';
      heading.textContent = child.label;
      group.append(heading);
      for (const option of child.children) if (option instanceof HTMLOptionElement) addOption(option, group);
      if (group.children.length > 1) menu.append(group);
    } else if (child instanceof HTMLOptionElement) {
      addOption(child, menu);
    } else if (child instanceof HTMLHRElement) {
      const rule = document.createElement('div');
      rule.className = 'smoothy-menu-separator';
      menu.append(rule);
    }
  }
  return { menu, items };
}

function position(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const gap = 4;
  const edge = 8;
  const width = Math.min(Math.max(rect.width, 160), window.innerWidth - edge * 2);
  menu.style.minWidth = `${width}px`;
  menu.style.maxWidth = `${Math.max(width, Math.min(420, window.innerWidth - edge * 2))}px`;
  menu.style.maxHeight = '';
  const natural = menu.scrollHeight;
  const below = window.innerHeight - rect.bottom - gap - edge;
  const above = rect.top - gap - edge;
  const placeAbove = natural > below && above > below;
  const room = Math.max(120, placeAbove ? above : below);
  menu.style.maxHeight = `${room}px`;
  const height = Math.min(natural, room);
  const top = placeAbove ? rect.top - gap - height : rect.bottom + gap;
  const menuWidth = menu.offsetWidth;
  const left = Math.min(Math.max(edge, rect.left), window.innerWidth - edge - menuWidth);
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
  menu.dataset.side = placeAbove ? 'top' : 'bottom';
}

function enabledItems() {
  return current ? current.items.filter((item) => !item.classList.contains('is-disabled')) : [];
}

function setActive(item, scroll = true) {
  if (!current) return;
  current.active?.classList.remove('is-active');
  current.active = item || null;
  if (!item) {
    current.menu.removeAttribute('aria-activedescendant');
    return;
  }
  item.classList.add('is-active');
  current.menu.setAttribute('aria-activedescendant', item.id);
  if (scroll) item.scrollIntoView({ block: 'nearest' });
}

function move(step) {
  const list = enabledItems();
  if (!list.length) return;
  const index = list.indexOf(current.active);
  const next = index === -1 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + step));
  setActive(list[next]);
}

function choose(item) {
  if (!current || !item || item.classList.contains('is-disabled')) return;
  const { select } = current;
  const index = Number(item.dataset.index);
  close(true);
  if (!select.isConnected || select.disabled || index === select.selectedIndex) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function typeAhead(key) {
  const now = Date.now();
  current.typed = now - (current.typedAt || 0) > 700 ? key : current.typed + key;
  current.typedAt = now;
  const text = current.typed.toLowerCase();
  const list = enabledItems();
  const start = Math.max(0, list.indexOf(current.active));
  const ordered = [...list.slice(start + (current.typed.length === 1 ? 1 : 0)), ...list.slice(0, start + 1)];
  const match = ordered.find((item) => item.textContent.trim().toLowerCase().startsWith(text));
  if (match) setActive(match);
}

function onMenuKey(event) {
  if (!current) return;
  switch (event.key) {
    case 'ArrowDown': event.preventDefault(); move(1); break;
    case 'ArrowUp': event.preventDefault(); move(-1); break;
    case 'Home': event.preventDefault(); setActive(enabledItems()[0]); break;
    case 'End': event.preventDefault(); setActive(enabledItems().at(-1)); break;
    case 'PageDown': event.preventDefault(); move(8); break;
    case 'PageUp': event.preventDefault(); move(-8); break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (event.key === ' ' && current.typed && Date.now() - current.typedAt < 700) { typeAhead(' '); break; }
      choose(current.active);
      break;
    case 'Escape': event.preventDefault(); event.stopPropagation(); close(true); break;
    case 'Tab': close(true); break;
    default:
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        typeAhead(event.key);
      }
  }
}

function onOutsidePointer(event) {
  if (!current) return;
  if (current.menu.contains(event.target)) return;
  if (event.target === current.select) return; // the select's own handler toggles
  close(false);
}

function onScroll(event) {
  if (current && !current.menu.contains(event.target)) close(false);
}

function onViewportChange() {
  close(false);
}

function close(refocus) {
  if (!current) return;
  const { select, menu } = current;
  current = null;
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  document.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('blur', onViewportChange);
  select.removeAttribute('aria-expanded');
  select.closest('.editor-switcher')?.classList.remove('menu-open');
  try { menu.hidePopover?.(); } catch { /* already closed */ }
  menu.remove();
  if (refocus && select.isConnected) select.focus({ preventScroll: true });
}

function open(select) {
  close(false);
  const { menu, items } = buildMenu(select);
  if (!items.length) return;
  if ('popover' in menu) menu.popover = 'manual';
  document.body.append(menu);
  if (menu.showPopover) menu.showPopover();
  current = { select, menu, items, active: null, typed: '', typedAt: 0 };
  position(menu, anchorFor(select));
  const selected = items.find((item) => item.classList.contains('is-selected') && !item.classList.contains('is-disabled'));
  setActive(selected || enabledItems()[0], true);
  select.setAttribute('aria-expanded', 'true');
  select.closest('.editor-switcher')?.classList.add('menu-open');

  menu.addEventListener('keydown', onMenuKey);
  menu.addEventListener('pointermove', (event) => {
    const item = event.target.closest?.('.smoothy-menu-item');
    if (item && item !== current?.active && !item.classList.contains('is-disabled')) setActive(item, false);
  });
  menu.addEventListener('click', (event) => choose(event.target.closest?.('.smoothy-menu-item')));
  menu.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('pointerdown', onOutsidePointer, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('blur', onViewportChange);
  menu.focus({ preventScroll: true });
}

function selectFrom(event) {
  const target = event.target;
  return target instanceof HTMLSelectElement ? target : null;
}

document.addEventListener('mousedown', (event) => {
  const select = selectFrom(event);
  if (!select || event.button !== 0 || !eligible(select)) return;
  event.preventDefault(); // stops the native macOS menu
  if (current?.select === select) { close(true); return; }
  select.focus({ preventScroll: true });
  open(select);
}, true);

document.addEventListener('keydown', (event) => {
  const select = selectFrom(event);
  if (!select || !eligible(select) || current) return;
  if (!OPEN_KEYS.has(event.key) || event.metaKey || event.ctrlKey) return;
  event.preventDefault();
  open(select);
}, true);

export { open as openSelectMenu, close as closeSelectMenu };
